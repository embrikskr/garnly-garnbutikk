/**
 * Ordren i partnerbutikkens egen Shopify (byggeplan §15b, først KreStoffer i Odense).
 *
 * Partnerbutikken er selger. Når butikken godtar i panelet, lages ordren i deres Shopify med
 * kunden som kunde, leveringsadressen, varene og frakten, og som betalt: pengene tok Garnly imot
 * på butikkens vegne. Butikkens Shopify sender ordrebekreftelsen, som er kundens kvittering fra
 * selgeren (Halvor 18.11.2026: «vilkårene og kvitteringen» avgjør hvem som er selger). Lageret
 * trekkes der, og butikken sender med sitt eget fraktoppsett.
 *
 * Når butikken har sendt, henter vi sporingen derfra og fullfører fulfillment orderen i Garnlys
 * Shopify, så kunden får sporingen fra Garnly som ellers (hentPartnerSporing, backstop i
 * timeout-sweeper hvert kvarter).
 *
 * Kassauttrekket er gjort i det ordren lages: butikkens Shopify trekker lageret selv, og
 * `pos_deducted_at` settes med en gang (se inventory.ts – «slått ut, ikke sendt» legger varene
 * tilbake mens Garnlys Shopify holder dem som committed, så de ikke trekkes to ganger).
 *
 * Feltene i orderCreate er sjekket mot Admin API 2026-10 (18.11.2026).
 */
import { adminClient, audit } from "./db.ts";
import { partnerGql } from "./partner_shop.ts";
import { createFulfillment, getFulfillmentOrder, gql, releaseHold } from "./shopify.ts";
import { normalizeEan } from "./adapters/types.ts";
import type { LineItem, StoreRow } from "./types.ts";

// ---------------------------------------------------------------------------
// Ren logikk
// ---------------------------------------------------------------------------

export interface Kunde {
  email?: string | null;
  name?: string | null;
  address1?: string | null;
  address2?: string | null;
  zip?: string | null;
  city?: string | null;
  countryCodeV2?: string | null;
  phone?: string | null;
}

/** «Anne Marie Hansen» → fornavn «Anne Marie», etternavn «Hansen». Ett ord blir etternavn. REN logikk. */
export function delNavn(navn: string | null | undefined): { firstName: string | null; lastName: string | null } {
  const ord = (navn ?? "").trim().split(/\s+/).filter(Boolean);
  if (!ord.length) return { firstName: null, lastName: null };
  if (ord.length === 1) return { firstName: null, lastName: ord[0] };
  return { firstName: ord.slice(0, -1).join(" "), lastName: ord[ord.length - 1] };
}

const øre = (x: number) => Math.round(x * 100) / 100;

/**
 * Prisen per stk kunden betalte, i kundens valuta. Shopify gir totalen for hele linja etter
 * rabatt; vi ruter av og til bare en del av linja, så prisen regnes per stk. REN logikk.
 */
export function enhetspris(linjeTotal: number, antallPaLinja: number): number {
  return antallPaLinja > 0 ? øre(linjeTotal / antallPaLinja) : 0;
}

export interface Partnerlinje {
  partnerVariantId: string;
  qty: number;
  unitPrice: number;
  title: string;
}

export interface PartnerordreGrunnlag {
  groupId: string;
  orderName: string;
  kunde: Kunde;
  /** Valutaen kunden betalte i (presentment), f.eks. DKK. Partnerbutikkens egen valuta. */
  currency: string;
  linjer: Partnerlinje[];
  /** Frakten kunden betalte, eller null når den hører til en annen gruppe av ordren. */
  frakt: number | null;
  test: boolean;
  /** Butikkens Shopify sender ordrebekreftelsen til kunden. Av for testordrer. */
  sendKvittering: boolean;
}

/** Merket som finner igjen ordren i butikkens Shopify, så den aldri lages to ganger. */
export function partnerTag(groupId: string): string {
  return `garnly-${groupId}`;
}

