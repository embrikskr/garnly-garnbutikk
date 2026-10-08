import type { StockLine, StoreRow } from "../types.ts";

/**
 * Felles grensesnitt for alle kassesystemer.
 * En adapter har ÉN jobb: gi tilbake normalisert lager for én butikk.
 */
export interface PosAdapter {
  system: string;
  /** Full lagerliste for butikken. */
  fetchStock(store: StoreRow, secrets: Record<string, string>): Promise<StockLine[]>;
  /**
   * Sanntidssjekk for et lite sett varer (brukes ved aksept, §8.5).
   * Returnerer map ean -> qty. Adaptere uten støtte kan falle tilbake til fetchStock.
   */
  fetchStockFor(
    store: StoreRow,
    secrets: Record<string, string>,
    eans: string[],
  ): Promise<Map<string, number>>;
}

export class AdapterError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "AdapterError";
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ENTITETER: Record<string, string> = {
  aring: "å", Aring: "Å", oslash: "ø", Oslash: "Ø", aelig: "æ", AElig: "Æ",
  auml: "ä", ouml: "ö", uuml: "ü", eacute: "é", amp: "&", quot: '"', apos: "'", nbsp: " ",
};

/**
 * HTML-entiteter i tekst fra kassesystemet: «Korallr&oslash;d» → «Korallrød».
 * Mystore lagrer fargenavn slik (verifisert 09.10.2026: &oslash;, &aring;, &aelig;, &#039;),
 * og uten dekoding blir de aldri like Shopify-navnet.
 */
export function dekodHtml(s: string): string {
  return s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (hele, e: string) => {
    if (e[0] !== "#") return ENTITETER[e] ?? hele;
    const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : hele;
  });
}

export function normalizeEan(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, "");
  if (!/^\d{8,14}$/.test(s)) return null;
  // Strip leading zeros used to pad UPC to EAN-13 so both forms match
  return s.replace(/^0+(?=\d{12,13}$)/, "");
}

/**
 * Skal dette svaret prøves på nytt?
 *
 * REN logikk. Mystore svarte 504 Gateway Time-out på første produktside 30.09 og 01.10 2026,
 * og synken feilet begge ganger – selv om neste kjøring et kvarter senere gikk fint. Det er
 * deres server som bruker for lang tid, ikke noe hos oss, og et nytt forsøk er alt som skal
 * til. Feilen ble stående i loggen som om noe var galt med synken.
 *
 * 5xx og 429 prøves på nytt. 4xx gjør vi ikke: en 401 blir ikke bedre av å spørre igjen, og
 * en 400 betyr at spørringen vår er feil.
 */
export function borProveIgjen(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}
