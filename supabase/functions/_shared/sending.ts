/**
 * Sendingen i Cargonizer for én gruppe: finn den som finnes, eller lag en.
 *
 * Felles for to knapper i panelet:
 *   - etikett-ikonet i «Til pakking» (_shared/etikett.ts), så butikken kan skrive ut etiketten
 *     mens de pakker
 *   - «Slått ut og klar til sending» (_shared/ship.ts), som gjenbruker sendingen fra etiketten
 *
 * Sendingen lages ALLTID med `transfer=false`. PostNord får beskjed først når pakken er slått
 * ut og sendt – det gjør sendeflyten med transfer_sync, ett sted, for alle sendinger likt.
 *
 * Rekkefølgen er kravet: lagret id først, så oppslag på ordrenummeret, og først hvis ingen av
 * delene gir treff lager vi en ny. To trykk tett i tid skal ikke gi to sendinger: selve
 * opprettelsen er låst per gruppe (`routing_groups.consignment_lock_at`).
 */
import { adminClient, audit } from "./db.ts";
import {
  finnConsignment,
  finnServicePartnere,
  hentConsignment,
  opprettConsignment,
  type CargonizerConsignment,
  type ServicePartnerRad,
  sokFra,
  transferBeslutning,
} from "./shipping/cargonizer.ts";
import {
  byggConsignmentXml,
  innholdstekst,
  maksVektKg,
  mobilnummer,
  produkterForVekt,
  sporingsnummer,
  vektKg,
} from "./shipping/consignment.ts";

/** Transportøren vi sender med. Navnet må skrives slik Shopify kjenner det igjen. */
export const TRANSPORTOR = "PostNord";
/** Tjenester på sendingen. Parcel Locker tilbyr bare denne ene. */
const TJENESTER = ["postnord_notification_sms"];
/** En lås eldre enn dette regnes som etterlatt av et kall som døde underveis. */
const LAS_MINUTTER = 2;
/** Så lenge venter et kall på at et annet blir ferdig med sendingen. Å lage én tar 2–5 s. */
const VENT_SEKUNDER = 20;

export interface Kontekst {
  group: {
    id: string;
    routing_order_id: string;
    status: string;
    created_at: string;
    line_items: Array<{ qty: number; title?: string | null; product_id?: string | null }> | null;
    shopify_fulfillment_order_id: string | null;
    pos_deducted_at: string | null;
    fulfilled_at: string | null;
    cargonizer_consignment_id: number | null;
    shipped_at: string | null;
    transferred_at: string | null;
    label_printed_at: string | null;
  };
  ordre: { shopify_order_name: string | null; is_test: boolean; status: string | null; customer: Record<string, unknown> | null };
  butikk: {
    name: string | null;
    shipping_sender_id: string | null;
    shipping_transport_agreement: string | null;
    shipping_product: string | null;
    shipping_product_fallback: string | null;
    directprint_printer_id: string | null;
  };
}

function ett<T>(v: T | T[] | null | undefined): T | null {
  return (Array.isArray(v) ? v[0] : v) ?? null;
}

export async function hentKontekst(groupId: string): Promise<Kontekst | null> {
  const { data } = await adminClient()
    .from("routing_groups")
    .select(
      "id, routing_order_id, status, created_at, line_items, shopify_fulfillment_order_id, pos_deducted_at, fulfilled_at, " +
        "cargonizer_consignment_id, shipped_at, transferred_at, label_printed_at, " +
        "routing_orders(shopify_order_name, is_test, status, customer), " +
        "stores:assigned_store_id(name, shipping_sender_id, shipping_transport_agreement, shipping_product, shipping_product_fallback, directprint_printer_id)",
    )
    .eq("id", groupId)
    .maybeSingle();
  if (!data) return null;
  const rå = data as unknown as Record<string, unknown>;
  const ordre = ett(rå.routing_orders as Kontekst["ordre"] | Kontekst["ordre"][]);
  const butikk = ett(rå.stores as Kontekst["butikk"] | Kontekst["butikk"][]);
  if (!ordre || !butikk) return null;
  return { group: rå as unknown as Kontekst["group"], ordre, butikk };
}