/** Variablene til orderCreate. REN logikk. */
export function byggPartnerordre(g: PartnerordreGrunnlag) {
  const navn = delNavn(g.kunde.name);
  const land = (g.kunde.countryCodeV2 ?? "").trim().toUpperCase() || null;
  const adresse = {
    firstName: navn.firstName,
    lastName: navn.lastName,
    address1: g.kunde.address1 ?? null,
    address2: g.kunde.address2 || null,
    zip: g.kunde.zip ?? null,
    city: g.kunde.city ?? null,
    countryCode: land,
    phone: g.kunde.phone || null,
  };
  const penger = (amount: number) => ({ shopMoney: { amount: øre(amount).toFixed(2), currencyCode: g.currency } });
  const varer = g.linjer.reduce((s, l) => s + l.unitPrice * l.qty, 0);
  const total = øre(varer + (g.frakt ?? 0));
  const order: Record<string, unknown> = {
    currency: g.currency,
    email: g.kunde.email || null,
    phone: g.kunde.phone || null,
    customer: { toUpsert: { email: g.kunde.email || null, firstName: navn.firstName, lastName: navn.lastName } },
    shippingAddress: adresse,
    billingAddress: adresse,
    lineItems: g.linjer.map((l) => ({ variantId: l.partnerVariantId, quantity: l.qty, priceSet: penger(l.unitPrice) })),
    shippingLines: g.frakt != null ? [{ title: "Fragt (Garnly)", priceSet: penger(g.frakt) }] : [],
    taxesIncluded: true,
    financialStatus: "PAID",
    transactions: [{ kind: "SALE", status: "SUCCESS", gateway: "Garnly", amountSet: penger(total), test: g.test }],
    tags: ["Garnly", partnerTag(g.groupId), ...(g.test ? ["TEST"] : [])],
    note: `Garnly-ordre ${g.orderName}. Betalt via Garnly, som afregner med jer månedligt.`,
    sourceName: "garnly",
    sourceIdentifier: g.groupId,
    test: g.test,
  };
  return {
    order,
    options: {
      // Butikken har alt sagt ja i panelet. Ordren skal ikke stoppe på et lagertall de selv har
      // sagt at ikke stemmer (CONTINUE-varianter, 18.11.2026).
      inventoryBehaviour: "DECREMENT_IGNORING_POLICY",
      sendReceipt: g.sendKvittering && !g.test,
      // Sporingen sender Garnly når pakken er sendt; ikke to e-poster om samme pakke.
      sendFulfillmentReceipt: false,
    },
    total,
  };
}

export interface PartnerFulfillment {
  createdAt: string;
  status: string;
  trackingInfo: Array<{ number: string | null; url: string | null; company: string | null }>;
}

/** Første gyldige sending i butikkens Shopify, med sporing hvis den finnes. REN logikk. */
export function velgSporing(fulfillments: PartnerFulfillment[]):
  | { createdAt: string; number: string | null; url: string | null; company: string | null }
  | null {
  const gyldige = fulfillments
    .filter((f) => !["CANCELLED", "ERROR", "FAILURE"].includes((f.status ?? "").toUpperCase()))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (!gyldige.length) return null;
  const medSporing = gyldige.find((f) => f.trackingInfo?.some((t) => t.number));
  const f = medSporing ?? gyldige[0];
  const t = f.trackingInfo?.find((x) => x.number) ?? f.trackingInfo?.[0] ?? null;
  return { createdAt: f.createdAt, number: t?.number ?? null, url: t?.url ?? null, company: t?.company ?? null };
}

// ---------------------------------------------------------------------------
// Mot Shopify og databasen
// ---------------------------------------------------------------------------

/** Hvor lenge et påbegynt forsøk holder låsen før et nytt kan prøve. */
const LAS_MS = 2 * 60 * 1000;

const ORDRE_MED_MERKE = `query Finnes($q: String!) { orders(first: 1, query: $q) { nodes { id name } } }`;

const VARIANT = `query Variant($q: String!) {
  productVariants(first: 5, query: $q) { nodes { id sku barcode } } }`;

const OPPRETT = `mutation OrderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
  orderCreate(order: $order, options: $options) {
    order { id name }
    userErrors { field message }
  }
}`;

