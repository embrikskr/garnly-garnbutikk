/**
 * Fraktetiketten fra ikonet på kortet – i «Til pakking» og i «Tidligere ordrer».
 *
 * I «Til pakking» lages sendingen i Cargonizer her, hvis den ikke finnes: samme oppsett som
 * sendeflyten (butikkens avsender og avtale, pakkeboks eller hentested etter vekt, SMS), men
 * ALLTID uten overføring. Butikken skal kunne skrive ut etiketten og teipe den på mens de
 * pakker; PostNord får beskjed først når de trykker «Slått ut og klar til sending».
 *
 * I «Tidligere ordrer» lages ingenting – ordren kan være sendt på annen måte. Der hentes bare
 * etiketten til sendingen som finnes.
 *
 * Har Garnly satt opp en DirectPrint-skriver for butikken (`stores.directprint_printer_id`),
 * går etiketten dit. Ellers får panelet PDF-en. Begge deler teller som «skrevet ut», og
 * sendeknappen skriver den ikke ut en gang til.
 */
import { adminClient, audit } from "./db.ts";
import { hentEtikett, skrivUtEtikett } from "./shipping/cargonizer.ts";
import { erKansellert, finnEksisterendeSending, hentKontekst, KANSELLERT, sikreSending } from "./sending.ts";

export type EtikettUtfall =
  | { ok: true; via: "skriver"; consignmentId: number; ny: boolean }
  | { ok: true; via: "pdf"; consignmentId: number; ny: boolean; pdf: ArrayBuffer; filnavn: string }
  | { ok: false; status: number; melding: string };

export async function lagEtikett(groupId: string): Promise<EtikettUtfall> {
  const k = await hentKontekst(groupId);
  if (!k) return { ok: false, status: 404, melding: "Fant ikke ordren" };
  if (erKansellert(k)) return { ok: false, status: 409, melding: KANSELLERT };
  const senderId = k.butikk.shipping_sender_id;
  if (!senderId) return { ok: false, status: 409, melding: "Butikken mangler Cargonizer-avsender. Kontakt Garnly." };

  const orderName = k.ordre.shopify_order_name ?? "";
  const tilPakking = k.group.status === "assigned" && !k.group.fulfilled_at;

  let consignmentId: number;
  let ny = false;
  try {
    if (tilPakking) {
      const r = await sikreSending(k);
      consignmentId = r.sending.id;
      ny = r.ny;
    } else {
      const finnes = await finnEksisterendeSending(k);
      if (!finnes) {
        return { ok: false, status: 404, melding: `Fant ingen sending på ${orderName} i Cargonizer.` };
      }
      consignmentId = finnes.id;
    }
  } catch (e) {
    const melding = e instanceof Error ? e.message : String(e);
    await audit("routing_group", groupId, "label_failed", { steg: "sending", error: melding, order: orderName });
    return { ok: false, status: 502, melding };
  }

  try {
    if (k.butikk.directprint_printer_id) {
      await skrivUtEtikett(consignmentId, k.butikk.directprint_printer_id, senderId);
      await merkSkrevetUt(groupId, "skriver", consignmentId, ny, orderName);
      return { ok: true, via: "skriver", consignmentId, ny };
    }
    const pdf = await hentEtikett(consignmentId, senderId);
    await merkSkrevetUt(groupId, "pdf", consignmentId, ny, orderName);
    return { ok: true, via: "pdf", consignmentId, ny, pdf, filnavn: `fraktetikett-${orderName.replace(/[^\w-]/g, "")}.pdf` };
  } catch (e) {
    const melding = e instanceof Error ? e.message : String(e);
    await audit("routing_group", groupId, "label_failed", { steg: "etikett", error: melding, order: orderName, consignment_id: consignmentId });
    return { ok: false, status: 502, melding: `Fikk ikke skrevet ut etiketten: ${melding}` };
  }
}

async function merkSkrevetUt(groupId: string, via: "skriver" | "pdf", consignmentId: number, ny: boolean, orderName: string) {
  await adminClient().from("routing_groups")
    .update({ label_printed_at: new Date().toISOString(), label_printed_via: via })
    .eq("id", groupId);
  await audit("routing_group", groupId, "label_printed", { via, consignment_id: consignmentId, ny_sending: ny, order: orderName });
}
