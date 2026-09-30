/**
 * label-printers: butikkens valg av etikettskriver.
 *
 *   POST { action: "list" }                    → DirectPrint-skriverne på Cargonizer-kontoen
 *   POST { action: "save", printer_id, name }  → lagrer valget på butikken («» = ingen)
 *
 * Krever bruker-JWT, og brukeren må høre til butikken. API-nøkkelen til Cargonizer forlater
 * aldri serveren – panelet får bare navn og id-er.
 *
 * Id-en som lagres må finnes i lista vi nettopp hentet. Uten den sjekken kunne panelet lagre
 * en hvilken som helst streng, og utskriften ville feilet senere, på et tidspunkt der
 * butikken står med pakken i hånda.
 */
import { adminClient, json } from "../_shared/db.ts";
import { cors } from "../_shared/cors.ts";
import { hentPrintere } from "../_shared/shipping/cargonizer.ts";

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

  const { data: butikk } = await db.from("stores").select("shipping_sender_id, label_printer_id, label_printer_name")
    .eq("id", body.store_id).single();
  if (!butikk?.shipping_sender_id) {
    return json({ ok: false, melding: "Butikken mangler Cargonizer-avsender. Kontakt Garnly." }, 409, CORS);
  }

  let printere: Array<{ id: string; name: string }> = [];
  try {
    printere = await hentPrintere(butikk.shipping_sender_id);
  } catch (e) {
    return json({ ok: false, melding: e instanceof Error ? e.message : String(e) }, 502, CORS);
  }

  if (body.action === "save") {
    const valgt = String(body.printer_id ?? "").trim();
    if (valgt && !printere.some((p) => p.id === valgt)) {
      return json({ ok: false, melding: "Ukjent skriver. Hent lista på nytt." }, 400, CORS);
    }
    const navn = valgt ? printere.find((p) => p.id === valgt)?.name ?? null : null;
    await db.from("stores").update({ label_printer_id: valgt || null, label_printer_name: navn }).eq("id", body.store_id);
    return json({ ok: true, printere, valgt: valgt || null, valgt_navn: navn }, 200, CORS);
  }

  return json({ ok: true, printere, valgt: butikk.label_printer_id, valgt_navn: butikk.label_printer_name }, 200, CORS);
});