const GARNLY_PRISER = `query Priser($id: ID!) {
  order(id: $id) {
    presentmentCurrencyCode
    totalShippingPriceSet { presentmentMoney { amount } }
    lineItems(first: 100) { nodes { quantity variant { id } discountedTotalSet { presentmentMoney { amount } } } }
  }
}`;

/** Variant-id-en i butikkens Shopify for en Garnly-vare: strekkode først, så SKU. */
export async function finnPartnervariant(storeId: string, ean: string | null, sku: string | null): Promise<string | null> {
  if (ean) {
    const r = await partnerGql<{ productVariants: { nodes: Array<{ id: string; barcode: string | null }> } }>(storeId, VARIANT, { q: `barcode:${ean}` });
    const treff = r.productVariants.nodes.find((v) => normalizeEan(v.barcode) === ean);
    if (treff) return treff.id;
  }
  if (sku) {
    const r = await partnerGql<{ productVariants: { nodes: Array<{ id: string; sku: string | null }> } }>(storeId, VARIANT, { q: `sku:${JSON.stringify(sku)}` });
    const treff = r.productVariants.nodes.find((v) => (v.sku ?? "").trim() === sku.trim());
    if (treff) return treff.id;
  }
  return null;
}

/** Ordren vi alt har laget for gruppen i butikkens Shopify, hvis den finnes. */
export async function finnPartnerordre(storeId: string, groupId: string): Promise<{ id: string; name: string } | null> {
  const r = await partnerGql<{ orders: { nodes: Array<{ id: string; name: string }> } }>(storeId, ORDRE_MED_MERKE, { q: `tag:${partnerTag(groupId)}` });
  return r.orders.nodes[0] ?? null;
}

/**
 * Lager ordren i butikkens Shopify for gruppen, eller gir tilbake den som alt finnes.
 * Kalles fra offer-respond før godkjenningen lagres: feiler den, er ordren ikke deres ennå,
 * og de kan trykke Godta igjen.
 */
