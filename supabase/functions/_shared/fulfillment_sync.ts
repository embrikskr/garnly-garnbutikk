/**
 * Henter fulfillment-tidspunkt fra Shopify og skriver dem til routing_groups.
 *
 * Kalles fra to steder, med samme kodevei:
 *   - `fulfillment-webhook` når Shopify sier at en sending er opprettet (umiddelbart)
 *   - `timeout-sweeper` som backstop, i tilfelle en webhook går tapt
 *
 * Shopify er fasit. Garnly oppretter ikke fulfillments selv – CargonizerConnect gjør det –
 * så vi kan ikke utlede tidspunktet av våre egne handlinger.
 */
import { adminClient, audit } from "./db.ts";
import { getOrderFulfillments } from "./shopify.ts";
import { type GroupForMatch, matchFulfillments } from "./fulfillment.ts";

/**
 * Setter fulfilled_at på gruppene i én ordre som Shopify har sendt.
 * Returnerer hvor mange grupper som ble merket.
 */
export async function reconcileFulfilledAt(routingOrderId: string): Promise<number> {
  const db = adminClient();

  const { data: order } = await db.from("routing_orders").select("id, shopify_order_id, shopify_order_name").eq("id", routingOrderId).maybeSingle();
  if (!order?.shopify_order_id) return 0;

  const { data: rows } = await db
    .from("routing_groups")
    .select("id, line_items, stores:assigned_store_id(shopify_location_id)")
    .eq("routing_order_id", routingOrderId)
    .eq("status", "assigned")
    .is("fulfilled_at", null);

  // PostgREST gir én-til-mange som liste og mange-til-én som objekt. Embeddingen her er
  // mange-til-én, men typen fra klienten sier liste, så vi tåler begge deler.
  const åpne = (rows ?? []) as unknown as Array<{
    id: string;
    line_items: Array<{ variant_id?: string }> | null;
    stores: { shopify_location_id: string | null } | Array<{ shopify_location_id: string | null }> | null;
  }>;
  if (!åpne.length) return 0;

  const locationFor = (s: (typeof åpne)[number]["stores"]): string | null =>
    (Array.isArray(s) ? s[0]?.shopify_location_id : s?.shopify_location_id) ?? null;

  // Merk at vi har sett etter, uansett utfall. Uten dette ville backstoppen spurt Shopify om
  // de samme gruppene hvert minutt i all evighet for ordrer som aldri blir sendt.
  const nå = new Date().toISOString();
  await db.from("routing_groups").update({ fulfillment_checked_at: nå }).in("id", åpne.map((g) => g.id));

  const grupper: GroupForMatch[] = åpne.map((g) => ({
    id: g.id,
    location_id: locationFor(g.stores),
    variant_ids: (g.line_items ?? []).map((l) => l.variant_id).filter(Boolean) as string[],
  }));

  const sendinger = await getOrderFulfillments(order.shopify_order_id);
  if (!sendinger.length) return 0;

  const treff = matchFulfillments(
    grupper,
    sendinger.map((f) => ({ id: f.id, createdAt: f.createdAt, status: f.status, locationId: f.locationId, variantIds: f.variantIds })),
  );

  let merket = 0;
  for (const [groupId, createdAt] of treff) {
    // Betinget: en webhook og backstoppen kan treffe samtidig, og da skal tidspunktet stå.
    // Status følger med: uten den ville gruppen blitt liggende som 'assigned' og vist i
    // panelets pakkeliste for alltid.
    const { data: upd } = await db.from("routing_groups")
      .update({ fulfilled_at: createdAt, status: "fulfilled" })
      .eq("id", groupId).is("fulfilled_at", null).select("id");
    if (!upd?.length) continue;
    await audit("routing_group", groupId, "fulfilled", { at: createdAt, order: order.shopify_order_name });
    merket++;
  }
  return merket;
}

/** Ordren bak et Shopify-ordre-id, om vi ruter den. */
export async function routingOrderByShopifyId(shopifyOrderGid: string): Promise<string | null> {
  const { data } = await adminClient().from("routing_orders").select("id").eq("shopify_order_id", shopifyOrderGid).maybeSingle();
  return data?.id ?? null;
}
