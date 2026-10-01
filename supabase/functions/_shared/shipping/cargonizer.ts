/**
 * Cargonizer (Logistra): finn sendingen for en ordre, hent fraktetiketten, og overfør
 * sendingen til transportøren.
 *
 * Garnly oppretter ikke sendinger. Butikken lager dem i CargonizerConnect i Shopify. Men
 * appen *overfører* dem ikke: den har bare en innstilling for automatisk overføring på
 * «Home Small main shipment», ikke på pakkeboks. Uten overføring får transportøren aldri
 * EDI-en, og sporingsnummeret på ordren er dødt. Derfor gjør vi det (se transfer_sync.ts).
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
  /** Satt når sendingen er overført. Tom til den er det. */
  transferAt: string | null;
  /** Sendingsnummeret. Brukes som sporingsnummer når tracking-url mangler. */
  numberWithChecksum: string | null;
}

/**
 * Hvor langt bakover i tid vi ber Cargonizer søke når vi ikke har sendings-id-en fra før.
 * Deres standardvindu for consignments.xml er ikke dokumentert, så vi ber om et vindu selv.
 * Verifisert 30.09.2026: `from=` treffer minst tre år tilbake.
 */
export const SOKEVINDU_DAGER = 60;

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

/**
 * Tom streng er ikke en verdi. Cargonizer skriver tomme felt som `<transfer-at nil="true"/>`,
 * som parseren gir oss som "". Uten denne ville «ikke overført» sett ut som en verdi.
 */
function tekst(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
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
      state: tekst(c.state),
      trackingUrl: tekst(c["tracking-url"]),
      transferAt: tekst(c["transfer-at"]),
      numberWithChecksum: tekst(c["number-with-checksum"]) ?? tekst(c.number),
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

// ---------------------------------------------------------------------------
// Overføring til transportør
// ---------------------------------------------------------------------------

/**
 * Tilstander vi vet hva betyr. Alt annet behandles som ukjent og overføres ikke:
 * å gjette på en tilstand vi aldri har sett kan bety å melde inn samme pakke to ganger.
 */
const APEN = "open";
const ALLEREDE_OVERFORT = new Set(["transferred", "closed"]);

export type TransferBeslutning =
  | { handling: "overfor" }
  | { handling: "allerede"; tidspunkt: string | null }
  | { handling: "ukjent"; state: string | null };

/**
 * Skal denne sendingen overføres nå? REN logikk.
 *
 * `transfer-at` er sterkere enn `state`: er tidspunktet satt, er sendingen meldt inn,
 * uansett hva tilstanden heter. Da skal vi ikke melde den inn en gang til.
 */
export function transferBeslutning(c: Pick<CargonizerConsignment, "state" | "transferAt">): TransferBeslutning {
  if (c.transferAt) return { handling: "allerede", tidspunkt: c.transferAt };
  const s = (c.state ?? "").trim().toLowerCase();
  if (ALLEREDE_OVERFORT.has(s)) return { handling: "allerede", tidspunkt: null };
  if (s === APEN) return { handling: "overfor" };
  return { handling: "ukjent", state: c.state };
}

/** Feilmeldingene i et <errors>-svar. REN logikk. */
export function parseErrors(xml: string): string[] {
  const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true });
  const feil = parser.parse(xml)?.errors?.error;
  if (feil == null) return [];
  return (Array.isArray(feil) ? feil : [feil]).map((f: unknown) => String(f)).filter(Boolean);
}

/** Én sending, slått opp på id. Brukes når vi alt har lagret id-en. */
export async function hentConsignment(consignmentId: number, senderId: string): Promise<CargonizerConsignment | null> {
  const res = await fetch(`${BASE}/consignments/${consignmentId}.xml`, { headers: headers(senderId) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Cargonizer-oppslag feilet: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return parseConsignments(await res.text())[0] ?? null;
}

/**
 * Melder sendingene inn til transportøren.
 *
 * To ting som ikke er åpenbare, begge verifisert mot ekte API 30.09.2026:
 *
 * 1. `.xml`-endelsen er nødvendig. Uten den svarer Cargonizer 302 til forsiden, som er en
 *    HTML-404 – og et `fetch` som følger redirecter ville lest det som 404-side, ikke feil.
 *    Med `.xml` kommer 400 og <errors><error>Denne handlingen kunne ikke utføres …</error>.
 * 2. Cargonizer dokumenterer 302 som et gyldig svar, så vi godtar det. Derfor følger vi
 *    ikke redirecten: statusen er svaret.
 *
 * Kaster ved feil. Kallet er trygt å gjenta – den som kaller sjekker tilstanden først, og
 * verifiserer etterpå ved å lese sendingen på nytt.
 */
export async function overfoerConsignments(consignmentIds: number[], senderId: string): Promise<void> {
  if (!consignmentIds.length) return;
  const url = new URL(`${BASE}/consignments/transfer.xml`);
  for (const id of consignmentIds) url.searchParams.append("consignment_ids[]", String(id));

  const res = await fetch(url, { method: "POST", headers: headers(senderId), redirect: "manual" });
  if (res.ok || res.status === 302) {
    await res.body?.cancel();
    return;
  }
  const kropp = await res.text();
  const feil = parseErrors(kropp);
  throw new Error(`Cargonizer-overføring feilet: ${res.status} ${feil.length ? feil.join("; ") : kropp.slice(0, 200)}`);
}

// ---------------------------------------------------------------------------
// Opprette sending, finne pakkeboks, skrive ut
// ---------------------------------------------------------------------------

export interface ServicePartnerRad {
  number: string;
  name: string;
  address1: string;
  postcode: string;
  city: string;
  country: string;
  /** Meter fra mottakerens adresse. Lista kommer sortert, nærmeste først. */
  distanceM: number | null;
}

/** Parser svaret fra /service_partners.xml. REN logikk. */
export function parseServicePartners(xml: string): ServicePartnerRad[] {
  const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true });
  const rot = parser.parse(xml)?.results?.["service-partners"]?.["service-partner"];
  if (!rot) return [];
  const liste = Array.isArray(rot) ? rot : [rot];
  return liste
    .map((p: Record<string, unknown>) => ({
      number: String(p.number ?? "").trim(),
      name: String(p.name ?? "").trim(),
      address1: String(p.address1 ?? "").trim(),
      postcode: String(p.postcode ?? "").trim(),
      city: String(p.city ?? "").trim(),
      country: String(p.country ?? "NO").trim(),
      distanceM: Number.isFinite(Number(p.distance)) ? Number(p.distance) : null,
    }))
    .filter((p) => p.number && p.name);
}

