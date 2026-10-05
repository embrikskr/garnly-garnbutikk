/**
 * shipping-label: fraktetiketten fra ikonet på kortet i panelet.
 *
 *   POST { group_id } + Authorization: Bearer <bruker-JWT>
 *     → application/pdf                      butikk uten DirectPrint-skriver
 *     → { ok: true, etikett: "skriver" }     etiketten er sendt til skriveren
 *
 * I «Til pakking» lages sendingen i Cargonizer her hvis den ikke finnes, uten overføring til
 * PostNord. Selve jobben ligger i _shared/etikett.ts; her er bare tilgang og transport.
 *
 * API-nøkkelen forlater aldri serveren. Cargonizers PDF-URL-er «is only accessible trough an API
 * call. It can not be referenced directly», så panelet kan ikke lenke rett dit uansett.
 *
 * Tilgang: brukeren må høre til butikken gruppen er tildelt. Uten den sjekken kunne én butikk
 * skrevet ut en annen butikks fraktetiketter, med navn og adresse til deres kunder.
 */
import { adminClient, json } from "../_shared/db.ts";
import { cors } from "../_shared/cors.ts";
import { lagEtikett } from "../_shared/etikett.ts";

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

  const { data: group } = await db.from("routing_groups").select("id, assigned_store_id").eq("id", body.group_id).maybeSingle();
  if (!group?.assigned_store_id) return json({ ok: false, message: "Fant ikke ordren" }, 404, CORS);

  const { data: tilgang } = await db.from("store_users").select("store_id")
    .eq("user_id", auth.user.id).eq("store_id", group.assigned_store_id).maybeSingle();
  if (!tilgang) return json({ ok: false, message: "Ingen tilgang til denne ordren" }, 403, CORS);

  const u = await lagEtikett(group.id);
  if (!u.ok) {
    console.error("[shipping-label]", group.id, u.melding);
    return json({ ok: false, message: u.melding }, u.status, CORS);
  }
  if (u.via === "skriver") return json({ ok: true, etikett: "skriver", consignment_id: u.consignmentId }, 200, CORS);
  return new Response(u.pdf, {
    status: 200,
    headers: {
      ...CORS,
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${u.filnavn}"`,
      "Cache-Control": "no-store",
    },
  });
});