/** Er ordren kansellert i Shopify? Da skal det verken lages sending eller sendes noe. */
export function erKansellert(k: Kontekst): boolean {
  return k.group.status === "cancelled" || k.ordre.status === "cancelled";
}

export const KANSELLERT = "Ordren er kansellert i Shopify. Ikke send pakken.";

/**
 * Sendingen som alt finnes for gruppen: på lagret id, ellers på ordrenummeret. Lager ingenting.
 *
 * Funnet sending lagres på gruppen. Steg 3 i sendeflyten skal tåle å kjøres om igjen: stoppet
 * forrige forsøk mellom «sending laget» og «sending lagret», er det her det blir rettet.
 */
export async function finnEksisterendeSending(k: Kontekst): Promise<CargonizerConsignment | null> {
  const senderId = k.butikk.shipping_sender_id;
  if (!senderId) throw new Error("Butikken mangler Cargonizer-avsender. Kontakt Garnly.");

  if (k.group.cargonizer_consignment_id) {
    const kjent = await hentConsignment(k.group.cargonizer_consignment_id, senderId);
    if (kjent) {
      await lagreSending(k, kjent, null);
      return kjent;
    }
    // Lagret id som ikke finnes lenger: sendingen er slettet i Cargonizer. Da leter vi videre.
  }
  // Bare sendinger laget etter at gruppen kom inn: ordrenummer gjentar seg (se sokFra).
  const funnet = await finnConsignment(k.ordre.shopify_order_name ?? "", senderId, sokFra(k.group.created_at));
  if (funnet) {
    await lagreSending(k, funnet, null);
    return funnet;
  }
  return null;
}

/** Sendingen for gruppen – den som finnes, eller en ny (ikke overført). */
export async function sikreSending(
  k: Kontekst,
  vent = true,
): Promise<{ sending: CargonizerConsignment; pakkeboks: ServicePartnerRad | null; ny: boolean }> {
  const finnes = await finnEksisterendeSending(k);
  if (finnes) return { sending: finnes, pakkeboks: null, ny: false };

  // Ingen sending: lag en, men bare én av gangen per gruppe. Uten låsen ville to trykk på
  // etikett-ikonet – eller ikonet og sendeknappen – gitt to sendinger med samme ordrenummer.
  const db = adminClient();
  const grense = new Date(Date.now() - LAS_MINUTTER * 60_000).toISOString();
  const { data: las } = await db.from("routing_groups")
    .update({ consignment_lock_at: new Date().toISOString() })
    .eq("id", k.group.id)
    .or(`consignment_lock_at.is.null,consignment_lock_at.lt.${grense}`)
    .select("id");
  if (!las?.length) {
    if (!vent) throw new Error("Sendingen lages akkurat nå. Vent et øyeblikk og prøv igjen.");
    // Noen lager den akkurat nå. Vent og bruk den, i stedet for å feile: trykker butikken på
    // etiketten og rett etterpå «Slått ut og klar til sending», skal sendeknappen ikke stoppe
    // med «Kontakt Garnly» og havne under «Trenger handling» for noe som ordner seg selv.
    for (let i = 0; i < VENT_SEKUNDER; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const { data: g } = await db.from("routing_groups")
        .select("cargonizer_consignment_id, consignment_lock_at").eq("id", k.group.id).single();
      if (g?.cargonizer_consignment_id && g.cargonizer_consignment_id !== k.group.cargonizer_consignment_id) {
        const laget = await hentConsignment(g.cargonizer_consignment_id, k.butikk.shipping_sender_id!);
        if (laget) return { sending: laget, pakkeboks: null, ny: false };
      }
      // Den andre ga opp uten sending. Prøv selv, så feilen butikken ser er den riktige.
      if (!g?.consignment_lock_at) break;
    }
    return await sikreSending(k, false);
  }
  try {
    // Den som hadde låsen før oss kan ha rukket å lage og lagre sendingen.
    const { data: nå } = await db.from("routing_groups").select("cargonizer_consignment_id").eq("id", k.group.id).single();
    if (nå?.cargonizer_consignment_id && nå.cargonizer_consignment_id !== k.group.cargonizer_consignment_id) {
      const laget = await hentConsignment(nå.cargonizer_consignment_id, k.butikk.shipping_sender_id!);
      if (laget) return { sending: laget, pakkeboks: null, ny: false };
    }
    const r = await lagSending(k);
    return { ...r, ny: true };
  } finally {
    await db.from("routing_groups").update({ consignment_lock_at: null }).eq("id", k.group.id);
  }
}

