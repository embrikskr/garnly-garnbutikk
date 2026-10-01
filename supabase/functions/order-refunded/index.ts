/**
 * order-refunded: Shopify-webhook `refunds/create` → trekk i butikkens oppgjør.
 *
 * Refunderte varer trekkes fra butikken som hadde ordren: minus refundert varebeløp ×
 * (100 − provisjon) / 100. Frakt trekkes aldri; den er Garnlys. Testordrer hoppes over.
 * Selve jobben ligger i _shared/refund_sync.ts.
 *
 * Kan også kalles internt med x-cron-secret:
 *   { "refund_id": "gid://shopify/Refund/…" }  én refusjon (re-kjøring)
 *   { "mode": "backstop", "days": 3 }          nattlig cron (031): refusjoner webhooken mistet
 *   { "mode": "ensure_webhook" }               registrer refunds/create hos Shopify hvis den mangler
 */
import { adminClient, json, requireInternalSecret } from "../_shared/db.ts";
import { verifyShopifyHmac } from "../_shared/shopify.ts";
import { behandleRefusjon, refusjonsBackstop, sikreWebhook } from "../_shared/refund_sync.ts";

Deno.serve(async (req) => {
  const raw = await req.text();

  if (req.headers.get("x-cron-secret") !== null) {
    const nei = requireInternalSecret(req);
    if (nei) return nei;
    const body = raw ? JSON.parse(raw) : {};
    try {
      if (body.mode === "backstop") return json({ ok: true, ...(await refusjonsBackstop(Number(body.days) || 3)) });
      if (body.mode === "ensure_webhook") return json({ ok: true, ...(await sikreWebhook()) });
      if (body.refund_id) return json({ ok: true, ...(await behandleRefusjon(String(body.refund_id))) });
      return json({ error: "ukjent kall" }, 400);
    } catch (e) {
      console.error("[order-refunded]", e);
      return json({ ok: false, error: (e as Error).message }, 500);
    }
  }

  if (!(await verifyShopifyHmac(raw, req.headers.get("x-shopify-hmac-sha256")))) return json({ error: "invalid hmac" }, 401);
  const webhookId = req.headers.get("x-shopify-webhook-id") ?? crypto.randomUUID();
  const { error } = await adminClient().from("shopify_webhook_events").insert({ id: webhookId, topic: "refunds/create" });
  if (error?.code === "23505") return json({ ok: true, duplicate: true });

  const payload = JSON.parse(raw);
  const refundGid = payload.admin_graphql_api_id ?? (payload.id ? `gid://shopify/Refund/${payload.id}` : null);
  if (!refundGid) return json({ ok: true, skipped: "mangler refusjons-id" });

  // Svar Shopify raskt (krever svar innen 5 s); jobben går i bakgrunnen. Feiler den, tar
  // backstoppen den neste natt.
  const work = behandleRefusjon(refundGid)
    .then((u) => console.log("[order-refunded]", JSON.stringify(u)))
    .catch((e) => console.error("[order-refunded] feilet:", refundGid, e));
  // @ts-ignore EdgeRuntime finnes i Supabase Edge Functions
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work); else await work;
  return json({ ok: true });
});
