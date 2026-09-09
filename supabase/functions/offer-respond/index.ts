/**
 * offer-respond: butikken svarer på et tilbud.
 *
 *   POST { offer_id, action }  + Authorization: Bearer <bruker-JWT>
 *        → butikkpanelet. Verifiserer at brukeren hører til butikken tilbudet gjelder.
 *   GET  ?t=<token>&a=accept|decline
 *        → engangslenke (reserve for butikker uten panel, og for support).
 *   POST { token, action, auto? } + x-cron-secret
 *        → internt, brukes av auto_accept.
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

/**
 * PANEL_ORIGIN kan være flere adresser, kommaseparert: panelet ligger på én kanonisk
 * URL, men Vercel gir hver deploy sin egen, og åpner man panelet derfra blir origin
 * en annen. Da blokkerer nettleseren svaret, og butikken ser bare «fikk ikke kontakt».
 * Vi speiler tilbake origin når den står på lista, ellers den første oppføringen.
 */
const ALLOWED = (Deno.env.get("PANEL_ORIGIN") ?? "*").split(",").map((s) => s.trim()).filter(Boolean);

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allow = ALLOWED.includes("*") ? "*" : ALLOWED.includes(origin) ? origin : ALLOWED[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, content-type, x-cron-secret",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

type Outcome = { ok: boolean; title: string; message: string; code?: string };

Deno.serve(async (req) => {
  const CORS = cors(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url = new URL(req.url);

  // --- GET: engangslenke, svarer med HTML-side ---
  if (req.method === "GET") {
    const token = url.searchParams.get("t");
    const action = url.searchParams.get("a");
    if (!token || !isAction(action)) return html(page("Ugyldig lenke", "Lenken mangler informasjon."), 400);
    const offer = await offerByToken(token);
    if (!offer) return html(page("Fant ikke tilbudet", "Lenken er ugyldig eller allerede brukt."), 409);
    const result = await applyResponse(offer, action);
    return html(page(result.title, result.message), result.ok ? 200 : 409);
  }

  if (req.method !== "POST") return json({ error: "method not allowed" }, 405, CORS);

  const body = await req.json().catch(() => ({}));
  const action = body.action;
  if (!isAction(action)) return json({ error: "bad request", message: "action må være accept eller decline" }, 400, CORS);

  // --- POST med token: internt (auto_accept) ---
  if (body.token) {
    const internal = req.headers.get("x-cron-secret") === Deno.env.get("CRON_SECRET");
    const offer = await offerByToken(body.token);
    if (!offer) return json({ ok: false, code: "not_found", message: "Tilbudet finnes ikke" }, 409, CORS);
    if (!internal && offer.status !== "offered") return json({ ok: false, code: "inactive" }, 409, CORS);
    const result = await applyResponse(offer, action);
    return json(result, result.ok ? 200 : 409, CORS);
  }

  // --- POST fra butikkpanelet: bruker-JWT + offer_id ---
  if (!body.offer_id) return json({ error: "bad request", message: "offer_id mangler" }, 400, CORS);

  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "unauthorized" }, 401, CORS);

  const db = adminClient();
  const { data: auth, error: authErr } = await db.auth.getUser(jwt);
  if (authErr || !auth?.user) return json({ error: "unauthorized" }, 401, CORS);

  const offer = await offerById(body.offer_id);
  if (!offer) return json({ ok: false, code: "not_found", title: "Fant ikke ordren", message: "Tilbudet finnes ikke." }, 404, CORS);

  const { data: member } = await db.from("store_users")
    .select("store_id").eq("user_id", auth.user.id).eq("store_id", offer.store_id).maybeSingle();
  if (!member) return json({ error: "forbidden", message: "Brukeren hører ikke til denne butikken" }, 403, CORS);

  const result = await applyResponse(offer, action, auth.user.email ?? undefined);
  return json(result, result.ok ? 200 : 409, CORS);
});

function isAction(a: unknown): a is "accept" | "decline" {
  return a === "accept" || a === "decline";
}

const OFFER_SELECT = "*, routing_groups!inner(*, routing_orders!inner(*)), stores!inner(*)";

async function offerByToken(token: string) {
  const { data } = await adminClient().from("offers").select(OFFER_SELECT)
    .eq("token_hash", await hashToken(token)).maybeSingle();
  return data;
}

async function offerById(id: string) {
  const { data } = await adminClient().from("offers").select(OFFER_SELECT).eq("id", id).maybeSingle();
  return data;
}

