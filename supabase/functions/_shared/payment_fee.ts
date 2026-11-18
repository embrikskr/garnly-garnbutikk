/**
 * Betalingsgebyret for en ordre, lest av Shopifys transaksjoner. REN logikk, ingen I/O.
 *
 * Avtalen med butikkene (punkt 5) trekker «det faktiske gebyret per ordre» fra grunnlaget før
 * det deles. Shopify oppgir gebyret per transaksjon (`OrderTransaction.fees`), men bare for
 * Shopify Payments. Derfor tre utfall:
 *
 *   kjent   – summen av gebyrene på betalingene, i øre
 *   vent    – ordren er ikke betalt ennå, eller Shopify har ikke ført gebyret; prøv igjen
 *   manuelt – betalt på en måte Shopify ikke kjenner gebyret for; må legges inn for hånd
 *
 * Refusjoner gir ikke gebyret tilbake hos Shopify Payments, så REFUND-transaksjoner telles
 * ikke. Gavekort har ikke gebyr. Merverdiavgift på gebyret (taxAmount) er ikke med: grunnlaget
 * regnes uten mva.
 */
import { tilOre } from "./settlement.ts";

export interface FeeTransaction {
  kind: string;
  status: string;
  gateway: string | null;
  fees: Array<{ amount: { amount: string; currencyCode: string } }> | null;
}

export type FeeOutcome =
  | { kind: "kjent"; ore: number }
  | { kind: "vent"; grunn: string }
  | { kind: "manuelt"; grunn: string };

/** Betalingsmåter som aldri har gebyr. */
const UTEN_GEBYR = new Set(["gift_card"]);
/** Betalingen Shopify fører gebyret for. */
const SHOPIFY_PAYMENTS = "shopify_payments";

export function gebyrFraTransaksjoner(transaksjoner: FeeTransaction[], valuta = "NOK"): FeeOutcome {
  // SALE = betalt med én gang. CAPTURE = trukket etter en reservasjon. AUTHORIZATION alene er
  // ikke en betaling.
  const betalinger = transaksjoner.filter(
    (t) => t.status === "SUCCESS" && (t.kind === "SALE" || t.kind === "CAPTURE"),
  );
  if (betalinger.length === 0) return { kind: "vent", grunn: "ingen gjennomført betaling ennå" };

  let ore = 0;
  for (const t of betalinger) {
    const gateway = t.gateway ?? "";
    if (UTEN_GEBYR.has(gateway)) continue;
    if (gateway !== SHOPIFY_PAYMENTS) {
      return { kind: "manuelt", grunn: `betalt med ${gateway || "ukjent betalingsmåte"}; Shopify kjenner ikke gebyret` };
    }
    const gebyrer = t.fees ?? [];
    if (gebyrer.length === 0) return { kind: "vent", grunn: "Shopify har ikke ført gebyret ennå" };
    for (const f of gebyrer) {
      if (f.amount.currencyCode !== valuta) {
        return { kind: "manuelt", grunn: `gebyret står i ${f.amount.currencyCode}, ikke ${valuta}` };
      }
      ore += tilOre(f.amount.amount);
    }
  }
  return { kind: "kjent", ore };
}