async function lagSending(k: Kontekst): Promise<{ sending: CargonizerConsignment; pakkeboks: ServicePartnerRad }> {
  const senderId = k.butikk.shipping_sender_id!;
  const orderName = k.ordre.shopify_order_name ?? "";
  const kunde = (k.ordre.customer ?? {}) as Record<string, string | null>;
  const land = (kunde.countryCodeV2 || "NO").toUpperCase();
  const postnr = (kunde.zip ?? "").trim();
  if (!postnr) throw new Error("Ordren mangler postnummer, så vi finner ingen pakkeboks.");

  const mobil = mobilnummer(kunde.phone);
  if (!mobil) {
    // Pakkeboks krever mobilnummer (consignee_mobile_required). Hentested gjør ikke det, men
    // vi stopper likevel, med vilje: mobil er påkrevd i kassen, så en ordre uten mobil betyr at
    // noe er galt med ordren. Det skal Garnly se på, ikke sendingen gå rundt (Embrik 01.10.2026).
    throw new Error("Ordren mangler mobilnummer, som er påkrevd i kassen. Kontakt Garnly.");
  }

  const ta = k.butikk.shipping_transport_agreement;
  const hovedprodukt = k.butikk.shipping_product;
  if (!ta || !hovedprodukt) throw new Error("Butikken mangler transportavtale for frakt. Kontakt Garnly.");

  // Vekten avgjør hvilke produkter som er aktuelle, og må derfor regnes ut FØR vi leter
  // etter pakkested. Over 10 kg tar ikke pakkeboksen den, og da skal vi rett til hentested –
  // ikke finne en boks i nærheten og stoppe der.
  const vekt = await beregnVekt(k);
  const reserve = k.butikk.shipping_product_fallback;
  const alle = [hovedprodukt, ...(reserve && reserve !== hovedprodukt ? [reserve] : [])];
  const produkter = produkterForVekt(vekt, alle);
  if (!produkter.length) {
    const grenser = alle.map(maksVektKg).filter((m): m is number => m !== null);
    const maks = grenser.length ? Math.max(...grenser) : null;
    throw new Error(maks !== null
      ? `Pakken veier ${vekt} kg, og PostNord tar maks ${maks} kg. Kontakt Garnly.`
      : `Pakken veier ${vekt} kg, og ingen av fraktproduktene tar den. Kontakt Garnly.`);
  }

  // Pakkeboks først. Finnes ingen i nærheten, vanlig hentested (Service Point / MyPack
  // Collect) på samme avtale. Pakkebokser finnes ikke overalt: 9990 Båtsfjord, 9760
  // Honningsvåg og 8700 Nesna har ingen, men fem hentesteder hver (sjekket 01.10.2026).
  let produkt = produkter[0];
  let pakkeboks: ServicePartnerRad | null = null;
  for (const p of produkter) {
    const partnere = await finnServicePartnere(senderId, {
      transportAgreementId: ta,
      product: p,
      postcode: postnr,
      country: land,
      address: kunde.address1,
      city: kunde.city,
    });
    if (partnere[0]) {
      produkt = p;
      pakkeboks = partnere[0];
      break;
    }
  }
  if (!pakkeboks) {
    const bareHentested = !produkter.includes(hovedprodukt);
    throw new Error(
      produkter.length > 1
        ? `Fant verken pakkeboks eller hentested nær ${postnr}. Kontakt Garnly.`
        : bareHentested
        ? `Pakken veier ${vekt} kg, for tungt for pakkeboks, og det finnes ikke hentested nær ${postnr}. Kontakt Garnly.`
        : `Fant ingen pakkeboks nær ${postnr}. Kontakt Garnly.`,
    );
  }

  const xml = byggConsignmentXml({
    transportAgreementId: ta,
    product: produkt,
    // Aldri overført her – se filhodet.
    transfer: false,
    reference: orderName,
    consignee: {
      name: kunde.name ?? "",
      address1: kunde.address1,
      address2: kunde.address2,
      postcode: postnr,
      city: kunde.city ?? "",
      country: land,
      email: kunde.email,
      mobile: mobil,
    },
    servicePartner: {
      number: pakkeboks.number,
      name: pakkeboks.name,
      address1: pakkeboks.address1,
      postcode: pakkeboks.postcode,
      city: pakkeboks.city,
      country: pakkeboks.country,
    },
    vektKg: vekt,
    innhold: innholdstekst(k.group.line_items ?? []),
    services: TJENESTER,
  });

  const laget = await opprettConsignment(xml, senderId);
  // Produktet følger med pakkestedet, så det står hvorfor kunden fikk hentested og ikke boks.
  await lagreSending(k, laget, { ...pakkeboks, produkt } as ServicePartnerRad, true);
  await audit("routing_group", k.group.id, "consignment_created", {
    produkt,
    consignment_id: laget.id,
    order: orderName,
    vekt_kg: vekt,
    pakkeboks: pakkeboks.name,
    overfort: false,
  });
  return { sending: laget, pakkeboks };
}

