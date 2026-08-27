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

export function normalizeEan(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, "");
  if (!/^\d{8,14}$/.test(s)) return null;
  // Strip leading zeros used to pad UPC to EAN-13 so both forms match
  return s.replace(/^0+(?=\d{12,13}$)/, "");
}