/** Selve svarhåndteringen. Identisk uansett om svaret kom fra panelet eller en lenke. */
async function applyResponse(offer: any, action: "accept" | "decline", byUser?: string): Promise<Outcome> {
  const db = adminClient();
  const group = offer.routing_groups;
  const order = group.routing_orders;
  const store = offer.stores as StoreRow;

  if (offer.status !== "offered") {
    const why = offer.status === "accepted"
      ? "Dere har allerede godtatt denne ordren."
      : offer.status === "expired"
      ? "Fristen har gått ut, og ordren er sendt videre."
      : "Dette tilbudet er ikke lenger aktivt.";
    return { ok: false, code: "inactive", title: "Tilbudet er ikke aktivt", message: why };
  }
  if (group.status !== "routing") {
    return { ok: false, code: "handled", title: "Ordren er allerede håndtert", message: "Ordren er tildelt en annen butikk eller kansellert." };
  }

  const now = new Date().toISOString();

  if (action === "decline") {
    await db.from("offers").update({ status: "declined", responded_at: now, response_note: byUser ? `avslått av ${byUser}` : null }).eq("id", offer.id);
    await audit("offer", offer.id, "declined", { store_id: store.id, by: byUser ?? "lenke" });
    await makeNextOffer(group.id);
    return {
      ok: true,
      code: "declined",
      title: "Takk for svaret",
      message: `Ordre ${order.shopify_order_name} går videre til neste butikk. Dere blir ikke nedprioritert for å si nei.`,
    };
  }

  // --- Godta ---
  // 1. Re-verifiser lager live mot kassesystemet
  const items = group.line_items as LineItem[];
  const { data: products } = await db.from("products").select("id, ean, name").in("id", items.map((i) => i.product_id));
  const eanByProduct = new Map((products ?? []).map((p: { id: string; ean: string | null }) => [p.id, p.ean]));
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
        return {
          ok: false,
          code: "out_of_stock",
          title: "Ikke nok på lager",
          message: `Kassesystemet deres viser at dere ikke har nok av: ${short.map((s) => s.title).join(", ")}. Ordren går videre til neste butikk.`,
        };
      }
    } catch (e) {
      console.warn("Live lagersjekk feilet, fortsetter på siste synk:", e instanceof Error ? e.message : e);
    }
  }

  // 2. Shopify: flytt fulfillment order til butikkens location, slipp hold
  if (!store.shopify_location_id) {
    return { ok: false, code: "config", title: "Oppsettsfeil", message: "Butikken mangler Shopify-location. Kontakt Garnly." };
  }
  const movedFoId = await moveFulfillmentOrder(group.shopify_fulfillment_order_id, store.shopify_location_id);
  await releaseHold(movedFoId);

  // 3. Marker tildelt før frakt, så et fraktproblem ikke sender ordren videre til andre
  await db.from("offers").update({ status: "accepted", responded_at: now, response_note: byUser ? `godtatt av ${byUser}` : null }).eq("id", offer.id);
  await db.from("offers").update({ status: "cancelled" }).eq("routing_group_id", group.id).eq("status", "pending");
  await db.from("routing_groups").update({
    status: "assigned",
    assigned_store_id: store.id,
    assigned_at: now,
    shopify_fulfillment_order_id: movedFoId,
  }).eq("id", group.id);
  await db.rpc("mark_store_assigned", { p_store_id: store.id });
  await refreshOrderStatus(order.id);
  await audit("routing_group", group.id, "assigned", { store_id: store.id, offer_id: offer.id, by: byUser ?? "lenke" });

  // 4. Frakt
  let shipMsg = "";
  let labelUrl: string | null = null;
  try {
    const shipment = await bookShipment({ store, order, items });
    if (shipment) {
      await db.from("routing_groups").update({
        tracking_number: shipment.trackingNumber,
        tracking_url: shipment.trackingUrl,
        shipment_id: shipment.id,
      }).eq("id", group.id);
      await createFulfillment(movedFoId, { number: shipment.trackingNumber, url: shipment.trackingUrl, company: shipment.carrier });
      labelUrl = shipment.labelUrl ?? null;
      shipMsg = labelUrl ? " Fraktetiketten er klar." : " Fraktetiketten er sendt til printeren deres.";
    } else {
      shipMsg = " Frakt bookes manuelt, ingen fraktleverandør er koblet på ennå.";
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await audit("routing_group", group.id, "shipping_failed", { error: msg });
    const { notifyOps } = await import("../_shared/notify.ts");
    await notifyOps(`Frakt feilet for ${order.shopify_order_name}`, `Butikk: ${store.name}\n${msg}`);
    shipMsg = " Fraktbooking feilet, Garnly ordner etikett og tar kontakt.";
  }

  return {
    ok: true,
    code: "accepted",
    title: "Ordren er deres",
    message: `Ordre ${order.shopify_order_name} er tildelt ${store.name}. Pakk: ${items.map((i) => `${i.qty} × ${i.title}`).join(", ")}.${shipMsg}`,
    ...(labelUrl ? { label_url: labelUrl } : {}),
  };
}

function page(title: string, message: string) {
  return `<!doctype html><html lang="no"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} – Garnly</title>
<style>body{font-family:system-ui,sans-serif;background:#F7F2EA;color:#2A2522;margin:0;padding:2rem}main{max-width:520px;margin:3rem auto;background:#fff;border-radius:24px;padding:2rem;box-shadow:0 2px 12px rgba(0,0,0,.06)}h1{color:#5F0B09;font-size:1.5rem}</style></head>
<body><main><h1>${title}</h1><p>${message}</p><p style="color:#888;font-size:.9rem">Garnly ordreruting</p></main></body></html>`;
}