export async function lagreSending(k: Kontekst, c: CargonizerConsignment, pakkeboks: ServicePartnerRad | null, ny = false) {
  const nummer = sporingsnummer(c.trackingUrl, c.numberWithChecksum);
  const beslutning = transferBeslutning(c);
  await adminClient().from("routing_groups").update({
    cargonizer_consignment_id: c.id,
    shipment_id: c.numberWithChecksum,
    tracking_number: nummer,
    tracking_url: c.trackingUrl,
    carrier: TRANSPORTOR,
    // Er den alt meldt inn, står tidspunktet. Er den ikke det, gjør sendeflyten det (eller
    // backstoppen i timeout-sweeper) – vi later ikke som om den er overført.
    ...(beslutning.handling === "allerede" ? { transferred_at: beslutning.tidspunkt ?? new Date().toISOString() } : {}),
    ...(pakkeboks ? { service_partner: pakkeboks } : {}),
    // En ny sending har en ny etikett. «Etikett skrevet ut» gjaldt den gamle (slettet i
    // Cargonizer), og skal ikke hindre at den nye blir skrevet ut.
    ...(ny ? { label_printed_at: null, label_printed_via: null } : {}),
  }).eq("id", k.group.id);
  k.group.cargonizer_consignment_id = c.id;
  if (ny) k.group.label_printed_at = null;
  // Tidspunktet skal være da sendingen ble laget, ikke da vi sist så på den.
  await adminClient().from("routing_groups")
    .update({ shipped_at: new Date().toISOString() }).eq("id", k.group.id).is("shipped_at", null);
}

/** Vekt fra Shopify (products.grams), med fallback per vare. Se shipping/consignment.ts. */
async function beregnVekt(k: Kontekst): Promise<number> {
  const linjer = k.group.line_items ?? [];
  const ids = linjer.map((l) => l.product_id).filter(Boolean) as string[];
  const gram = new Map<string, number | null>();
  if (ids.length) {
    const { data } = await adminClient().from("products").select("id, grams").in("id", ids);
    for (const p of (data ?? []) as Array<{ id: string; grams: number | null }>) gram.set(p.id, p.grams);
  }
  return vektKg(linjer.map((l) => ({ qty: l.qty, grams: l.product_id ? gram.get(l.product_id) ?? null : null })));
}
