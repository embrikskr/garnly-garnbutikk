/**
 * order-intake: Shopify webhook `orders/paid`.
 *   1. Verifiser HMAC, idempotens på webhook-id.
 *   2. Hent ordre med fulfillment orders (Shopify kan ha delt den i flere), sett HOLD på alle.
 *   3. Map varelinjer → Garnly-produkter (via variant_id).
 *   4. Planlegg grupper per fulfillment order (én butikk hvis mulig, ellers splitt per linje).
 *   5. Splitt fulfillment order i Shopify hvis flere grupper.
 *   6. Opprett routing_order/groups/offers og send første tilbud per gruppe.
 *
 * Kan også kalles internt med { "order_id": "gid://shopify/Order/…" } + x-cron-secret (re-kjøring),
 * eller { "order_id", "fulfillment_order_ids": [...] } for deler av en rutet ordre som ble glemt.
 */
import { adminClient, audit, json } from "../_shared/db.ts";
import { getOrder, holdFulfillmentOrder, splitHeldFulfillmentOrder, verifyShopifyHmac } from "../_shared/shopify.ts";
import { planGroups, routingCountry } from "../_shared/routing.ts";
import { erTestordre } from "../_shared/testorder.ts";
import { escalateGroup, makeNextOffer, refreshOrderStatus } from "../_shared/offers.ts";
import type { LineItem } from "../_shared/types.ts";
import { byggLinje } from "../_shared/lines.ts";

Deno.serve(async (req) => {
  const raw = await req.text();
  const internal = req.headers.get("x-cron-secret") === Deno.env.get("CRON_SECRET");
  let orderGid: string;

  let bareFo: string[] | undefined;
  if (internal) {
    const body = JSON.parse(raw);
    orderGid = body.order_id;
    // Etterslep: delene av en ordre som alt er rutet, men som aldri ble fanget opp.
    if (Array.isArray(body.fulfillment_order_ids)) bareFo = body.fulfillment_order_ids;
  } else {
    if (!(await verifyShopifyHmac(raw, req.headers.get("x-shopify-hmac-sha256")))) return json({ error: "invalid hmac" }, 401);
    const webhookId = req.headers.get("x-shopify-webhook-id") ?? crypto.randomUUID();
    const topic = req.headers.get("x-shopify-topic") ?? "orders/paid";
    const { error } = await adminClient().from("shopify_webhook_events").insert({ id: webhookId, topic });
    if (error?.code === "23505") return json({ ok: true, duplicate: true });
    const payload = JSON.parse(raw);
    orderGid = payload.admin_graphql_api_id ?? `gid://shopify/Order/${payload.id}`;
  }

  // Svar Shopify raskt; gjør jobben i bakgrunnen (Shopify krever svar < 5 s)
  const work = processOrder(orderGid, bareFo).catch((e) => console.error("order-intake feilet:", e));
  // @ts-ignore EdgeRuntime finnes i Supabase Edge Functions
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work); else await work;
  return json({ ok: true });
});

type ShopifyOrderT = Awaited<ReturnType<typeof getOrder>>;
type FoT = ShopifyOrderT["fulfillmentOrders"]["nodes"][number];
const AAPNE = ["OPEN", "IN_PROGRESS", "ON_HOLD", "SCHEDULED"];

/**
 * Shopify deler selv ordren i flere fulfillment orders i kassen når ingen lokasjon har alt
 * (#1057, #1058, 20.–21.11.2026). Før rutet vi bare den første; resten ble liggende uten hold,
 * uten tilbud og uten at butikken visste om den. Nå rutes hver del for seg, med de vanlige
 * reglene: hele delen til én butikk hvis mulig. Kunden har betalt frakt per del.
 *
 * `bareFo`: internt etterslep for en ordre som alt er rutet – rut bare disse fulfillment
 * orderne, og bare hvis ingen gruppe peker på dem fra før.
 */
