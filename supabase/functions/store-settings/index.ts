/**
 * store-settings: innstillingen butikken styrer selv.
 *
 *   POST { store_id, action: "les" }                     → gjeldende innstilling
 *   POST { store_id, action: "lagre", auto_accept }      → lagrer den
 *
 * Krever bruker-JWT, og brukeren må høre til butikken.
 *
 * **Automatisk godkjenning** (`stores.auto_accept`) har virket siden 001 – makeNextOffer
 * kaller offer-respond internt – men kunne bare settes med SQL. Lagringen går via serveren og
 * ikke rett på tabellen: panelet skal ikke ha skriverett på `stores`, og endringen skal i
 * revisjonsloggen. Fra det øyeblikket blir ordrer butikkens uten at et menneske har sett
 * på dem.
 *
 * Etikettskriveren lå her før. Den er flyttet ut: DirectPrint er Garnlys oppsett
 * (`stores.directprint_printer_id`), ikke noe butikken skal forholde seg til. Derfor snakker
 * dette endepunktet ikke med Cargonizer i det hele tatt lenger.
 */
import { adminClient, audit, json } from "../_shared/db.ts";
import { cors } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  const CORS = cors(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ ok: false, melding: "method not allowed" }, 405, CORS);

  const body = await req.json().catch(() => ({}));
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ ok: false, melding: "ikke innlogget" }, 401, CORS);

  const db = adminClient();
  const { data: auth, error: authErr } = await db.auth.getUser(jwt);
  if (authErr || !auth?.user) return json({ ok: false, melding: "ikke innlogget" }, 401, CORS);

  if (!body.store_id) return json({ ok: false, melding: "store_id mangler" }, 400, CORS);
  const { data: tilgang } = await db.from("store_users").select("store_id")
    .eq("user_id", auth.user.id).eq("store_id", body.store_id).maybeSingle();
  if (!tilgang) return json({ ok: false, melding: "Ingen tilgang til denne butikken" }, 403, CORS);

  const { data: butikk } = await db.from("stores").select("name, auto_accept").eq("id", body.store_id).single();
  if (!butikk) return json({ ok: false, melding: "Fant ikke butikken" }, 404, CORS);

  if (body.action === "lagre" && "auto_accept" in body) {
    const auto = body.auto_accept === true;
    const { error } = await db.from("stores").update({ auto_accept: auto }).eq("id", body.store_id);
    if (error) return json({ ok: false, melding: error.message }, 500, CORS);
    // Hvem som skrudde den på, og når, må kunne spores.
    await audit("store", body.store_id, "settings_changed", {
      av: auth.user.email ?? auth.user.id,
      butikk: butikk.name,
      auto_accept: auto,
    });
    butikk.auto_accept = auto;
  }

  return json({ ok: true, auto_accept: butikk.auto_accept === true }, 200, CORS);
});
