import type { ProductRow, StockLine } from "./types.ts";

/**
 * Matching: 1) EAN, 2) alias (product_aliases: kassesystemets id → produkt), 3) SKU, 4) navn (normalisert).
 * `aliases` er external_id → product.id for butikken som synkes.
 */
export function matchLines(lines: StockLine[], products: ProductRow[], aliases: Map<string, string> = new Map()) {
  const byEan = new Map<string, ProductRow>();
  const bySku = new Map<string, ProductRow>();
  const byName = new Map<string, ProductRow>();
  const byId = new Map<string, ProductRow>();
  for (const p of products) {
    byId.set(p.id, p);
    if (p.ean) byEan.set(p.ean, p);
    if (p.sku) bySku.set(p.sku.toLowerCase(), p);
    byName.set(normName(p.name), p);
    if (p.brand && p.yarn_name && p.color_name) byName.set(normName(`${p.brand} ${p.yarn_name} ${p.color_name}`), p);
  }
  const matched: Array<{ product: ProductRow; line: StockLine }> = [];
  const unmatched: StockLine[] = [];
  for (const line of lines) {
    const aliasId = line.external_id ? aliases.get(line.external_id) : undefined;
    const p = (line.ean && byEan.get(line.ean)) ||
      (aliasId && byId.get(aliasId)) ||
      (line.sku && bySku.get(line.sku.toLowerCase())) ||
      (line.name && byName.get(normName(line.name))) || null;
    if (p) matched.push({ product: p, line });
    else unmatched.push(line);
  }
  return { matched, unmatched };
}

export function normName(s: string): string {
  return s.toLowerCase().replace(/[–—-]/g, " ").replace(/[^a-z0-9æøå ]/g, "").replace(/\s+/g, " ").trim();
}
