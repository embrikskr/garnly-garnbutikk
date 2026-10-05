/**
 * order-cancelled: Shopify webhook `orders/cancelled`. Avbryter aktiv ruting og åpne tilbud.
 *
 * Har en butikk alt fått ordren, men ikke sendt den, settes gruppen til kansellert: kortet
 * forsvinner fra «Til pakking» og står som «Kansellert» under «Tidligere ordrer», og
 * «Slått ut og klar til sending» nekter. Var etiketten skrevet ut, slettes den uoverførte
 * sendingen i Cargonizer (_shared/annullering.ts) – eller havner under «Trenger handling».
 *
 * Kan også kalles internt med x-cron-secret:
 *   { "mode": "void_backstop" }           cron hver halvtime: sendinger som ikke ble slettet
 *   { "routing_order_id": "<uuid>" }      kjør slettingen for én kansellert ordre på nytt
 */
import { adminClient, audit, json, requireInternalSecret } from "../_shared/db.ts";
import { verifyShopifyHmac } from "../_shared/shopify.ts";
import { annullerEtterslep, annullerSendinger } from "../_shared/annullering.ts";

Deno.serve(async (req) => {
  const raw = await req.text();

  if (req.headers.get("x-cron-secret") !== null) {
    const nei = requireInternalSecret(req);
    if (nei) return nei;
    const body = raw ? JSON.parse(raw) : {};
    if (body.mode === "void_backstop") return json({ ok: true, ...(await annullerEtterslep()) });
    if (body.routing_order_id) return json({ ok: true, utfall: await annullerSendinger(String(body.routing_order_id)) });
    return json({ error: "ukjent kall" }, 400);
  }

  if (!(await verifyShopifyHmac(raw, req.headers.get("x-shopify-hmac-sha256")))) return json({ error: "invalid hmac" }, 401);
  const db = adminClient();
  const webhookId = req.headers.get("x-shopify-webhook-id") ?? crypto.randomUUID();
  const { error } = await db.from("shopify_webhook_events").insert({ id: webhookId, topic: "orders/cancelled" });
  if (error?.code === "23505") return json({ ok: true, duplicate: true });

  const payload = JSON.parse(raw);
  const gid = payload.admin_graphql_api_id ?? `gid://shopify/Order/${payload.id}`;
  const { data: ro } = await db.from("routing_orders").select("id, status").eq("shopify_order_id", gid).maybeSingle();
  if (!ro) return json({ ok: true, unknown: true });

  const { data: groups } = await db.from("routing_groups").select("id, status, assigned_store_id, fulfilled_at").eq("routing_order_id", ro.id);
  for (const g of groups ?? []) {
    if (g.status === "routing" || g.status === "escalated") {
      await db.from("offers").update({ status: "cancelled" }).eq("routing_group_id", g.id).in("status", ["pending", "offered"]);
      await db.from("routing_groups").update({ status: "cancelled" }).eq("id", g.id);
    } else if (g.status === "assigned" || g.status === "fulfilled") {
      // Ikke sendt ennå: ut av pakkelista, så ingen pakker den. Sendt: står som sendt – pengene
      // tar refusjonen (order-refunded).
      if (g.status === "assigned" && !g.fulfilled_at) {
        await db.from("routing_groups").update({ status: "cancelled" }).eq("id", g.id).eq("status", "assigned");
        await audit("routing_group", g.id, "cancelled_before_shipping", { order: payload.name });
      }
      // Butikken har allerede fått ordren: varsle dem
      const { data: store } = await db.from("stores").select("name, contact_email").eq("id", g.assigned_store_id).single();
      const { sendEmail, notifyOps } = await import("../_shared/notify.ts");
      if (store?.contact_email) await sendEmail(store.contact_email, `Garnly-ordre ${payload.name} er kansellert`, `<p>Ordre ${payload.name} er kansellert av kunden/Garnly. Ikke send pakken.</p>`);
      await notifyOps(`Kansellert etter tildeling: ${payload.name}`, `Butikk ${store?.name} hadde ordren. Sjekk om pakken er sendt.`);
    }
  }
  await db.from("routing_orders").update({ status: "cancelled" }).eq("id", ro.id);
  await audit("routing_order", ro.id, "cancelled", { name: payload.name });

  // Uoverførte sendinger slettes i bakgrunnen: Shopify vil ha svar innen 5 s, og Cargonizer kan
  // bruke lenger. Feiler det, tar backstoppen det, og Garnly ser det under «Trenger handling».
  const work = annullerSendinger(ro.id)
    .then((u) => { if (u.length) console.log("[order-cancelled] sendinger", JSON.stringify(u)); })
    .catch((e) => console.error("[order-cancelled] sletting feilet", ro.id, e));
  // @ts-ignore EdgeRuntime finnes i Supabase Edge Functions
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work); else await work;
  return json({ ok: true });
});
