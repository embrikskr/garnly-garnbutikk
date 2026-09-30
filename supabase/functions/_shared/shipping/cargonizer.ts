/**
 * Cargonizer (Logistra): finn sendingen for en ordre, og hent fraktetiketten som PDF.
 *
 * Garnly oppretter ikke sendinger. Butikken lager dem i CargonizerConnect i Shopify. Vi leser
 * bare – dette er for butikkene som ikke har etikettskriver og trenger PDF-en i panelet.
 *
 * Verifisert mot ekte API 30.09.2026 (sending 76295361, referanse TEST-1002, avsender 25846):
 *   GET /consignments.xml?text=<ordrenummer>            → sendingen, med <id>
 *   GET /consignments/label_pdf?consignment_ids[]=<id>  → 47 kB PDF, også når state=open
 *
 * Svaret har FLERE <id>-elementer: sendingen har sin egen, og hver <bundle> har sin.
 * Sendingens id er direkte barn av <consignment>; buntens ligger under <bundles><bundle>.
 * Derfor parser vi XML-en ordentlig – en regex over svaret ville plukket buntens id.
 *
 * Fire ting som ikke er åpenbare:
 *
 * 1. `text=` treffer DELSTRENG av avsenders referanse. `text=1002` fant «TEST-1002», og ville
 *    like gjerne funnet «10021» og «21002». Derfor filtrerer vi på eksakt lik referanse i
 *    `velgConsignment` – ellers sender vi kunden en annen kundes etikett.
 * 2. Søk på sporingsnummer eller sendingsnummer gir ingen treff. Bare avsenders referanse.
 * 3. Sendingen må slås opp med avsender-ID-en til butikken som laget den
 *    (`stores.shipping_sender_id`), ikke en vilkårlig.
 * 4. Etiketten er gyldig før overføring til transportør (`state = open`), så butikken kan
 *    hente den med en gang.
 */
import { XMLParser } from "npm:fast-xml-parser@4";

// Begge vertsnavn svarer likt (verifisert 30.09.2026 med samme nøkkel og samme sending).
// api.cargonizer.no er det dokumenterte, så det er standarden.
const BASE = Deno.env.get("CARGONIZER_BASE_URL") ?? "https://api.cargonizer.no";

export interface CargonizerConsignment {
  id: number;
  consignorReference: string;
  /** «open» = ikke overført til transportør. */
  state: string | null;
  trackingUrl: string | null;
}

/**
 * Sendingen som hører til ordren, av alle søket returnerte.
 *
 * REN logikk. Kravet er eksakt treff på avsenders referanse: søket i Cargonizer treffer
 * delstreng, så et søk på «1002» kan svare med sendinger for «10021» og «21002». Sender vi
 * feil etikett, går pakken til feil kunde.
 *
 * Finnes flere med samme referanse – butikken har laget sendingen om igjen – tar vi den
 * nyeste (høyeste id). Den gamle er da gjerne slettet eller erstattet.
 */
export function velgConsignment(
  kandidater: CargonizerConsignment[],
  ordrereferanse: string | string[],
): CargonizerConsignment | null {
  // Flere godtatte skrivemåter fordi vi ikke vet om CargonizerConnect skriver «#1002» eller
  // «1002» i avsenders referanse. Begge godtas; det er fortsatt eksakt likhet, ikke delstreng.
  const refs = (Array.isArray(ordrereferanse) ? ordrereferanse : [ordrereferanse])
    .map((r) => r.trim())
    .filter(Boolean);
  if (!refs.length) return null;
  const treff = kandidater.filter((c) => refs.includes((c.consignorReference ?? "").trim()));
  if (!treff.length) return null;
  return treff.reduce((a, b) => (b.id > a.id ? b : a));
}

/**
 * Skrivemåter av ordrenavnet vi godtar som avsenders referanse.
 * Shopify kaller ordren «#1002»; om appen skriver med eller uten firkant er ikke bekreftet.
 */
export function referanseVarianter(orderName: string): string[] {
  const n = (orderName ?? "").trim();
  if (!n) return [];
  const utenFirkant = n.replace(/^#/, "");
  return [...new Set([n, utenFirkant])].filter(Boolean);
}

/** Selve søkeordet: uten firkant, siden Cargonizer-søket uansett treffer delstreng. */
export function sokeord(orderName: string): string {
  return (orderName ?? "").trim().replace(/^#/, "");
}

/** Parser svaret fra /consignments.xml. REN logikk, så den kan testes uten nett. */
export function parseConsignments(xml: string): CargonizerConsignment[] {
  const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true });
  const doc = parser.parse(xml);
  const rot = doc?.consignments?.consignment;
  if (!rot) return [];
  const liste = Array.isArray(rot) ? rot : [rot];
  return liste
    .map((c: Record<string, unknown>) => ({
      // Vi leser id-en fra selve consignment-noden. Kolliene under <pieces> har sine egne
      // id-er; en regex over hele svaret ville plukket feil tall.
      id: Number(c.id),
      consignorReference: String(c["consignor-reference"] ?? ""),
      state: c.state != null ? String(c.state) : null,
      trackingUrl: c["tracking-url"] != null ? String(c["tracking-url"]) : null,
    }))
    .filter((c) => Number.isFinite(c.id) && c.id > 0);
}

function headers(senderId: string): Record<string, string> {
  const key = Deno.env.get("CARGONIZER_KEY");
  if (!key) throw new Error("CARGONIZER_KEY mangler");
  return { "X-Cargonizer-Key": key, "X-Cargonizer-Sender": senderId };
}

/**
 * Finner sendingen for et ordrenummer hos én avsender.
 * `fra` begrenser søket bakover i tid: standard datovindu for consignments.xml er ikke
 * dokumentert, så vi ber om et vindu i stedet for å stole på det.
 */
export async function finnConsignment(
  orderName: string,
  senderId: string,
  fra?: Date,
): Promise<CargonizerConsignment | null> {
  const url = new URL(`${BASE}/consignments.xml`);
  url.searchParams.set("text", sokeord(orderName));
  if (fra) url.searchParams.set("from", fra.toISOString().slice(0, 10));

  const res = await fetch(url, { headers: headers(senderId) });
  if (!res.ok) throw new Error(`Cargonizer-søk feilet: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return velgConsignment(parseConsignments(await res.text()), referanseVarianter(orderName));
}

/** Henter etiketten som PDF. Virker også når sendingen ikke er overført ennå. */
export async function hentEtikett(consignmentId: number, senderId: string): Promise<ArrayBuffer> {
  const url = new URL(`${BASE}/consignments/label_pdf`);
  url.searchParams.append("consignment_ids[]", String(consignmentId));

  const res = await fetch(url, { headers: headers(senderId) });
  if (!res.ok) throw new Error(`Cargonizer-etikett feilet: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("pdf")) {
    // Cargonizer svarer 200 med XML-feil i noen tilfeller. Uten denne sjekken ville butikken
    // fått en «PDF» som ikke lar seg åpne, uten å skjønne hvorfor.
    throw new Error(`Cargonizer ga ikke PDF (${type}): ${(await res.text()).slice(0, 200)}`);
  }
  return await res.arrayBuffer();
}
