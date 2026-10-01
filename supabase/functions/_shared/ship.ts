/**
 * «Slått ut og klar til sending» – hele veien fra butikkens knapp til ferdig pakke.
 *
 * Butikkene har ikke tilgang til Shopify-admin, så de kunne ikke trykke «Fulfill with
 * CargonizerConnect». Og selv når noen gjorde det, ble sendingen aldri overført til PostNord
 * (appen har bare automatisk overføring på Home Small). Ett trykk i panelet gjør nå alt:
 *
 *   1. kassauttrekket (mark_pos_deducted, med butikkbrukerens egen JWT – samme tilgangssjekk)
 *   2. sendingen i Cargonizer, med pakkeboks, vekt, SMS-varsling og overføring til PostNord
 *   3. lagring av sendings-id, sendingsnummer, sporingsnummer og sporingslenke
 *   4. fulfillment i Shopify med sporing, som varsler kunden
 *   5. etiketten: til DirectPrint-skriveren hvis Garnly har satt en opp for butikken, ellers
 *      ingenting – butikken henter PDF-en med ikonet på kortet når de vil
 *
 * **Hvert steg tåler å kjøres på nytt.** Feiler steg 2, 3 eller 4, står det som er gjort, og
 * butikken kan trykke «Prøv igjen». Før vi lager en sending, leter vi etter en som finnes
 * fra før – på sendings-id vi har lagret, ellers på ordrenummeret. Før vi fulfiller, spør vi
 * Shopify om det gjenstår noe. Uten de to sjekkene ville et nytt trykk gitt kunden to pakker
 * og to sporingsnumre.
 *
 * Testordrer får `transfer=false`: sendingen opprettes i Cargonizer, men ingenting går til
 * PostNord.
 */
import { adminClient, audit, userClient } from "./db.ts";
import { createFulfillment, getFulfillmentOrder } from "./shopify.ts";
import {
  finnConsignment,
  finnServicePartnere,
  hentConsignment,
  opprettConsignment,
  type CargonizerConsignment,
  type ServicePartnerRad,
  skrivUtEtikett,
  SOKEVINDU_DAGER,
  transferBeslutning,
} from "./shipping/cargonizer.ts";
import {
  byggConsignmentXml,
  innholdstekst,
  MAKS_VEKT_KG,
  mobilnummer,
  sporingsnummer,
  vektKg,
} from "./shipping/consignment.ts";
import { reconcileFulfilledAt } from "./fulfillment_sync.ts";

/** Transportøren vi sender med. Navnet må skrives slik Shopify kjenner det igjen. */
const TRANSPORTOR = "PostNord";
/** Tjenester på sendingen. Parcel Locker tilbyr bare denne ene. */
const TJENESTER = ["postnord_notification_sms"];

export type Steg = "uttrekk" | "sending" | "fulfillment" | "etikett";

export interface SendUtfall {
  ok: boolean;
  steg?: Steg;
  melding?: string;
  /** Hvor etiketten havnet: skrevet ut direkte, eller klar som PDF i panelet. */
  etikett?: "skriver" | "pdf";
  utfort: { uttrekk: boolean; sending: boolean; fulfillment: boolean };
  consignment_id?: number | null;
  tracking_number?: string | null;
  tracking_url?: string | null;
  pakkeboks?: { name: string; address1: string; postcode: string; city: string } | null;
}

interface Kontekst {
  group: {
    id: string;
    routing_order_id: string;
    created_at: string;
    line_items: Array<{ qty: number; title?: string | null; product_id?: string | null }> | null;
    shopify_fulfillment_order_id: string | null;
    pos_deducted_at: string | null;
    fulfilled_at: string | null;
    cargonizer_consignment_id: number | null;
    shipped_at: string | null;
  };
  ordre: { shopify_order_name: string | null; is_test: boolean; customer: Record<string, unknown> | null };
  butikk: {
    name: string | null;
    shipping_sender_id: string | null;
    shipping_transport_agreement: string | null;
    shipping_product: string | null;
    directprint_printer_id: string | null;
  };
}

function ett<T>(v: T | T[] | null | undefined): T | null {
  return (Array.isArray(v) ? v[0] : v) ?? null;
}

/**
 * Hele flyten.
 *
 * Det fantes en reserveknapp her («sendt på annen måte – registrer bare kassauttrekk»). Den
 * er fjernet: den registrerte uttrekket, men ordren ble stående som `assigned`, kortet ble
 * liggende i pakkelista, og Shopify fikk aldri vite at pakken var sendt. Feiler sendingen nå,
 * ser butikken feilen og «Kontakt Garnly», og ordren dukker opp i admin under «Trenger
 * handling». Fulfilles den manuelt i Shopify, lukker webhooken den av seg selv.
 */