async function processOrder(orderGid: string, bareFo?: string[]) {
  const db = adminClient();
  const { data: existing } = await db.from("routing_orders").select("id, status").eq("shopify_order_id", orderGid).maybeSingle();
  if (existing && !bareFo?.length) { console.log("Ordre allerede rutet:", orderGid, existing.status); return; }
  if (!existing && bareFo?.length) { console.log("Etterslep for ukjent ordre, hopper over:", orderGid); return; }

  const order = await getOrder(orderGid);
  let fos = order.fulfillmentOrders.nodes.filter((fo) => AAPNE.includes(fo.status));
  if (bareFo?.length) {
    const { data: brukt } = await db.from("routing_groups").select("shopify_fulfillment_order_id").in("shopify_fulfillment_order_id", bareFo);
    const opptatt = new Set((brukt ?? []).map((r: { shopify_fulfillment_order_id: string }) => r.shopify_fulfillment_order_id));
    fos = fos.filter((fo) => bareFo.includes(fo.id) && !opptatt.has(fo.id));
  }
  if (fos.length === 0) { console.log("Ingen åpne fulfillment orders å rute:", order.name); return; }

  // Varelinjer → Garnly-produkter, for alle delene på én gang
  const variantIds = fos.flatMap((fo) => fo.lineItems.nodes.map((n) => n.lineItem.variant?.id)).filter(Boolean) as string[];
  const { data: products } = await db.from("products").select("id, shopify_variant_id").in("shopify_variant_id", variantIds);
  const byVariant = new Map((products ?? []).map((p: any) => [p.shopify_variant_id, p.id]));

  const deler = fos.map((fo) => ({ fo, ...lesLinjer(fo, byVariant) }))
    // Bare gavekort: ingenting å rute, og ingen grunn til å holde delen. Shopify
    // leverer gavekortet selv. Holdes den, blir den liggende og venter på oss for alltid.
    .filter((d) => !(d.lines.length === 0 && d.unknown.length === 0 && d.gavekort > 0));
  if (deler.length === 0) {
    console.log(`[order-intake] ${order.name}: bare gavekort, hopper over`);
    return;
  }

  // Først nå vet vi at delene skal rutes eller eskaleres. Da er holdet riktig.
  for (const d of deler) await holdFulfillmentOrder(d.fo.id, "Garnly ordreruting pågår");

  let ro = existing as { id: string } | null;
  if (!ro) {
    const { data } = await db.from("routing_orders").insert({
      shopify_order_id: order.id,
      shopify_order_name: order.name,
      shopify_fulfillment_order_id: deler[0].fo.id,
      customer: { email: order.email, ...(order.shippingAddress ?? {}) },
      currency: order.currencyCode,
      // Testordrer rutes og pakkes som ekte, men holdes utenfor oppgjør og panelstatistikk.
      is_test: erTestordre(order.tags, order.test),
      total_inc_vat: Number(order.currentTotalPriceSet?.shopMoney?.amount ?? 0),
      shipping_inc_vat: Number(order.totalShippingPriceSet?.shopMoney?.amount ?? 0),
      vat_amount: Number(order.currentTotalTaxSet?.shopMoney?.amount ?? 0),
      raw_order: order,
    }).select().single();
    ro = data;
  }
  // Hvilken location Shopify tildelte delene av seg selv. Den betyr ingenting for rutingen –
  // offer-respond flytter alltid fulfillment orderen til butikkens egen location ved aksept –
  // men den er verdt å ha i loggen. «Studio Ull AS (Oslo)» er Halvors Cargonizer-avsender og
  // ikke en butikk, og den står med 0 på lager; blir den tildelt ofte, vil vi vite det.
  await audit("routing_order", ro!.id, existing ? "late_parts_routed" : "created", {
    order: order.name,
    lines: deler.reduce((n, d) => n + d.lines.length, 0),
    unknown: deler.flatMap((d) => d.unknown),
    gavekort: deler.reduce((n, d) => n + d.gavekort, 0),
    shopify_location: deler[0].fo.assignedLocation?.location?.id ?? null,
    deler: deler.length,
    lokasjoner: deler.map((d) => d.fo.assignedLocation?.location?.id ?? null),
  });

  // Dekning og fordelingsrekkefølge, bare blant butikker i leveringslandet: Garnly sender aldri
  // over tollgrensen (byggeplan §15b). Landet står også på routing_orders.ship_country (039).
  const land = routingCountry(order.shippingAddress?.countryCodeV2);
  const { data: maks } = await db.from("routing_groups").select("group_no").eq("routing_order_id", ro!.id)
    .order("group_no", { ascending: false }).limit(1).maybeSingle();
  let nesteNr = (maks?.group_no ?? 0) + 1;
  for (const d of deler) {
    nesteNr = await rutDel(db, order.name, ro!.id, d.fo, d.lines, d.unknown, land, nesteNr);
  }
  // En ordre som sto som tildelt, har nå en del som rutes: statusen skal si det.
  if (existing) await refreshOrderStatus(ro!.id);
}

