/**
 * order-cancelled: Shopify webhook `orders/cancelled`. Avbryter aktiv ruting og åpne tilbud.
 */
import { adminClient, audit, json } from "../_shared/db.ts";
import { verifyShopifyHmac } from "../_shared/shopify.ts";

Deno.serve(async (req) => {
  const raw = await req.text();
  if (!(await verifyShopifyHmac(raw, req.headers.get("x-shopify-hmac-sha256")))) return json({ error: "invalid hmac" }, 401);
  const db = adminClient();
  const webhookId = req.headers.get("x-shopify-webhook-id") ?? crypto.randomUUID();
  const { error } = await db.from("shopify_webhook_events").insert({ id: webhookId, topic: "orders/cancelled" });
  if (error?.code === "23505") return json({ ok: true, duplicate: true });

  const payload = JSON.parse(raw);
  const gid = payload.admin_graphql_api_id ?? `gid://shopify/Order/${payload.id}`;
  const { data: ro } = await db.from("routing_orders").select("id, status").eq("shopify_order_id", gid).maybeSingle();
  if (!ro) return json({ ok: true, unknown: true });

  const { data: groups } = await db.from("routing_groups").select("id, status, assigned_store_id").eq("routing_order_id", ro.id);
  for (const g of groups ?? []) {
    if (g.status === "routing" || g.status === "escalated") {
      await db.from("offers").update({ status: "cancelled" }).eq("routing_group_id", g.id).in("status", ["pending", "offered"]);
      await db.from("routing_groups").update({ status: "cancelled" }).eq("id", g.id);
    } else if (g.status === "assigned") {
      // Butikken har allerede fått ordren: varsle dem
      const { data: store } = await db.from("stores").select("name, contact_email").eq("id", g.assigned_store_id).single();
      const { sendEmail, notifyOps } = await import("../_shared/notify.ts");
      if (store?.contact_email) await sendEmail(store.contact_email, `Garnly-ordre ${payload.name} er kansellert`, `<p>Ordre ${payload.name} er kansellert av kunden/Garnly. Ikke send pakken.</p>`);
      await notifyOps(`Kansellert etter tildeling: ${payload.name}`, `Butikk ${store?.name} hadde ordren. Sjekk om pakken er sendt.`);
    }
  }
  await db.from("routing_orders").update({ status: "cancelled" }).eq("id", ro.id);
  await audit("routing_order", ro.id, "cancelled", { name: payload.name });
  return json({ ok: true });
});
