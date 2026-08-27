/**
 * offer-respond: butikken klikker Godta/Avslå i e-post/SMS.
 *   GET  ?t=<token>&a=accept|decline   → HTML-side (bekreftelse)
 *   POST { token, action, auto? }      → JSON (internt, auto-accept)
 *
 * Godta: re-verifiser lager live → move FO til butikkens location → release hold → book frakt → tracking → assigned.
 * Avslå: neste kandidat.
 */
import { adminClient, audit, html, json } from "../_shared/db.ts";
import { hashToken } from "../_shared/tokens.ts";
import { getAdapter } from "../_shared/adapters/index.ts";
import { createFulfillment, moveFulfillmentOrder, releaseHold } from "../_shared/shopify.ts";
import { makeNextOffer, refreshOrderStatus } from "../_shared/offers.ts";
import { bookShipment } from "../_shared/shipping/index.ts";
import type { LineItem, StoreRow } from "../_shared/types.ts";

Deno.serve(async (req) => {
  const url = new URL(req.url);
  let token: string | null, action: string | null, wantsHtml = true;
  if (req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    token = b.token; action = b.action; wantsHtml = false;
  } else {
    token = url.searchParams.get("t"); action = url.searchParams.get("a");
  }
  if (!token || !["accept", "decline"].includes(action ?? "")) return wantsHtml ? html(page("Ugyldig lenke", "Lenken mangler informasjon."), 400) : json({ error: "bad request" }, 400);

  const result = await respond(token, action as "accept" | "decline");
  if (!wantsHtml) return json(result, result.ok ? 200 : 409);
  return html(page(result.title, result.message), result.ok ? 200 : 409);
});

