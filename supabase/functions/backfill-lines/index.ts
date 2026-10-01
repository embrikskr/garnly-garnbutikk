/**
 * backfill-lines: etterfyller varelinjene på ordrer som ble rutet før feltene fantes.
 *
 * `line_items` lagret opprinnelig bare `title`. Da varianttittel, SKU, strekkode, bilde og
 * garnpakkeinnhold ble lagt til (30.09.2026), hadde ordrene som alt lå i panelet ingen av
 * dem – og det er nettopp de butikken skal pakke nå. Denne henter dem fra Shopify.
 *
 * Vedlikeholdsjobb, ikke cron. Kjøres manuelt:
 *   select call_edge_function('backfill-lines');
 *
 * **Linjene matches på variant-id, ikke på line_item_id.** Deles en fulfillment order
 * (`fulfillmentOrderSplit`), får linjene nye id-er, så en gruppe kan ha en line_item_id som
 * ikke finnes i Shopify lenger. Variant-id-en står. Antall og beløp røres ikke – de hører til
 * rutingen, ikke til produktet.
 */
import { adminClient, json, requireInternalSecret } from "../_shared/db.ts";
import { getOrder } from "../_shared/shopify.ts";
import { erGarnpakke, kitLinjer, variantTittel } from "../_shared/lines.ts";
import type { LineItem } from "../_shared/types.ts";

Deno.serve(async (req) => {
  const unauthorized = requireInternalSecret(req);
  if (unauthorized) return unauthorized;
  const db = adminClient();

  const { data: rader } = await db
    .from("routing_groups")
    .select("id, line_items, routing_orders(id, shopify_order_id, shopify_order_name)")
    .in("status", ["routing", "assigned", "escalated", "fulfilled"])
    .limit(200);

  type Rad = { id: string; line_items: LineItem[] | null; routing_orders: { shopify_order_id: string; shopify_order_name: string } | { shopify_order_id: string; shopify_order_name: string }[] | null };
  const grupper = (rader ?? []) as unknown as Rad[];

  // Bare de som mangler feltene. `variant_title` er markøren: den settes alltid av byggLinje,
  // også når den er null, så fravær av nøkkelen betyr «rutet før endringen».
  const trenger = grupper.filter((g) => (g.line_items ?? []).some((l) => !("variant_title" in l)));

  const cache = new Map<string, Map<string, Partial<LineItem>>>();
  let oppdatert = 0, hoppet = 0;
  const feil: string[] = [];

  for (const g of trenger) {
    const ordre = (Array.isArray(g.routing_orders) ? g.routing_orders[0] : g.routing_orders) ?? null;
    if (!ordre?.shopify_order_id) { hoppet++; continue; }
    try {
      let perVariant = cache.get(ordre.shopify_order_id);
      if (!perVariant) {
        perVariant = detaljerPerVariant(await getOrder(ordre.shopify_order_id));
        cache.set(ordre.shopify_order_id, perVariant);
      }
      const nye = (g.line_items ?? []).map((l) => {
        const d = perVariant!.get(l.variant_id);
        // Nøklene settes selv uten treff, så gruppen ikke plukkes opp på nytt i all evighet
        // om varianten er slettet i Shopify.
        return { ...l, variant_title: null, sku: null, barcode: null, ...d };
      });
      const { error } = await db.from("routing_groups").update({ line_items: nye }).eq("id", g.id);
      if (error) throw new Error(error.message);
      oppdatert++;
    } catch (e) {
      feil.push(`${ordre.shopify_order_name ?? g.id}: ${e instanceof Error ? e.message : e}`);
    }
  }

  return json({ sett: grupper.length, trengte: trenger.length, oppdatert, hoppet, feil });
});

/** Variant-id → produktdetaljene, samlet fra alle fulfillment orders på ordren. */
function detaljerPerVariant(order: Awaited<ReturnType<typeof getOrder>>): Map<string, Partial<LineItem>> {
  const ut = new Map<string, Partial<LineItem>>();
  for (const fo of order.fulfillmentOrders?.nodes ?? []) {
    for (const n of fo.lineItems?.nodes ?? []) {
      const v = n.lineItem.variant;
      if (!v?.id) continue;
      const innhold = erGarnpakke(v.product) ? kitLinjer(v.product?.metafield?.value) : [];
      ut.set(v.id, {
        variant_title: variantTittel(v.title),
        sku: v.sku?.trim() || null,
        barcode: v.barcode?.trim() || null,
        ...(innhold.length ? { kit_contents: innhold } : {}),
      });
    }
  }
  return ut;
}
