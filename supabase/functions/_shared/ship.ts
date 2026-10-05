/**
 * «Slått ut og klar til sending» – hele veien fra butikkens knapp til ferdig pakke.
 *
 * Butikkene har ikke tilgang til Shopify-admin, så de kunne ikke trykke «Fulfill with
 * CargonizerConnect». Og selv når noen gjorde det, ble sendingen aldri overført til PostNord
 * (appen har bare automatisk overføring på Home Small). Ett trykk i panelet gjør nå alt:
 *
 *   1. kassauttrekket (mark_pos_deducted, med butikkbrukerens egen JWT – samme tilgangssjekk)
 *   2. sendingen i Cargonizer, med pakkeboks, vekt og SMS-varsling – den fra etiketten hvis
 *      den finnes, ellers en ny
 *   3. lagring av sendings-id, sendingsnummer, sporingsnummer og sporingslenke
 *   4. fulfillment i Shopify med sporing, som varsler kunden
 *   4b. overføring til PostNord (transfer_sync)
 *   5. etiketten: til DirectPrint-skriveren hvis Garnly har satt en opp for butikken og den
 *      ikke alt er skrevet ut, ellers ingenting – butikken henter PDF-en med ikonet på kortet
 *
 * **Hvert steg tåler å kjøres på nytt.** Feiler steg 2, 3 eller 4, står det som er gjort, og
 * butikken kan trykke «Prøv igjen». Før vi lager en sending, leter vi etter en som finnes
 * fra før – på sendings-id vi har lagret, ellers på ordrenummeret. Før vi fulfiller, spør vi
 * Shopify om det gjenstår noe. Uten de to sjekkene ville et nytt trykk gitt kunden to pakker
 * og to sporingsnumre.
 *
 * Etiketten kan skrives ut før dette, fra ikonet i «Til pakking» (_shared/etikett.ts). Da finnes
 * sendingen alt, uten å være overført, og den gjenbrukes her. **Overføringen til PostNord skjer
 * først her**, etter fulfillment – ikke når etiketten skrives ut, for da er pakken ikke klar.
 * Etiketten skrives ikke ut på nytt hvis den alt er skrevet ut.
 *
 * Testordrer overføres aldri: sendingen opprettes i Cargonizer, men ingenting går til PostNord.
 */
import { adminClient, audit, userClient } from "./db.ts";
import { createFulfillment, getFulfillmentOrder } from "./shopify.ts";
import { type CargonizerConsignment, type ServicePartnerRad, skrivUtEtikett } from "./shipping/cargonizer.ts";
import { sporingsnummer } from "./shipping/consignment.ts";
import { reconcileFulfilledAt } from "./fulfillment_sync.ts";
import { overfoerGruppe, type TransferUtfall } from "./transfer_sync.ts";
import { erKansellert, hentKontekst, KANSELLERT, type Kontekst, sikreSending, TRANSPORTOR } from "./sending.ts";

export type Steg = "uttrekk" | "sending" | "fulfillment" | "etikett";

export interface SendUtfall {
  ok: boolean;
  steg?: Steg;
  melding?: string;
  /**
   * Etiketten: skrevet ut direkte nå, klar som PDF i panelet, eller alt skrevet ut fra
   * «Til pakking» – da skrives den ikke ut en gang til, og panelet sier ingenting om den.
   */
  etikett?: "skriver" | "pdf" | "allerede";
  /** Overføringen til transportør: overført nå, alt overført, hoppet over (testordre), eller feilet. */
  overforing?: TransferUtfall["status"];
  utfort: { uttrekk: boolean; sending: boolean; fulfillment: boolean };
  consignment_id?: number | null;
  tracking_number?: string | null;
  tracking_url?: string | null;
  pakkeboks?: { name: string; address1: string; postcode: string; city: string } | null;
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
  // Kansellert etter at etiketten ble laget: ingenting skal skje, heller ikke kassauttrekket.
  if (erKansellert(k)) return { ok: false, steg: "uttrekk", melding: KANSELLERT, utfort: tomt() };

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
  // Finnes sendingen fra etiketten, brukes den. Ellers lages den nå – uten overføring, den
  // kommer i steg 4b, etter fulfillment, for alle sendinger likt.
  let sending: CargonizerConsignment;
  let pakkeboks: ServicePartnerRad | null = null;
  let nySending = false;
  try {
    const r = await sikreSending(k);
    sending = r.sending;
    pakkeboks = r.pakkeboks;
    nySending = r.ny;
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

  // ---- 4b. overføring til PostNord ------------------------------------------
  // Etter fulfillment, ikke før: feiler overføringen, er gruppen sendt, og backstoppen i
  // timeout-sweeper prøver videre (den ser bare på sendte grupper). Webhooken for fulfillment
  // kan treffe samme gruppe i samme sekund; overfoerGruppe tar forsøket med en betinget
  // oppdatering, så bare én melder den inn. Testordrer hoppes over der.
  let overforing: TransferUtfall["status"];
  try {
    overforing = (await overfoerGruppe(groupId)).status;
  } catch (e) {
    // Pakken er sendt og kunden varslet; overføringen tar backstoppen. Ikke stopp her.
    console.error("[ship] overføring feilet", groupId, e instanceof Error ? e.message : e);
    overforing = "feilet";
  }

  // ---- 5. etiketten --------------------------------------------------------
  let etikett: "skriver" | "pdf" | "allerede" = "pdf";
  if (k.group.label_printed_at && !nySending) {
    // Skrevet ut fra «Til pakking». En etikett til ville bare blitt liggende ved skriveren.
    // Er sendingen ny, gjaldt den utskriften en annen (slettet) sending, og da skrives den ut.
    etikett = "allerede";
  } else if (k.butikk.directprint_printer_id && k.butikk.shipping_sender_id) {
    try {
      await skrivUtEtikett(sending.id, k.butikk.directprint_printer_id, k.butikk.shipping_sender_id);
      etikett = "skriver";
      await db.from("routing_groups")
        .update({ label_printed_at: new Date().toISOString(), label_printed_via: "skriver" }).eq("id", groupId);
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
    overforing,
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
