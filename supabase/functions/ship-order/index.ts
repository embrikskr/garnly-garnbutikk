/**
 * ship-order: «Slått ut og klar til sending» i butikkpanelet.
 *
 *   POST { group_id, kun_uttrekk? } + Authorization: Bearer <bruker-JWT>
 *
 * Hele forretningslogikken ligger i _shared/ship.ts. Her er bare tilgang og transport.
 *
 * Tilgang i to lag: brukeren må høre til butikken gruppen er tildelt (samme sjekk som
 * fraktetiketten), og kassauttrekket kalles med brukerens egen JWT, så mark_pos_deducted
 * gjør sin egen sjekk også. Service-role-klienten brukes bare til det panelet ikke skal
 * kunne røre selv.
 */
import { adminClient, json } from "../_shared/db.ts";
import { cors } from "../_shared/cors.ts";
import { sendOrdre } from "../_shared/ship.ts";

Deno.serve(async (req) => {
  const CORS = cors(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ ok: false, melding: "method not allowed" }, 405, CORS);

  const body = await req.json().catch(() => ({}));
  if (!body.group_id) return json({ ok: false, melding: "group_id mangler" }, 400, CORS);

  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ ok: false, melding: "ikke innlogget" }, 401, CORS);

  const db = adminClient();
  const { data: auth, error: authErr } = await db.auth.getUser(jwt);
  if (authErr || !auth?.user) return json({ ok: false, melding: "ikke innlogget" }, 401, CORS);

  const { data: group } = await db.from("routing_groups").select("id, assigned_store_id, status").eq("id", body.group_id).maybeSingle();
  if (!group?.assigned_store_id) return json({ ok: false, melding: "Fant ikke ordren" }, 404, CORS);

  const { data: tilgang } = await db.from("store_users").select("store_id")
    .eq("user_id", auth.user.id).eq("store_id", group.assigned_store_id).maybeSingle();
  if (!tilgang) return json({ ok: false, melding: "Ingen tilgang til denne ordren" }, 403, CORS);

  if (group.status === "cancelled") return json({ ok: false, melding: "Ordren er kansellert." }, 409, CORS);

  const utfall = await sendOrdre(body.group_id, jwt, body.kun_uttrekk === true);
  // 200 også når et steg feilet: svaret sier hva som er gjort og hva som gjenstår, og
  // panelet viser det. En naken 500 ville skjult at kassauttrekket faktisk gikk gjennom.
  return json(utfall, 200, CORS);
});
