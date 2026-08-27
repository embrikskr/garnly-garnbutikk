/**
 * order-intake: Shopify webhook `orders/paid`.
 *   1. Verifiser HMAC, idempotens på webhook-id.
 *   2. Hent ordre med fulfillment orders, sett HOLD.
 *   3. Map varelinjer → Garnly-produkter (via variant_id).
 *   4. Planlegg grupper (én butikk hvis mulig, ellers splitt per linje).
 *   5. Splitt fulfillment order i Shopify hvis flere grupper.
 *   6. Opprett routing_order/groups/offers og send første tilbud per gruppe.
 *
 * Kan også kalles internt med { "order_id": "gid://shopify/Order/…" } + x-cron-secret (re-kjøring).
 */
import { adminClient, audit, json } from "../_shared/db.ts";
import { getOrder, holdFulfillmentOrder, splitFulfillmentOrder, verifyShopifyHmac } from "../_shared/shopify.ts";
import { planGroups } from "../_shared/routing.ts";
import { escalateGroup, makeNextOffer } from "../_shared/offers.ts";
import type { LineItem } from "../_shared/types.ts";

Deno.serve(async (req) => {
  const raw = await req.text();
  const internal = req.headers.get("x-cron-secret") === Deno.env.get("CRON_SECRET");
  let orderGid: string;

  if (internal) {
    orderGid = JSON.parse(raw).order_id;
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
  const work = processOrder(orderGid).catch((e) => console.error("order-intake feilet:", e));
  // @ts-ignore EdgeRuntime finnes i Supabase Edge Functions
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work); else await work;
  return json({ ok: true });
});

async function processOrder(orderGid: string) {
  const db = adminClient();
  const { data: existing } = await db.from("routing_orders").select("id, status").eq("shopify_order_id", orderGid).maybeSingle();
  if (existing) { console.log("Ordre allerede rutet:", orderGid, existing.status); return; }

  const order = await getOrder(orderGid);
  const fos = order.fulfillmentOrders.nodes.filter((fo) => ["OPEN", "IN_PROGRESS", "ON_HOLD", "SCHEDULED"].includes(fo.status));
  if (fos.length === 0) { console.log("Ingen åpne fulfillment orders:", order.name); return; }
  const fo = fos[0];
  await holdFulfillmentOrder(fo.id, "Garnly ordreruting pågår");

  // Varelinjer → Garnly-produkter
  const variantIds = fo.lineItems.nodes.map((n) => n.lineItem.variant?.id).filter(Boolean) as string[];
  const { data: products } = await db.from("products").select("id, shopify_variant_id").in("shopify_variant_id", variantIds);
  const byVariant = new Map((products ?? []).map((p: any) => [p.shopify_variant_id, p.id]));

  const lines: LineItem[] = [];
  const unknown: string[] = [];
  for (const n of fo.lineItems.nodes) {
    const vid = n.lineItem.variant?.id;
    const pid = vid ? byVariant.get(vid) : undefined;
    if (!pid) { unknown.push(n.lineItem.title); continue; }
    lines.push({ line_item_id: n.id, variant_id: vid!, product_id: pid, qty: n.remainingQuantity, title: n.lineItem.title });
  }

  const { data: ro } = await db.from("routing_orders").insert({
    shopify_order_id: order.id,
    shopify_order_name: order.name,
    shopify_fulfillment_order_id: fo.id,
    customer: { email: order.email, ...(order.shippingAddress ?? {}) },
    raw_order: order,
  }).select().single();
  await audit("routing_order", ro.id, "created", { order: order.name, lines: lines.length, unknown });

  if (unknown.length || lines.length === 0) {
    const { data: g } = await db.from("routing_groups").insert({ routing_order_id: ro.id, group_no: 1, line_items: lines, shopify_fulfillment_order_id: fo.id, status: "escalated" }).select().single();
    await escalateGroup({ ...g, routing_orders: { shopify_order_name: order.name } }, `Varelinjer uten Garnly-produkt: ${unknown.join(", ") || "(ingen linjer)"}`);
    return;
  }

  // Dekning og fordelingsrekkefølge
  const { data: cov } = await db.rpc("store_coverage", { p_line_items: lines });
  const { data: order_ } = await db.from("stores").select("id").eq("active", true)
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
    const { newId, remainingId } = await splitFulfillmentOrder(remainingFoId, groups[i].line_items.map((l) => ({ id: l.line_item_id, quantity: l.qty })));
    groupFoIds.push(newId);
    remainingFoId = remainingId ?? remainingFoId;
    await holdFulfillmentOrder(newId, "Garnly ordreruting pågår");
  }

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const { data: row } = await db.from("routing_groups").insert({
      routing_order_id: ro.id, group_no: i + 1, line_items: g.line_items, shopify_fulfillment_order_id: groupFoIds[i],
    }).select().single();
    await db.from("offers").insert(g.candidates.map((storeId, idx) => ({ routing_group_id: row.id, store_id: storeId, sequence_no: idx + 1, status: "pending" })));
    await audit("routing_group", row.id, "planned", { candidates: g.candidates, lines: g.line_items.length, split: groups.length > 1 });
    await makeNextOffer(row.id);
  }

  if (uncovered.length) {
    const { data: row } = await db.from("routing_groups").insert({
      routing_order_id: ro.id, group_no: groups.length + 1, line_items: uncovered, shopify_fulfillment_order_id: remainingFoId, status: "escalated",
    }).select().single();
    await escalateGroup({ ...row, routing_orders: { shopify_order_name: order.name } }, "Ingen butikk har hele antallet av disse linjene");
  }
}