export async function lagPartnerordre(groupId: string, store: StoreRow): Promise<{ id: string; name: string; ny: boolean }> {
  const db = adminClient();
  const { data: g, error } = await db.from("routing_groups")
    .select("id, routing_order_id, group_no, line_items, partner_order_id, partner_order_name, partner_order_started_at, routing_orders!inner(shopify_order_id, shopify_order_name, customer, is_test)")
    .eq("id", groupId).single();
  if (error || !g) throw new Error("Fant ikke gruppen");
  if (g.partner_order_id) return { id: g.partner_order_id, name: g.partner_order_name ?? "", ny: false };
  const ro = (Array.isArray(g.routing_orders) ? g.routing_orders[0] : g.routing_orders) as {
    shopify_order_id: string; shopify_order_name: string; customer: Kunde; is_test: boolean;
  };

  // Lås: to trykk på Godta samtidig skal ikke gi to ordrer hos butikken.
  const grense = new Date(Date.now() - LAS_MS).toISOString();
  const { data: las } = await db.from("routing_groups").update({ partner_order_started_at: new Date().toISOString() })
    .eq("id", groupId).is("partner_order_id", null)
    .or(`partner_order_started_at.is.null,partner_order_started_at.lt.${grense}`).select("id");
  if (!las?.length) throw new Error("Ordren lages akkurat nå i Shopify-en deres. Prøv igjen om et øyeblikk.");

  try {
    // Ble den laget sist, men svaret kom aldri fram? Da finnes den med merket vårt.
    let ordre = await finnPartnerordre(store.id, groupId);
    let ny = false;

    if (!ordre) {
      const linjer = g.line_items as LineItem[];
      const priser = await gql<{ order: { presentmentCurrencyCode: string; totalShippingPriceSet: { presentmentMoney: { amount: string } }; lineItems: { nodes: Array<{ quantity: number; variant: { id: string } | null; discountedTotalSet: { presentmentMoney: { amount: string } } }> } } }>(GARNLY_PRISER, { id: ro.shopify_order_id });
      if (!priser.order) throw new Error("Fant ikke ordren i Garnlys Shopify");

      const { data: produkter } = await db.from("products").select("id, ean, sku").in("id", linjer.map((l) => l.product_id));
      const produkt = new Map((produkter ?? []).map((p: { id: string; ean: string | null; sku: string | null }) => [p.id, p]));

      const partnerlinjer: Partnerlinje[] = [];
      const mangler: string[] = [];
      for (const l of linjer) {
        const p = produkt.get(l.product_id);
        const variantId = await finnPartnervariant(store.id, normalizeEan(p?.ean ?? l.barcode ?? null), p?.sku ?? l.sku ?? null);
        if (!variantId) { mangler.push(l.title); continue; }
        const shopifyLinje = priser.order.lineItems.nodes.find((n) => n.variant?.id === l.variant_id);
        const pris = shopifyLinje ? enhetspris(Number(shopifyLinje.discountedTotalSet.presentmentMoney.amount), shopifyLinje.quantity) : 0;
        partnerlinjer.push({ partnerVariantId: variantId, qty: l.qty, unitPrice: pris, title: l.title });
      }
      if (mangler.length) throw new Error(`Fant ikke disse varene i Shopify-en deres: ${mangler.join(", ")}`);

      // Frakten følger den første gruppa av ordren, som i oppgjøret (036).
      const { data: soskne } = await db.from("routing_groups").select("group_no, status").eq("routing_order_id", g.routing_order_id);
      const forste = Math.min(...(soskne ?? []).filter((s: { status: string }) => !["resplit", "cancelled", "archived"].includes(s.status)).map((s: { group_no: number }) => s.group_no));
      const frakt = g.group_no === forste ? Number(priser.order.totalShippingPriceSet?.presentmentMoney?.amount ?? 0) : null;

      const { order, options } = byggPartnerordre({
        groupId,
        orderName: ro.shopify_order_name,
        kunde: ro.customer ?? {},
        currency: priser.order.presentmentCurrencyCode,
        linjer: partnerlinjer,
        frakt,
        test: !!ro.is_test,
        sendKvittering: (store.pos_config as { send_receipt?: boolean } | null)?.send_receipt !== false,
      });
      const svar = await partnerGql<{ orderCreate: { order: { id: string; name: string } | null; userErrors: Array<{ field: string[] | null; message: string }> } }>(store.id, OPPRETT, { order, options });
      const feil = svar.orderCreate.userErrors ?? [];
      if (feil.length || !svar.orderCreate.order) {
        throw new Error(`Shopify-en deres tok ikke imot ordren: ${feil.map((e) => e.message).join("; ") || "ukjent feil"}`);
      }
      ordre = svar.orderCreate.order;
      ny = true;
    }

    const nå = new Date().toISOString();
    await db.from("routing_groups").update({
      partner_order_id: ordre.id,
      partner_order_name: ordre.name,
      partner_order_created_at: nå,
      partner_order_error: null,
      // Butikkens Shopify trakk lageret i det ordren ble laget. Se filhodet.
      pos_deducted_at: nå,
      pos_deducted_by: `ordre ${ordre.name} i butikkens Shopify`,
    }).eq("id", groupId);
    await audit("routing_group", groupId, ny ? "partner_order_created" : "partner_order_found", { store_id: store.id, partner_order: ordre.name, order: ro.shopify_order_name });
    return { id: ordre.id, name: ordre.name, ny };
  } catch (e) {
    const melding = e instanceof Error ? e.message : String(e);
    await db.from("routing_groups").update({ partner_order_started_at: null, partner_order_error: melding.slice(0, 500) }).eq("id", groupId);
    await audit("routing_group", groupId, "partner_order_failed", { store_id: store.id, error: melding });
    throw e;
  }
}

const PARTNER_SENDINGER = `query Sendt($id: ID!) {
  order(id: $id) { id cancelledAt fulfillments(first: 10) { createdAt status trackingInfo { number url company } } }
}`;

/**
 * Har butikken sendt? Da fullføres fulfillment orderen i Garnlys Shopify med sporingen derfra,
 * og kunden får e-posten fra Garnly. Gjør ingenting før butikken har sendt.
 */