export async function sendOrdre(groupId: string, jwt: string): Promise<SendUtfall> {
  const db = adminClient();
  const k = await hentKontekst(groupId);
  if (!k) return { ok: false, steg: "uttrekk", melding: "Fant ikke ordren", utfort: tomt() };

  const utfort = {
    uttrekk: !!k.group.pos_deducted_at,
    sending: !!k.group.cargonizer_consignment_id,
    fulfillment: !!k.group.fulfilled_at,
  };

  // ---- 1. kassauttrekk -----------------------------------------------------
  if (!k.group.pos_deducted_at) {
    const { error } = await userClient(jwt).rpc("mark_pos_deducted", { p_group_id: groupId });
    if (error) return await feil(k, "uttrekk", error.message, utfort);
  }
  utfort.uttrekk = true;

  // ---- 2 og 3. sending i Cargonizer, og lagring ----------------------------
  let sending: CargonizerConsignment;
  let pakkeboks: ServicePartnerRad | null = null;
  try {
    const r = await sikreSending(k);
    sending = r.sending;
    pakkeboks = r.pakkeboks;
  } catch (e) {
    return await feil(k, "sending", e instanceof Error ? e.message : String(e), utfort);
  }
  utfort.sending = true;

  const nummer = sporingsnummer(sending.trackingUrl, sending.numberWithChecksum);

  // ---- 4. fulfillment i Shopify -------------------------------------------
  if (!k.group.fulfilled_at) {
    try {
      await fulfill(k, nummer, sending.trackingUrl);
    } catch (e) {
      return await feil(k, "fulfillment", e instanceof Error ? e.message : String(e), utfort);
    }
  }
  utfort.fulfillment = true;

  // ---- 5. etiketten --------------------------------------------------------
  let etikett: "skriver" | "pdf" = "pdf";
  if (k.butikk.directprint_printer_id && k.butikk.shipping_sender_id) {
    try {
      await skrivUtEtikett(sending.id, k.butikk.directprint_printer_id, k.butikk.shipping_sender_id);
      etikett = "skriver";
    } catch (e) {
      // Etiketten er det eneste steget butikken kan ordne selv: PDF-en ligger på kortet.
      // Å la hele sendingen framstå som mislykket fordi skriveren er av, ville vært verre.
      console.error("[ship] direkteutskrift feilet", groupId, e instanceof Error ? e.message : e);
    }
  }

  await db.from("routing_groups").update({ ship_error: null, ship_step: null }).eq("id", groupId);
  return {
    ok: true,
    etikett,
    utfort,
    consignment_id: sending.id,
    tracking_number: nummer,
    tracking_url: sending.trackingUrl,
    pakkeboks: pakkeboks ? { name: pakkeboks.name, address1: pakkeboks.address1, postcode: pakkeboks.postcode, city: pakkeboks.city } : null,
  };
}

// ---------------------------------------------------------------------------

function tomt() {
  return { uttrekk: false, sending: false, fulfillment: false };
}