/** Varelinjene i én fulfillment order, koblet til Garnly-produkter. */
function lesLinjer(fo: FoT, byVariant: Map<string, string>) {
  const lines: LineItem[] = [];
  const unknown: string[] = [];
  let gavekort = 0;
  for (const n of fo.lineItems.nodes) {
    // Gavekort har ingen butikk å rutes til og finnes ikke i products. Uten dette
    // havnet de i `unknown`, og en ren gavekortordre eskalerte til manuell håndtering.
    if (n.lineItem.variant?.product?.isGiftCard) { gavekort++; continue; }
    const vid = n.lineItem.variant?.id;
    const pid = vid ? byVariant.get(vid) : undefined;
    if (!pid) { unknown.push(n.lineItem.title); continue; }
    // Beløpet på Shopify-linja gjelder hele linja. Vi ruter ofte bare en del av den
    // (remainingQuantity), så andelen regnes ut fra antallet vi faktisk ruter.
    const helLinje = Number(n.lineItem.discountedTotalSet?.shopMoney?.amount ?? 0);
    const helMva = (n.lineItem.taxLines ?? []).reduce((sum, t) => sum + Number(t.priceSet?.shopMoney?.amount ?? 0), 0);
    const andel = n.lineItem.quantity > 0 ? n.remainingQuantity / n.lineItem.quantity : 0;
    // Varianttittel, SKU, strekkode, bilde og garnpakkeinnhold følger med – butikken skal
    // vite hva de plukker uten å slå det opp. Se _shared/lines.ts.
    lines.push(byggLinje(
      n,
      pid,
      Math.round(helLinje * andel * 100) / 100,
      Math.round(helMva * andel * 100) / 100,
    ));
  }
  return { lines, unknown, gavekort };
}

/**
 * Ruter én fulfillment order: én butikk som har hele delen hvis mulig, ellers splitt per linje.
 * Returnerer neste ledige gruppenummer.
 */
async function rutDel(
  db: ReturnType<typeof adminClient>,
  orderName: string,
  roId: string,
  fo: FoT,
  lines: LineItem[],
  unknown: string[],
  land: string,
  forsteNr: number,
): Promise<number> {
  if (unknown.length || lines.length === 0) {
    const { data: g } = await db.from("routing_groups").insert({ routing_order_id: roId, group_no: forsteNr, line_items: lines, shopify_fulfillment_order_id: fo.id, status: "escalated" }).select().single();
    await escalateGroup({ ...g, routing_orders: { shopify_order_name: orderName } }, `Varelinjer uten Garnly-produkt: ${unknown.join(", ") || "(ingen linjer)"}`);
    return forsteNr + 1;
  }

  const { data: cov } = await db.rpc("store_coverage", { p_line_items: lines, p_country: land });
  const { data: order_ } = await db.from("stores").select("id").eq("active", true).eq("country", land)
    .order("last_assigned_at", { ascending: true, nullsFirst: true }).order("created_at", { ascending: true });
  // NB: timeout-nedvekting håndteres i qualified_stores ved selve tilbudet; her trengs bare grov rekkefølge
  const { groups, uncovered } = planGroups(lines, cov ?? [], (order_ ?? []).map((s: any) => s.id));

  // Shopify: splitt fulfillment order hvis flere grupper. Første gruppe beholder original FO.
  let remainingFoId = fo.id;
  const groupFoIds: string[] = [];
  for (let i = 0; i < groups.length; i++) {
    const isLast = i === groups.length - 1 && uncovered.length === 0;
    if (i === 0 && groups.length === 1 && uncovered.length === 0) { groupFoIds.push(fo.id); break; }
    if (isLast) { groupFoIds.push(remainingFoId); break; }
    const { newId, remainingId } = await splitHeldFulfillmentOrder(remainingFoId, groups[i].line_items.map((l) => ({ id: l.line_item_id, quantity: l.qty })));
    groupFoIds.push(newId);
    remainingFoId = remainingId ?? remainingFoId;
  }

  let nr = forsteNr;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const { data: row } = await db.from("routing_groups").insert({
      routing_order_id: roId, group_no: nr++, line_items: g.line_items, shopify_fulfillment_order_id: groupFoIds[i],
      gross_inc_vat: sumBelop(g.line_items, "amount_inc_vat"),
      vat_amount: sumBelop(g.line_items, "vat_amount"),
    }).select().single();
    await db.from("offers").insert(g.candidates.map((storeId, idx) => ({ routing_group_id: row.id, store_id: storeId, sequence_no: idx + 1, status: "pending" })));
    await audit("routing_group", row.id, "planned", { candidates: g.candidates, lines: g.line_items.length, split: groups.length > 1, fulfillment_order: groupFoIds[i] });
    await makeNextOffer(row.id);
  }

  if (uncovered.length) {
    const { data: row } = await db.from("routing_groups").insert({
      routing_order_id: roId, group_no: nr++, line_items: uncovered, shopify_fulfillment_order_id: remainingFoId, status: "escalated",
      gross_inc_vat: sumBelop(uncovered, "amount_inc_vat"),
      vat_amount: sumBelop(uncovered, "vat_amount"),
    }).select().single();
    await escalateGroup({ ...row, routing_orders: { shopify_order_name: orderName } }, `Ingen butikk i ${land} har hele antallet av disse linjene`);
  }
  return nr;
}

/** Summerer et beløpsfelt over varelinjene i en gruppe. Grunnlaget for oppgjøret. */
function sumBelop(items: LineItem[], felt: "amount_inc_vat" | "vat_amount"): number {
  return Math.round(items.reduce((sum, i) => sum + (i[felt] ?? 0), 0) * 100) / 100;
}