/**
 * Pakkeboksene nærmest mottakeren, nærmest først.
 *
 * `address` er med fordi postnummeret alene gir dårligere treff: Cargonizer sender adressen
 * videre til PostNords egen «nearest by address»-tjeneste.
 */
export async function finnServicePartnere(
  senderId: string,
  opts: { transportAgreementId: string; product: string; postcode: string; country: string; address?: string | null; city?: string | null },
): Promise<ServicePartnerRad[]> {
  const url = new URL(`${BASE}/service_partners.xml`);
  url.searchParams.set("transport_agreement_id", opts.transportAgreementId);
  url.searchParams.set("product", opts.product);
  url.searchParams.set("country", opts.country);
  url.searchParams.set("postcode", opts.postcode);
  if (opts.address) url.searchParams.set("address", opts.address);
  if (opts.city) url.searchParams.set("city", opts.city);

  const res = await fetch(url, { headers: headers(senderId) });
  if (!res.ok) throw new Error(`Fant ingen pakkebokser: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return parseServicePartners(await res.text());
}

/**
 * Oppretter sendingen. Kaster med Cargonizers egen feiltekst hvis noe mangler.
 *
 * Svaret er den ferdige sendingen, med id, sendingsnummer og sporingslenke.
 */
export async function opprettConsignment(xml: string, senderId: string): Promise<CargonizerConsignment> {
  const res = await fetch(`${BASE}/consignments.xml`, {
    method: "POST",
    headers: { ...headers(senderId), "Content-Type": "application/xml" },
    body: xml,
  });
  const kropp = await res.text();
  if (!res.ok) {
    const feil = parseErrors(kropp);
    throw new Error(feil.length ? feil.join("; ") : `Cargonizer svarte ${res.status}: ${kropp.slice(0, 300)}`);
  }
  const laget = parseConsignments(kropp)[0];
  if (!laget) {
    // 200 uten sending i svaret: da har vi ikke noe å lagre, og må ikke late som det gikk bra.
    const feil = parseErrors(kropp);
    throw new Error(feil.length ? feil.join("; ") : `Cargonizer svarte uten sending: ${kropp.slice(0, 300)}`);
  }
  return laget;
}

export interface Printer {
  id: string;
  name: string;
}

/** Parser /printers.xml. REN logikk. */
export function parsePrintere(xml: string): Printer[] {
  const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true });
  const doc = parser.parse(xml);
  const rot = doc?.printers?.printer ?? doc?.printer ?? null;
  if (!rot) return [];
  const liste = Array.isArray(rot) ? rot : [rot];
  return liste
    .map((p: Record<string, unknown>) => ({ id: String(p.id ?? "").trim(), name: String(p.name ?? "").trim() }))
    .filter((p) => p.id);
}

/**
 * DirectPrint-skriverne på kontoen. Krever nøkkel, men ikke avsender.
 *
 * Brukes av Garnly-admin til å velge skriver for en butikk (`stores.directprint_printer_id`).
 * Butikkene ser ingenting om skrivere – for dem er forskjellen bare om etiketten kommer ut av
 * seg selv eller må hentes med ikonet på kortet.
 */
export async function hentPrintere(senderId: string): Promise<Printer[]> {
  const res = await fetch(`${BASE}/printers.xml`, { headers: headers(senderId) });
  if (!res.ok) throw new Error(`Fikk ikke hentet skrivere: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return parsePrintere(await res.text());
}

/** Sender etiketten til en DirectPrint-skriver. */
export async function skrivUtEtikett(consignmentId: number, printerId: string, senderId: string): Promise<void> {
  const url = new URL(`${BASE}/consignments/label_direct`);
  url.searchParams.set("printer_id", printerId);
  url.searchParams.append("consignment_ids[]", String(consignmentId));

  const res = await fetch(url, { method: "POST", headers: headers(senderId), redirect: "manual" });
  if (res.ok || res.status === 302) {
    await res.body?.cancel();
    return;
  }
  const kropp = await res.text();
  const feil = parseErrors(kropp);
  throw new Error(`Utskrift feilet: ${res.status} ${feil.length ? feil.join("; ") : kropp.slice(0, 200)}`);
}
