/**
 * Oppgjør: hvor mye av en refusjon som trekkes fra hvilken butikk. REN logikk, ingen I/O.
 *
 * Regelen: butikken får varebeløp minus Garnlys provisjon. Frakt tilhører Garnly og er aldri
 * med i butikkens oppgjør – heller ikke når den refunderes. Refunderes varer, trekkes butikken
 * det den fikk for dem: refundert varebeløp × (100 − provisjon) / 100.
 *
 * Her fordeles bare det refunderte VAREBELØPET på gruppene. Provisjonen og avrundingen regnes
 * i databasen (trigger på settlement_adjustments, 031), med samme regnestykke som salget i
 * settlement_ledger. Da går en hel refusjon nøyaktig i null mot salget, øre for øre – to
 * implementasjoner av avrundingen, én i TypeScript og én i SQL, ville ikke gjort det.
 *
 * Alle beløp i øre (heltall) for å slippe flyttallsstøy: 0.1 + 0.2 er ikke 0.3.
 */

/** Shopify-beløp («85.0») til øre. */
export function tilOre(belop: string | number | null | undefined): number {
  const n = Number(belop ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export interface RefusjonLinje {
  variantId: string | null;
  antall: number;
  /** subtotalSet: inkl. mva når butikken har mva-inkluderte priser (taxesIncluded), ellers uten. */
  subtotalOre: number;
  mvaOre: number;
}

export interface Refusjon {
  /** Order.taxesIncluded. Garnlys Shopify har det på (priser inkl. mva). */
  taxesIncluded: boolean;
  /** totalRefundedSet: det kunden faktisk fikk tilbake, alle transaksjoner. */
  totalOre: number;
  linjer: RefusjonLinje[];
  frakt: Array<{ subtotalOre: number; mvaOre: number }>;
}

export interface OppgjorsGruppe {
  id: string;
  status: string;
  storeId: string | null;
  /** Variantene i gruppa. Varelinjene våre har fulfillment order-linjens id, ikke ordrelinjens,
   *  så varianten er det refusjonen kan kobles på. */
  varianter: string[];
}

export interface Trekk {
  groupId: string;
  storeId: string;
  /** Refundert varebeløp inkl. mva, positivt. Databasen gjør det om til trekk. */
  varebelopOre: number;
}

export interface Fordeling {
  trekk: Trekk[];
  /** Varer refundert før noen butikk fikk ordren (kansellert under ruting). Ingen å trekke. */
  forTildelingOre: number;
  /** Refundert, men ikke trukket fra noen butikk, og verdt et blikk fra Garnly. */
  ikkeTrukket: Array<{ belopOre: number; grunn: string }>;
  /** Refundert frakt. Garnlys, aldri butikkens. */
  fraktOre: number;
}

/** Gruppene som er gjort opp med en butikk – de settlement_ledger regner som salg. */
const SOLGT = new Set(["assigned", "fulfilled"]);
/** Grupper som ikke finnes lenger i praksis: erstattet av en ny splitt, eller fra den gamle butikken. */
const UTGATT = new Set(["resplit", "archived"]);

const medMva = (subtotalOre: number, mvaOre: number, inkludert: boolean) => subtotalOre + (inkludert ? 0 : mvaOre);

export function fordelRefusjon(r: Refusjon, grupper: OppgjorsGruppe[]): Fordeling {
  const fraktOre = r.frakt.reduce((s, f) => s + medMva(f.subtotalOre, f.mvaOre, r.taxesIncluded), 0);
  const linjeOre = r.linjer.map((l) => Math.max(0, medMva(l.subtotalOre, l.mvaOre, r.taxesIncluded)));
  const varerFraLinjer = linjeOre.reduce((s, v) => s + v, 0);

  // Butikken trekkes aldri for mer enn kunden faktisk fikk tilbake for varene. Ble beløpet satt
  // ned ved refusjonen (Shopify lagrer det som «refund discrepancy»), skaleres varelinjene ned
  // tilsvarende. Frakten regnes som refundert først – den er Garnlys uansett.
  const tak = Math.max(0, r.totalOre - fraktOre);
  const varer = Math.min(varerFraLinjer, tak);

  const ikkeTrukket: Fordeling["ikkeTrukket"] = [];
  // Mer tilbake enn varer og frakt (godvilje, eller refusjon av et beløp uten varelinjer):
  // det er ikke varebeløp, og trekkes ikke automatisk. Garnly avgjør.
  if (tak > varerFraLinjer) {
    ikkeTrukket.push({
      belopOre: tak - varerFraLinjer,
      grunn: r.linjer.length ? "refundert mer enn varer og frakt" : "refusjon uten varelinjer",
    });
  }

  const perGruppe = new Map<string, Trekk>();
  let forTildelingOre = 0;
  r.linjer.forEach((l, i) => {
    const belop = varerFraLinjer > 0 ? Math.round((linjeOre[i] * varer) / varerFraLinjer) : 0;
    if (belop <= 0) return;
    const kandidater = l.variantId
      ? grupper.filter((g) => !UTGATT.has(g.status) && g.varianter.includes(l.variantId!))
      : [];
    if (kandidater.length === 0) {
      ikkeTrukket.push({ belopOre: belop, grunn: `fant ikke varianten i noen gruppe (${l.variantId ?? "uten variant"})` });
      return;
    }
    // To grupper med samme variant i én ordre: hele antallet av en varelinje kommer fra én
    // butikk, men to linjer med samme variant kan ha gått til hver sin. Da vet vi ikke hvem
    // som skal trekkes, og gjetter ikke.
    if (kandidater.length > 1) {
      ikkeTrukket.push({ belopOre: belop, grunn: `varianten ligger i ${kandidater.length} grupper (${l.variantId})` });
      return;
    }
    const g = kandidater[0];
    if (!g.storeId || !SOLGT.has(g.status)) {
      forTildelingOre += belop;
      return;
    }
    const t = perGruppe.get(g.id) ?? { groupId: g.id, storeId: g.storeId, varebelopOre: 0 };
    t.varebelopOre += belop;
    perGruppe.set(g.id, t);
  });

  return { trekk: [...perGruppe.values()], forTildelingOre, ikkeTrukket, fraktOre };
}