async function respond(token: string, action: "accept" | "decline"): Promise<{ ok: boolean; title: string; message: string }> {
  const db = adminClient();
  const { data: offer } = await db.from("offers").select("*, routing_groups!inner(*, routing_orders!inner(*)), stores!inner(*)").eq("token_hash", await hashToken(token)).maybeSingle();
  if (!offer) return { ok: false, title: "Fant ikke tilbudet", message: "Lenken er ugyldig eller allerede brukt." };
  const group = offer.routing_groups;
  const order = group.routing_orders;
  const store = offer.stores as StoreRow;

  if (offer.status !== "offered") {
    const why = offer.status === "accepted" ? "Dere har allerede godtatt denne ordren." : offer.status === "expired" ? "Fristen har dessverre gått ut, og ordren er sendt videre." : "Dette tilbudet er ikke lenger aktivt.";
    return { ok: false, title: "Tilbudet er ikke aktivt", message: why };
  }
  if (group.status !== "routing") return { ok: false, title: "Ordren er allerede håndtert", message: "Ordren er tildelt en annen butikk eller kansellert." };

  const now = new Date().toISOString();

  if (action === "decline") {
    await db.from("offers").update({ status: "declined", responded_at: now }).eq("id", offer.id);
    await audit("offer", offer.id, "declined", { store_id: store.id });
    await makeNextOffer(group.id);
    return { ok: true, title: "Takk for svaret", message: `Ordre ${order.shopify_order_name} går videre til neste butikk. Dere blir ikke nedprioritert for å si nei.` };
  }

  // --- Godta ---
  // 1. Re-verifiser lager live
  const items = group.line_items as LineItem[];
  const { data: products } = await db.from("products").select("id, ean, name").in("id", items.map((i) => i.product_id));
  const eanByProduct = new Map((products ?? []).map((p: any) => [p.id, p.ean as string | null]));
  const eans = items.map((i) => eanByProduct.get(i.product_id)).filter(Boolean) as string[];
  if (eans.length === items.length && store.pos_system !== "manual") {
    try {
      const { data: sec } = await db.from("store_secrets").select("secrets").eq("store_id", store.id).maybeSingle();
      const live = await getAdapter(store.pos_system).fetchStockFor(store, (sec?.secrets ?? {}) as Record<string, string>, eans);
      const short = items.filter((i) => (live.get(eanByProduct.get(i.product_id)!) ?? 0) < i.qty);
      if (short.length) {
        await db.from("offers").update({ status: "declined_stock", responded_at: now, response_note: "live-sjekk: " + short.map((s) => s.title).join(", ") }).eq("id", offer.id);
        await audit("offer", offer.id, "declined_stock", { short: short.map((s) => s.title) });
        await makeNextOffer(group.id);
        return { ok: false, title: "Ikke nok på lager", message: `Kassesystemet deres viser at dere ikke har nok av: ${short.map((s) => s.title).join(", ")}. Ordren går videre til neste butikk.` };
      }
    } catch (e) {
      console.warn("Live lagersjekk feilet, fortsetter på siste synk:", e instanceof Error ? e.message : e);
    }
  }

  // 2. Shopify: flytt + slipp hold
  if (!store.shopify_location_id) return { ok: false, title: "Oppsettsfeil", message: "Butikken mangler Shopify-location. Kontakt Garnly." };
  const movedFoId = await moveFulfillmentOrder(group.shopify_fulfillment_order_id, store.shopify_location_id);
  await releaseHold(movedFoId);

  // 3. Marker tildelt (før frakt, så et fraktproblem ikke lar ordren gå videre til andre)
  await db.from("offers").update({ status: "accepted", responded_at: now }).eq("id", offer.id);
  await db.from("offers").update({ status: "cancelled" }).eq("routing_group_id", group.id).eq("status", "pending");
  await db.from("routing_groups").update({ status: "assigned", assigned_store_id: store.id, assigned_at: now, shopify_fulfillment_order_id: movedFoId }).eq("id", group.id);
  await db.rpc("mark_store_assigned", { p_store_id: store.id });
  await refreshOrderStatus(order.id);
  await audit("routing_group", group.id, "assigned", { store_id: store.id, offer_id: offer.id });

  // 4. Frakt
  let shipMsg = "";
  try {
    const shipment = await bookShipment({ store, order, items });
    if (shipment) {
      await db.from("routing_groups").update({ tracking_number: shipment.trackingNumber, tracking_url: shipment.trackingUrl, shipment_id: shipment.id }).eq("id", group.id);
      await createFulfillment(movedFoId, { number: shipment.trackingNumber, url: shipment.trackingUrl, company: shipment.carrier });
      shipMsg = shipment.labelUrl ? ` Fraktetikett: ${shipment.labelUrl}` : " Fraktetiketten er sendt til printeren deres.";
    } else {
      shipMsg = " Frakt bookes manuelt (ingen fraktleverandør er koblet på ennå).";
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await audit("routing_group", group.id, "shipping_failed", { error: msg });
    const { notifyOps } = await import("../_shared/notify.ts");
    await notifyOps(`Frakt feilet for ${order.shopify_order_name}`, `Butikk: ${store.name}\n${msg}`);
    shipMsg = " Fraktbooking feilet, Garnly ordner etikett og tar kontakt.";
  }

  return { ok: true, title: "Ordren er deres!", message: `Ordre ${order.shopify_order_name} er tildelt ${store.name}. Pakk: ${items.map((i) => `${i.qty} × ${i.title}`).join(", ")}.${shipMsg}` };
}

function page(title: string, message: string) {
  return `<!doctype html><html lang="no"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} – Garnly</title>
<style>body{font-family:system-ui,sans-serif;background:#F7F2EA;color:#2A2522;margin:0;padding:2rem}main{max-width:520px;margin:3rem auto;background:#fff;border-radius:24px;padding:2rem;box-shadow:0 2px 12px rgba(0,0,0,.06)}h1{color:#5F0B09;font-size:1.5rem}</style></head>
<body><main><h1>${title}</h1><p>${message}</p><p style="color:#888;font-size:.9rem">Garnly ordreruting</p></main></body></html>`;
}
