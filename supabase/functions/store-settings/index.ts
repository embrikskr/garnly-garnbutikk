/**
 * store-settings: innstillingene butikken styrer selv fra panelet.
 *
 *   POST { store_id, action: "les" }                                  → gjeldende innstillinger
 *   POST { store_id, action: "lagre", printer_id?, auto_accept? }     → lagrer det som sendes med
 *
 * Krever bruker-JWT, og brukeren må høre til butikken. To ting ligger her:
 *
 * **Etikettskriver.** Cargonizer-nøkkelen forlater aldri serveren; panelet får bare navn og
 * id-er. Id-en som lagres må finnes i lista vi nettopp hentet – uten den sjekken kunne
 * panelet lagre hva som helst, og utskriften ville feilet senere, idet butikken står med
 * pakken i hånda.
 *
 * **Automatisk godkjenning.** `stores.auto_accept` har virket siden 001 (makeNextOffer kaller
 * offer-respond internt), men kunne bare settes med SQL. Nå kan butikken skru den på selv.
 * Lagringen går via serveren og ikke rett på tabellen: panelet skal ikke ha skriverett på
 * `stores`, og endringen skal i revisjonsloggen – den avgjør om ordrer blir butikkens uten
 * at noen har sett på dem.
 *
 * Feiler oppslaget mot Cargonizer, svarer vi likevel ok med tom skriverliste. Ellers ville en
 * nede-situasjon hos Logistra sperret butikken fra å endre auto-godkjenning, som ikke har noe
 * med frakt å gjøre.
 */
import { adminClient, audit, json } from "../_shared/db.ts";
import { cors } from "../_shared/cors.ts";
import { hentPrintere, type Printer } from "../_shared/shipping/cargonizer.ts";

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

  const { data: butikk } = await db.from("stores")
    .select("name, shipping_sender_id, label_printer_id, label_printer_name, auto_accept")
    .eq("id", body.store_id).single();
  if (!butikk) return json({ ok: false, melding: "Fant ikke butikken" }, 404, CORS);

  // Skriverlista er valgfri pynt. Mangler avsender-ID eller er Cargonizer nede, skal resten
  // av innstillingene likevel kunne endres.
  let printere: Printer[] = [];
  let skriverfeil: string | null = null;
  if (butikk.shipping_sender_id) {
    try {
      printere = await hentPrintere(butikk.shipping_sender_id);
    } catch (e) {
      skriverfeil = e instanceof Error ? e.message : String(e);
      console.error("[store-settings] skriverliste", skriverfeil);
    }
  } else {
    skriverfeil = "Butikken mangler Cargonizer-avsender. Kontakt Garnly.";
  }

  const svar = () =>
    json({
      ok: true,
      printere,
      skriverfeil,
      valgt: butikk.label_printer_id ?? null,
      valgt_navn: butikk.label_printer_name ?? null,
      auto_accept: butikk.auto_accept === true,
    }, 200, CORS);

  if (body.action !== "lagre") return svar();

  const endringer: Record<string, unknown> = {};

  if ("printer_id" in body) {
    const valgt = String(body.printer_id ?? "").trim();
    if (valgt && !printere.some((p) => p.id === valgt)) {
      return json({ ok: false, melding: "Ukjent skriver. Hent lista på nytt." }, 400, CORS);
    }
    endringer.label_printer_id = valgt || null;
    endringer.label_printer_name = valgt ? printere.find((p) => p.id === valgt)?.name ?? null : null;
  }

  if ("auto_accept" in body) endringer.auto_accept = body.auto_accept === true;

  if (!Object.keys(endringer).length) return svar();

  const { error } = await db.from("stores").update(endringer).eq("id", body.store_id);
  if (error) return json({ ok: false, melding: error.message }, 500, CORS);

  // Hvem som skrudde på automatisk godkjenning, og når, må kunne spores: fra da av blir
  // ordrer butikkens uten at et menneske har sagt ja.
  await audit("store", body.store_id, "settings_changed", {
    av: auth.user.email ?? auth.user.id,
    butikk: butikk.name,
    ...endringer,
  });

  Object.assign(butikk, endringer);
  return svar();
});
