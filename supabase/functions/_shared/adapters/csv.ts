/**
 * CSV-adapter: for butikker uten API. Butikken (eller Garnly) laster opp en CSV i
 * Supabase Storage-bucket "stock-uploads" som <slug>.csv med kolonnene ean;sku;name;qty
 * (skilletegn ; eller , og valgfri header).
 *
 * pos_config: { "bucket": "stock-uploads", "path": "<slug>.csv" }
 * secrets:    {}
 */
import type { StockLine, StoreRow } from "../types.ts";
import { AdapterError, normalizeEan, type PosAdapter } from "./types.ts";
import { adminClient } from "../db.ts";

function parseCsv(text: string): StockLine[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  const sep = lines[0].includes(";") ? ";" : ",";
  const first = lines[0].toLowerCase();
  const hasHeader = /ean|sku|qty|antall|navn|name/.test(first);
  const rows = hasHeader ? lines.slice(1) : lines;
  const header = hasHeader ? lines[0].split(sep).map((h) => h.trim().toLowerCase()) : ["ean", "sku", "name", "qty"];
  const idx = (names: string[]) => header.findIndex((h) => names.includes(h));
  const iEan = idx(["ean", "strekkode", "barcode", "gtin"]);
  const iSku = idx(["sku", "varenr", "varenummer", "product_number"]);
  const iName = idx(["name", "navn", "produkt"]);
  const iQty = idx(["qty", "antall", "lager", "quantity", "stock"]);
  return rows.map((l) => {
    const c = l.split(sep).map((x) => x.trim().replace(/^"|"$/g, ""));
    return {
      ean: iEan >= 0 ? normalizeEan(c[iEan]) : null,
      sku: iSku >= 0 && c[iSku] ? c[iSku] : null,
      name: iName >= 0 && c[iName] ? c[iName] : null,
      qty: Math.max(0, Math.floor(Number(iQty >= 0 ? c[iQty] : 0) || 0)),
    };
  });
}

export const csvAdapter: PosAdapter = {
  system: "csv",
  async fetchStock(store: StoreRow): Promise<StockLine[]> {
    const bucket = String(store.pos_config.bucket ?? "stock-uploads");
    const path = String(store.pos_config.path ?? `${store.slug}.csv`);
    const { data, error } = await adminClient().storage.from(bucket).download(path);
    if (error || !data) throw new AdapterError(`CSV ${bucket}/${path} finnes ikke: ${error?.message}`);
    return parseCsv(await data.text());
  },
  async fetchStockFor(store, secrets, eans) {
    const all = await this.fetchStock(store, secrets);
    const want = new Set(eans);
    const m = new Map<string, number>();
    for (const l of all) if (l.ean && want.has(l.ean)) m.set(l.ean, l.qty);
    return m;
  },
};

export { parseCsv };
