/**
 * fulfillment-webhook: Shopify `fulfillments/create`.
 *
 * Garnly oppretter ikke fulfillments selv. Butikken lager sendingen i CargonizerConnect
 * (Logistra), og den appen fulfiller ordren i Shopify med sporingsnummer. Denne webhooken er
 * hvordan vi får vite at det har skjedd.
 *
 * Det er ikke bokføring: i det Shopify oppretter fulfillmenten faller `committed` bort og
 * Shopify trekker selv ned `on_hand`. Butikkens kasse teller fortsatt varene, så fra da av må
 * sync-store trekke dem fra selv – til butikken bekrefter uttrekket i panelet. Uten dette
 * tidspunktet står det hullet åpent. Se `_shared/inventory.ts`.
 *
 * Vi leser ikke tallene ut av payloaden, men bruker den som et varsel og spør Shopify.
 * Payloaden bruker REST-id-er for ordrelinjer, mens vi lagrer id-er for
 * fulfillment order-linjer – de lar seg ikke sammenligne. Shopify har uansett fasiten,
 * og samme kodevei brukes av backstoppen i timeout-sweeper.
 */
import { adminClient, json } from "../_shared/db.ts";
import { verifyShopifyHmac } from "../_shared/shopify.ts";
import { reconcileFulfilledAt, routingOrderByShopifyId } from "../_shared/fulfillment_sync.ts";

Deno.serve(async (req) => {
  const raw = await req.text();
  if (!(await verifyShopifyHmac(raw, req.headers.get("x-shopify-hmac-sha256")))) return json({ error: "invalid hmac" }, 401);

  const db = adminClient();
  const webhookId = req.headers.get("x-shopify-webhook-id") ?? crypto.randomUUID();
  const { error } = await db.from("shopify_webhook_events").insert({ id: webhookId, topic: "fulfillments/create" });
  if (error?.code === "23505") return json({ ok: true, duplicate: true });

  const payload = JSON.parse(raw);
  // Fulfillment-payloaden har order_id som REST-id. admin_graphql_api_id på selve
  // fulfillmenten peker på fulfillmenten, ikke ordren, så den kan ikke brukes her.
  const orderGid = payload.order_id ? `gid://shopify/Order/${payload.order_id}` : null;
  if (!orderGid) return json({ ok: true, skipped: "mangler order_id" });

  const routingOrderId = await routingOrderByShopifyId(orderGid);
  if (!routingOrderId) return json({ ok: true, unknown: true });

  const merket = await reconcileFulfilledAt(routingOrderId);
  return json({ ok: true, marked: merket });
});