async function hentKontekst(groupId: string): Promise<Kontekst | null> {
  const { data } = await adminClient()
    .from("routing_groups")
    .select(
      "id, routing_order_id, created_at, line_items, shopify_fulfillment_order_id, pos_deducted_at, fulfilled_at, " +
        "cargonizer_consignment_id, shipped_at, " +
        "routing_orders(shopify_order_name, is_test, customer), " +
        "stores:assigned_store_id(name, shipping_sender_id, shipping_transport_agreement, shipping_product, directprint_printer_id)",
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

/** Skriver feilen på gruppen, så panelet kan vise den, og gir svaret tilbake. */
async function feil(k: Kontekst, steg: Steg, melding: string, utfort: SendUtfall["utfort"]): Promise<SendUtfall> {
  console.error("[ship]", steg, k.ordre.shopify_order_name ?? k.group.id, melding);
  await adminClient().from("routing_groups")
    .update({ ship_step: steg, ship_error: melding.slice(0, 500) })
    .eq("id", k.group.id);
  await audit("routing_group", k.group.id, "ship_failed", { steg, error: melding, order: k.ordre.shopify_order_name });
  return { ok: false, steg, melding, utfort };
}

/**
 * Sendingen for denne gruppen – den som finnes, eller en ny.
 *
 * Rekkefølgen er kravet: lagret id først, så oppslag på ordrenummeret, og først hvis ingen
 * av delene gir treff lager vi en ny. Cargonizers søk treffer delstreng, så oppslaget krever
 * eksakt lik referanse (se velgConsignment).
 */
async function sikreSending(k: Kontekst): Promise<{ sending: CargonizerConsignment; pakkeboks: ServicePartnerRad | null }> {
  const db = adminClient();
  const senderId = k.butikk.shipping_sender_id;
  if (!senderId) throw new Error("Butikken mangler Cargonizer-avsender. Kontakt Garnly.");
  const orderName = k.ordre.shopify_order_name ?? "";

  if (k.group.cargonizer_consignment_id) {
    const kjent = await hentConsignment(k.group.cargonizer_consignment_id, senderId);
    if (kjent) {
      // Lagres på nytt selv om sendingen fantes fra før. Steg 3 skal tåle å kjøres om igjen:
      // stoppet forrige forsøk mellom «sending laget» og «sending lagret», er det her det
      // blir rettet. Det samme gjelder sendinger CargonizerConnect laget i overgangen –
      // de har verken sendingsnummer eller transportør hos oss.
      await lagreSending(k, kjent, null);
      return { sending: kjent, pakkeboks: null };
    }
    // Lagret id som ikke finnes lenger: sendingen er slettet i Cargonizer. Da lager vi ny.
  }
  const fra = new Date(new Date(k.group.created_at).getTime() - SOKEVINDU_DAGER * 86400_000);
  const funnet = await finnConsignment(orderName, senderId, fra);
  if (funnet) {
    await lagreSending(k, funnet, null);
    return { sending: funnet, pakkeboks: null };
  }

  // ---- ingen sending finnes: lag en ----
  const kunde = (k.ordre.customer ?? {}) as Record<string, string | null>;
  const land = (kunde.countryCodeV2 || "NO").toUpperCase();
  const postnr = (kunde.zip ?? "").trim();
  if (!postnr) throw new Error("Ordren mangler postnummer, så vi finner ingen pakkeboks.");

  const mobil = mobilnummer(kunde.phone);
  if (!mobil) {
    // Produktet krever mobilnummer (consignee_mobile_required). Uten det svarer Cargonizer
    // med en feil butikken ikke kan gjøre noe med, så vi sier det tydelig i stedet.
    throw new Error("Ordren mangler mobilnummer, og PostNord pakkeboks krever det. Kontakt Garnly.");
  }

  const ta = k.butikk.shipping_transport_agreement;
  const produkt = k.butikk.shipping_product;
  if (!ta || !produkt) throw new Error("Butikken mangler transportavtale for frakt. Kontakt Garnly.");

  const partnere = await finnServicePartnere(senderId, {
    transportAgreementId: ta,
    product: produkt,
    postcode: postnr,
    country: land,
    address: kunde.address1,
    city: kunde.city,
  });
  const pakkeboks = partnere[0] ?? null;
  if (!pakkeboks) throw new Error(`Fant ingen pakkeboks nær ${postnr}. Kontakt Garnly.`);

  const vekt = await beregnVekt(k);
  if (vekt > MAKS_VEKT_KG) {
    throw new Error(`Pakken veier ${vekt} kg, og PostNord pakkeboks tar maks ${MAKS_VEKT_KG} kg. Kontakt Garnly.`);
  }

  const xml = byggConsignmentXml({
    transportAgreementId: ta,
    product: produkt,
    // Testordrer opprettes, men meldes aldri inn til PostNord.
    transfer: !k.ordre.is_test,
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
  await lagreSending(k, laget, pakkeboks);
  await audit("routing_group", k.group.id, "consignment_created", {
    consignment_id: laget.id,
    order: orderName,
    vekt_kg: vekt,
    pakkeboks: pakkeboks.name,
    overfort: !k.ordre.is_test,
  });
  return { sending: laget, pakkeboks };
}

async function lagreSending(k: Kontekst, c: CargonizerConsignment, pakkeboks: ServicePartnerRad | null) {
  const nummer = sporingsnummer(c.trackingUrl, c.numberWithChecksum);
  const beslutning = transferBeslutning(c);
  await adminClient().from("routing_groups").update({
    cargonizer_consignment_id: c.id,
    shipment_id: c.numberWithChecksum,
    tracking_number: nummer,
    tracking_url: c.trackingUrl,
    carrier: TRANSPORTOR,
    // Er den alt meldt inn, står tidspunktet. Er den ikke det, tar backstoppen i
    // timeout-sweeper den – vi later ikke som om den er overført.
    ...(beslutning.handling === "allerede" ? { transferred_at: beslutning.tidspunkt ?? new Date().toISOString() } : {}),
    ...(pakkeboks ? { service_partner: pakkeboks } : {}),
  }).eq("id", k.group.id);
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

/**
 * Fulfiller i Shopify, hvis det gjenstår noe å fulfille.
 *
 * Gjenstår ingenting, er ordren alt sendt – da henter vi tidspunktet fra Shopify i stedet
 * for å lage en sending til.
 */
async function fulfill(k: Kontekst, nummer: string | null, url: string | null) {
  const foId = k.group.shopify_fulfillment_order_id;
  if (!foId) throw new Error("Gruppen mangler fulfillment order i Shopify.");

  const fo = await getFulfillmentOrder(foId);
  if (!fo || fo.remaining <= 0 || fo.status === "CLOSED") {
    await reconcileFulfilledAt(k.group.routing_order_id);
    return;
  }

  const f = await createFulfillment(foId, nummer ? { number: nummer, url: url ?? undefined, company: TRANSPORTOR } : undefined);
  const nå = f.createdAt ?? new Date().toISOString();
  await adminClient().from("routing_groups").update({
    fulfilled_at: nå,
    status: "fulfilled",
    ...(nummer ? { tracking_number: nummer } : {}),
    ...(url ? { tracking_url: url } : {}),
    carrier: TRANSPORTOR,
  }).eq("id", k.group.id).is("fulfilled_at", null);
  await audit("routing_group", k.group.id, "fulfilled", {
    at: nå, order: k.ordre.shopify_order_name, tracking: nummer, carrier: TRANSPORTOR, av: "panel",
  });
}
