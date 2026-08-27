import type { ProductRow, StockLine } from "./types.ts";

/**
 * Matching: 1) EAN, 2) SKU (hvis Garnly-produktet har sku), 3) navn (merke + garn + farge, normalisert).
 */
export function matchLines(lines: StockLine[], products: ProductRow[]) {
  const byEan = new Map<string, ProductRow>();
  const bySku = new Map<string, ProductRow>();
  const byName = new Map<string, ProductRow>();
  for (const p of products) {
    if (p.ean) byEan.set(p.ean, p);
    if (p.sku) bySku.set(p.sku.toLowerCase(), p);
    byName.set(normName(p.name), p);
    if (p.brand && p.yarn_name && p.color_name) byName.set(normName(`${p.brand} ${p.yarn_name} ${p.color_name}`), p);
  }
  const matched: Array<{ product: ProductRow; line: StockLine }> = [];
  const unmatched: StockLine[] = [];
  for (const line of lines) {
    const p = (line.ean && byEan.get(line.ean)) || (line.sku && bySku.get(line.sku.toLowerCase())) || (line.name && byName.get(normName(line.name))) || null;
    if (p) matched.push({ product: p, line });
    else unmatched.push(line);
  }
  return { matched, unmatched };
}

export function normName(s: string): string {
  return s.toLowerCase().replace(/[–—-]/g, " ").replace(/[^a-z0-9æøå ]/g, "").replace(/\s+/g, " ").trim();
}
