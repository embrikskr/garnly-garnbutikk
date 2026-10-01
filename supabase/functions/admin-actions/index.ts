/**
 * admin-actions: handlingene Garnly-admin kan gjøre på en ordre som har stoppet opp.
 *
 *   POST { action: "gi_til_butikk", group_id, store_id } + Authorization: Bearer <admin-JWT>
 *   POST { action: "prov_ruting",   group_id }
 *
 * Logikken ligger i _shared/offers.ts. Her er bare tilgang og transport.
 *
 * **Tilgangen sjekkes mot garnly_admins, ikke mot store_users.** En butikkbruker som finner
 * URL-en skal få 403, uansett hvor mange butikker hen hører til. Viewene i 025 filtrerer
 * selv på is_garnly_admin() og gir butikkbrukere null rader, men et endepunkt som *endrer*
 * noe kan ikke lene seg på det – her må det sjekkes eksplisitt.
 *
 * Kanseller er med vilje ikke en handling her: refusjon og kansellering skal gjøres av et
 * menneske i Shopify. Panelet lenker dit i stedet.
 */
import { adminClient, json } from "../_shared/db.ts";
import { cors } from "../_shared/cors.ts";
import { provRutingPaNytt, tildelManuelt } from "../_shared/offers.ts";

Deno.serve(async (req) => {
  const CORS = cors(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ ok: false, melding: "method not allowed" }, 405, CORS);

  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ ok: false, melding: "ikke innlogget" }, 401, CORS);

  const db = adminClient();
  const { data: auth, error: authErr } = await db.auth.getUser(jwt);
  if (authErr || !auth?.user) return json({ ok: false, melding: "ikke innlogget" }, 401, CORS);

  const { data: admin } = await db.from("garnly_admins").select("user_id, name").eq("user_id", auth.user.id).maybeSingle();
  if (!admin) return json({ ok: false, melding: "Krever Garnly-admin" }, 403, CORS);

  const av = auth.user.email ?? admin.name ?? auth.user.id;
  const body = await req.json().catch(() => ({}));
  if (!body.group_id) return json({ ok: false, melding: "group_id mangler" }, 400, CORS);

  try {
    if (body.action === "gi_til_butikk") {
      if (!body.store_id) return json({ ok: false, melding: "store_id mangler" }, 400, CORS);
      return json(await tildelManuelt(body.group_id, body.store_id, av), 200, CORS);
    }
    if (body.action === "prov_ruting") {
      return json(await provRutingPaNytt(body.group_id, av), 200, CORS);
    }
    return json({ ok: false, melding: `Ukjent handling: ${body.action}` }, 400, CORS);
  } catch (e) {
    const melding = e instanceof Error ? e.message : String(e);
    console.error("[admin-actions]", body.action, melding);
    return json({ ok: false, melding }, 500, CORS);
  }
});
