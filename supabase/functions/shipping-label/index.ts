/**
 * shipping-label: gir butikken fraktetiketten som PDF.
 *
 * For butikker uten etikettskriver. Sendingen lages i CargonizerConnect som før; vi henter
 * bare PDF-en ut av Cargonizer og leverer den til panelet.
 *
 *   POST { group_id } + Authorization: Bearer <bruker-JWT>  → application/pdf
 *
 * API-nøkkelen forlater aldri serveren. Cargonizers dokumentasjon er tydelig på at PDF-URL-ene
 * «is only accessible trough an API call. It can not be referenced directly», så panelet kan
 * ikke lenke rett dit uansett – og skulle ikke fått nøkkelen selv om det gikk.
 *
 * Tilgang: brukeren må høre til butikken gruppen er tildelt. Uten den sjekken kunne én butikk
 * lastet ned en annen butikks fraktetiketter, med navn og adresse til deres kunder.
 */
import { adminClient, audit, json } from "../_shared/db.ts";
import { finnConsignment, hentEtikett, SOKEVINDU_DAGER } from "../_shared/shipping/cargonizer.ts";
import { cors } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  const CORS = cors(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405, CORS);

  const body = await req.json().catch(() => ({}));
  if (!body.group_id) return json({ ok: false, message: "group_id mangler" }, 400, CORS);

  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ ok: false, message: "ikke innlogget" }, 401, CORS);

  const db = adminClient();
  const { data: auth, error: authErr } = await db.auth.getUser(jwt);
  if (authErr || !auth?.user) return json({ ok: false, message: "ikke innlogget" }, 401, CORS);

  const { data: group } = await db
    .from("routing_groups")
    .select("id, assigned_store_id, cargonizer_consignment_id, created_at, routing_orders(shopify_order_name)")
    .eq("id", body.group_id)
    .maybeSingle();
  if (!group?.assigned_store_id) return json({ ok: false, message: "Fant ikke ordren" }, 404, CORS);

  const { data: tilgang } = await db
    .from("store_users")
    .select("store_id")
    .eq("user_id", auth.user.id)
    .eq("store_id", group.assigned_store_id)
    .maybeSingle();
  if (!tilgang) return json({ ok: false, message: "Ingen tilgang til denne ordren" }, 403, CORS);

  const { data: store } = await db.from("stores").select("name, shipping_sender_id").eq("id", group.assigned_store_id).single();
  if (!store?.shipping_sender_id) {
    return json({ ok: false, message: "Butikken mangler Cargonizer-avsender. Kontakt Garnly." }, 409, CORS);
  }

  const ordre = (group as { routing_orders?: { shopify_order_name?: string } | Array<{ shopify_order_name?: string }> }).routing_orders;
  const orderName = (Array.isArray(ordre) ? ordre[0]?.shopify_order_name : ordre?.shopify_order_name) ?? "";

  try {
    // Id-en lagres første gang, så vi slipper å søke på nytt hver gang butikken åpner etiketten.
    let consignmentId = group.cargonizer_consignment_id as number | null;
    if (!consignmentId) {
      const fra = new Date(new Date(group.created_at).getTime() - SOKEVINDU_DAGER * 86400_000);
      const funnet = await finnConsignment(orderName, store.shipping_sender_id, fra);
      if (!funnet) {
        return json({
          ok: false,
          code: "ikke_funnet",
          message: `Fant ingen sending på ${orderName} i Cargonizer. Er den laget i CargonizerConnect ennå?`,
        }, 404, CORS);
      }
      consignmentId = funnet.id;
      await db.from("routing_groups").update({ cargonizer_consignment_id: consignmentId }).eq("id", group.id);
      await audit("routing_group", group.id, "cargonizer_matched", { consignment_id: consignmentId, state: funnet.state });
    }

    const pdf = await hentEtikett(consignmentId, store.shipping_sender_id);
    return new Response(pdf, {
      status: 200,
      headers: {
        ...CORS,
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="fraktetikett-${orderName.replace(/[^\w-]/g, "")}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[shipping-label]", orderName, msg);
    await audit("routing_group", group.id, "label_failed", { error: msg });
    return json({ ok: false, message: `Fikk ikke hentet etiketten: ${msg}` }, 502, CORS);
  }
});
