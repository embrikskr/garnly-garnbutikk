/**
 * REN logikk for å lage en Cargonizer-sending: XML-en, vekten og sporingsnummeret.
 *
 * Ingen I/O, så alt her kan testes uten nett. Selve kallene ligger i cargonizer.ts.
 *
 * Tallene under er ikke gjettet. De er lest ut av transport_agreements.xml for PostNord
 * «Parcel Locker» (postnord_mypack_small), avsender 25849, 30.09.2026:
 *   min_items 1, max_items 1      → nøyaktig ett <item>, aldri flere
 *   max_weight 10 (kg)            → tyngre pakker kan ikke sendes som pakkeboks
 *   requires_weight_or_volume     → vekt må oppgis
 *   requires_service_partner      → pakkeboksen må følge med
 *   consignee_mobile_required     → mobilnummer er påkrevd, ikke valgfritt
 *   item_types                    → bare «package»
 *   services                      → bare postnord_notification_sms
 */

/** Emballasje: konvolutt eller eske, teip. Lagt til én gang per sending. */
export const EMBALLASJE_GRAM = 150;
/**
 * Vekt per vare når Shopify ikke har den. Et nøste garn veier typisk 50 g; 100 g er satt
 * med margin, siden en sending som veier mindre enn oppgitt aldri blir avvist – en som
 * veier mer kan bli det.
 */
export const FALLBACK_VARE_GRAM = 100;
/**
 * Vektgrenser per PostNord-produkt, i kg.
 *
 * Parcel Locker oppgir 10 kg i transport_agreements.xml. Service Point oppgir ingen der, så
 * grensen er funnet ved å spørre Cargonizer selv: /consignment_costs.xml tar samme XML som en
 * ekte sending, men oppretter ingenting. Sjekket 01.10.2026 mot begge butikkenes avtaler
 * (37187 og 37185):
 *   postnord_mypack_small  10,00 kg godtatt, 10,01 kg avvist («kan ikke veie mer enn 10 Kg»)
 *   mypack                 35,00 kg godtatt, 35,01 kg avvist («Kolli … mer enn 35 Kg»)
 * Metoden ble kalibrert mot pakkeboksgrensen først, som vi kjente fra avtalen.
 */
export const MAKS_VEKT_KG = 10;
export const MAKS_VEKT_KG_HENTESTED = 35;

/** Vektgrensen for et produkt, eller null når vi ikke kjenner den. REN logikk. */
export function maksVektKg(produkt: string): number | null {
  if (produkt === "postnord_mypack_small") return MAKS_VEKT_KG;
  if (produkt === "mypack") return MAKS_VEKT_KG_HENTESTED;
  return null;
}

/**
 * Produktene som tar en pakke på denne vekten, i prioritert rekkefølge. REN logikk.
 *
 * Pakkeboks først, så hentested. Er pakken over 10 kg, faller pakkeboksen ut av lista før vi
 * leter etter pakkested – ellers ville vi funnet en boks som ikke tar den, og stoppet.
 */
export function produkterForVekt(vektKg: number, produkter: string[]): string[] {
  return produkter.filter((p) => {
    const maks = maksVektKg(p);
    return maks === null || vektKg <= maks;
  });
}

export interface VektLinje {
  qty: number;
  /** Vekt per enhet i gram, fra Shopify via products.grams. Null når den ikke er satt. */
  grams?: number | null;
}

/**
 * Sendingens vekt i kg.
 *
 * Avrundes opp til to desimaler: Cargonizer tar imot desimaler, og et tall som er litt for
 * høyt koster ingenting, mens et som er for lavt kan gi avvik i innleveringen.
 */
export function vektKg(linjer: VektLinje[]): number {
  const gram = linjer.reduce((sum, l) => {
    const per = l.grams && l.grams > 0 ? l.grams : FALLBACK_VARE_GRAM;
    return sum + Math.max(0, l.qty) * per;
  }, EMBALLASJE_GRAM);
  return Math.ceil(gram / 10) / 100;
}

/** Kort innholdsbeskrivelse på etiketten. Kuttes, så den ikke sprenger feltet. */
export function innholdstekst(linjer: Array<{ qty: number; title?: string | null }>): string {
  const tekst = linjer.map((l) => `${l.qty} × ${(l.title ?? "").trim()}`.trim()).filter(Boolean).join(", ");
  if (!tekst) return "Garn";
  return tekst.length > 100 ? tekst.slice(0, 97) + "..." : tekst;
}

/**
 * Sporingsnummeret kunden finner igjen hos PostNord.
 *
 * Cargonizer gir oss tre tall som ligner: `number`, `number-with-checksum` og en
 * `tracking-url`. Det er det siste leddet i URL-en PostNord faktisk søker på – for #1004 var
 * det 70727320855841324, mens number-with-checksum var 40170727320855841324. Vi tar derfor
 * tallet fra URL-en når den finnes, og faller tilbake på sendingsnummeret ellers.
 */