export async function hentPartnerSporing(groupId: string): Promise<"sendt" | "venter" | "hoppet_over"> {
  const db = adminClient();
  const { data: g } = await db.from("routing_groups")
    .select("id, routing_order_id, status, assigned_store_id, partner_order_id, partner_order_name, fulfilled_at, shopify_fulfillment_order_id, partner_order_error, routing_orders!inner(shopify_order_name)")
    .eq("id", groupId).maybeSingle();
  if (!g || g.status !== "assigned" || !g.partner_order_id || g.fulfilled_at || !g.assigned_store_id) return "hoppet_over";
  await db.from("routing_groups").update({ partner_checked_at: new Date().toISOString() }).eq("id", groupId);
  const navn = (Array.isArray(g.routing_orders) ? g.routing_orders[0] : g.routing_orders)?.shopify_order_name ?? "";

  const r = await partnerGql<{ order: { cancelledAt: string | null; fulfillments: PartnerFulfillment[] } | null }>(g.assigned_store_id, PARTNER_SENDINGER, { id: g.partner_order_id });
  if (!r.order || r.order.cancelledAt) {
    const melding = r.order ? `Ordren ${g.partner_order_name} er kansellert i butikkens Shopify` : `Fant ikke ordren ${g.partner_order_name} i butikkens Shopify`;
    if (g.partner_order_error !== melding) {
      await db.from("routing_groups").update({ partner_order_error: melding }).eq("id", groupId);
      await audit("routing_group", groupId, "partner_order_missing", { order: navn, melding });
      const { notifyOps } = await import("./notify.ts");
      await notifyOps(`Partnerordre for ${navn} trenger handling`, `${melding}.\n\nOrdren er godtatt av butikken, men ikke sendt. Ta kontakt med butikken.`);
    }
    return "venter";
  }

  const s = velgSporing(r.order.fulfillments ?? []);
  if (!s) return "venter";

  const foId = g.shopify_fulfillment_order_id as string | null;
  if (!foId) throw new Error("Gruppen mangler fulfillment order i Garnlys Shopify");
  // «Sendt manuelt» FØR fulfillment: fulfillments/create-webhooken prøver ellers å melde inn en
  // Cargonizer-sending som ikke finnes (transfer_sync.ts). Sendingen er butikkens egen.
  await db.from("routing_groups").update({ manually_shipped_at: new Date().toISOString() })
    .eq("id", groupId).is("manually_shipped_at", null);
  const fo = await getFulfillmentOrder(foId);
  if (fo && fo.status !== "CLOSED" && fo.remaining > 0) {
    await releaseHold(foId);
    await createFulfillment(foId, s.number ? { number: s.number, url: s.url ?? undefined, company: s.company ?? undefined } : undefined, true);
  }

  await db.from("routing_groups").update({
    status: "fulfilled",
    fulfilled_at: s.createdAt,
    tracking_number: s.number,
    tracking_url: s.url,
    carrier: s.company,
    partner_order_error: null,
  }).eq("id", groupId).is("fulfilled_at", null);
  await audit("routing_group", groupId, "partner_fulfilled", { order: navn, partner_order: g.partner_order_name, tracking: s.number, carrier: s.company });
  const { refreshOrderStatus } = await import("./offers.ts");
  await refreshOrderStatus(g.routing_order_id);
  return "sendt";
}

/** Backstop: sjekker godtatte partnerordrer som ikke er sendt, hvert kvarter. Kalles av timeout-sweeper. */
export async function partnerSporingEtterslep(grense = 10): Promise<{ sjekket: number; sendt: number }> {
  const db = adminClient();
  const sist = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { data } = await db.from("routing_groups").select("id")
    .eq("status", "assigned").not("partner_order_id", "is", null).is("fulfilled_at", null)
    .or(`partner_checked_at.is.null,partner_checked_at.lt.${sist}`).limit(grense);
  let sendt = 0;
  for (const r of data ?? []) {
    try {
      if (await hentPartnerSporing(r.id) === "sendt") sendt++;
    } catch (e) {
      console.error("[partner-sporing]", r.id, e instanceof Error ? e.message : e);
    }
  }
  return { sjekket: (data ?? []).length, sendt };
}