export function sporingsnummer(trackingUrl: string | null, numberWithChecksum: string | null): string | null {
  if (trackingUrl) {
    const siste = trackingUrl.split("?")[0].split("/").filter(Boolean).pop() ?? "";
    if (/^\d{6,}$/.test(siste)) return siste;
  }
  return numberWithChecksum || null;
}

/** &, <, >, " og ' må escapes, ellers svarer Cargonizer 500 på navn som «Bull & Co». */
export function escapeXml(v: string | null | undefined): string {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * Mobilnummer slik Cargonizer vil ha det.
 *
 * Shopify gir «+4795331315». Vi beholder landkoden, men fjerner mellomrom og bindestreker:
 * de er det eneste vi vet at ikke hører hjemme der. Vi skriver ikke om nummeret utover det –
 * et nummer vi har «rettet» feil er verre enn ett vi lot stå.
 */
export function mobilnummer(raw: string | null | undefined): string | null {
  const n = String(raw ?? "").replace(/[\s\-()]/g, "");
  return /^\+?\d{6,15}$/.test(n) ? n : null;
}

export interface Part {
  name: string;
  address1?: string | null;
  address2?: string | null;
  postcode: string;
  city: string;
  country: string;
  email?: string | null;
  mobile?: string | null;
}

export interface ServicePartner {
  number: string;
  name: string;
  address1: string;
  postcode: string;
  city: string;
  country: string;
}

export interface ConsignmentInput {
  transportAgreementId: string;
  /** Produktidentifikator fra transportavtalen, f.eks. postnord_mypack_small. */
  product: string;
  /** true = meld inn til transportøren med én gang. false for testordrer. */
  transfer: boolean;
  /** Avsenders referanse. Ordrenummeret, i Shopify-format («#1004»). */
  reference: string;
  consignee: Part;
  servicePartner: ServicePartner | null;
  vektKg: number;
  innhold: string;
  services: string[];
}

/**
 * Bygger XML-en for én sending.
 *
 * Nøyaktig ett <item>: produktet tillater bare ett kolli, og hele varelinjen kommer uansett
 * fra samme butikk (garnpartiregelen), så det er alltid én pakke.
 */
export function byggConsignmentXml(i: ConsignmentInput): string {
  const e = escapeXml;
  const part = (tag: string, p: Part | ServicePartner, ekstra = "") =>
    [
      `    <${tag}>`,
      ekstra,
      `      <name>${e(p.name)}</name>`,
      "address1" in p && p.address1 ? `      <address1>${e(p.address1)}</address1>` : "",
      "address2" in p && p.address2 ? `      <address2>${e(p.address2)}</address2>` : "",
      `      <postcode>${e(p.postcode)}</postcode>`,
      `      <city>${e(p.city)}</city>`,
      `      <country>${e(p.country)}</country>`,
      "email" in p && p.email ? `      <email>${e(p.email)}</email>` : "",
      "mobile" in p && p.mobile ? `      <mobile>${e(p.mobile)}</mobile>` : "",
      `    </${tag}>`,
    ].filter(Boolean).join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<consignments>",
    `  <consignment transport_agreement="${e(i.transportAgreementId)}" print="false" estimate="false">`,
    "    <values>",
    '      <value name="provider" value="Garnly" />',
    '      <value name="provider-email" value="post@garnly.no" />',
    `      <value name="orderno" value="${e(i.reference)}" />`,
    "    </values>",
    `    <transfer>${i.transfer}</transfer>`,
    "    <booking_request>false</booking_request>",
    `    <product>${e(i.product)}</product>`,
    "    <parts>",
    part("consignee", i.consignee),
    i.servicePartner
      ? part("service_partner", i.servicePartner, `      <number>${e(i.servicePartner.number)}</number>`)
      : "",
    "    </parts>",
    "    <items>",
    `      <item type="package" amount="1" weight="${i.vektKg}" description="${e(i.innhold)}"/>`,
    "    </items>",
    i.services.length
      ? ["    <services>", ...i.services.map((s) => `      <service id="${e(s)}" />`), "    </services>"].join("\n")
      : "",
    "    <references>",
    `      <consignor>${e(i.reference)}</consignor>`,
    "    </references>",
    "  </consignment>",
    "</consignments>",
  ].filter(Boolean).join("\n");
}

/**
 * Vekt fra Shopify om til hele gram.
 *
 * Shopify svarer med `{ value, unit }`, der enheten er GRAMS, KILOGRAMS, OUNCES eller
 * POUNDS. Regner vi feil her, går det rett inn i fraktbestillingen, så alle fire er med.
 * Null og negative verdier forkastes: «0 gram» i Shopify betyr at vekten ikke er satt.
 */
export function gramFraShopify(value: unknown, unit: unknown): number | null {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return null;
  const faktor: Record<string, number> = { GRAMS: 1, KILOGRAMS: 1000, OUNCES: 28.349523125, POUNDS: 453.59237 };
  const f = faktor[String(unit ?? "GRAMS").toUpperCase()];
  if (!f) return null;
  return Math.round(v * f);
}
