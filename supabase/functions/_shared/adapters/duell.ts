/**
 * Duell (Kasseservice) adapter.
 *
 * Endepunkter hentet fra Duells egen WooCommerce-integrasjon
 * (github.com/Kasseservice/woocommerce-3x). Full dokumentasjon: https://api.kasseservice.no/docs
 *
 *   POST /v1/getaccesstokens        { client_number, client_token }  -> { status, token }
 *   GET  /v1/all/product/stock      ?department=<token>&length=N&start=M&filter[view_on_webshop]=true
 *                                   -> { status, total_count, data: [ { product_number, barcode?, department: [ { stock } ] } ] }
 *   GET  /v1/product/list           ?filter[product_number]=X  -> { status, total_count, products: [ ... ] }
 *
 * pos_config:  { "department": "<department token>", "page_size": 500 }
 * secrets:     { "client_number": "...", "client_token": "..." }
 *
 * MÅ VERIFISERES mot ekte konto: feltnavnet for strekkode i all/product/stock
 * (vi prøver flere kandidater, se pickEan). Logg en rå rad ved første synk.
 */
import type { StockLine, StoreRow } from "../types.ts";
import { AdapterError, normalizeEan, type PosAdapter, sleep } from "./types.ts";

const BASE = "https://api.kasseservice.no/v1/";
const tokenCache = new Map<string, { token: string; at: number }>();

async function login(secrets: Record<string, string>): Promise<string> {
  const key = secrets.client_number;
  const cached = tokenCache.get(key);
  if (cached && Date.now() - cached.at < 20 * 60 * 60 * 1000) return cached.token;

  const res = await fetch(BASE + "getaccesstokens", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "Garnly Sync" },
    body: JSON.stringify({ client_number: secrets.client_number, client_token: secrets.client_token }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json?.token) {
    throw new AdapterError(`Duell login feilet: ${res.status} ${JSON.stringify(json).slice(0, 200)}`, res.status);
  }
  tokenCache.set(key, { token: json.token, at: Date.now() });
  return json.token;
}

async function get(path: string, params: Record<string, string>, secrets: Record<string, string>, retry = true): Promise<any> {
  const token = await login(secrets);
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": "Garnly Sync" },
  });
  if (res.status === 401 && retry) {
    tokenCache.delete(secrets.client_number);
    return get(path, params, secrets, false);
  }
  if (res.status === 429) {
    await sleep(2000);
    return get(path, params, secrets, false);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.status === false) {
    throw new AdapterError(`Duell ${path} feilet: ${res.status} ${json?.message ?? ""}`, res.status);
  }
  return json;
}

function pickEan(row: Record<string, unknown>): string | null {
  for (const k of ["barcode", "ean", "gtin", "product_barcode", "ean_code"]) {
    const e = normalizeEan(row[k]);
    if (e) return e;
  }
  // Noen Duell-oppsett bruker strekkoden som produktnummer
  return normalizeEan(row.product_number);
}

function pickQty(row: Record<string, unknown>): number {
  const dep = row.department as Array<Record<string, unknown>> | undefined;
  const raw = dep?.[0]?.stock ?? row.stock ?? 0;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

export const duellAdapter: PosAdapter = {
  system: "duell",

  async fetchStock(store: StoreRow, secrets): Promise<StockLine[]> {
    const department = String(store.pos_config.department ?? "");
    if (!department) throw new AdapterError(`Butikk ${store.name}: pos_config.department mangler`);
    const length = Number(store.pos_config.page_size ?? 500);

    const out: StockLine[] = [];
    let start = 0;
    let total = Infinity;
    let firstLogged = false;
    while (start < total) {
      const json = await get("all/product/stock", {
        department,
        length: String(length),
        start: String(start),
        "filter[view_on_webshop]": "true",
      }, secrets);
      total = Number(json.total_count ?? 0);
      const data: Array<Record<string, unknown>> = json.data ?? [];
      if (!firstLogged && data[0]) {
        console.log("[duell] eksempelrad:", JSON.stringify(data[0]).slice(0, 600));
        firstLogged = true;
      }
      for (const row of data) {
        out.push({
          ean: pickEan(row),
          sku: row.product_number ? String(row.product_number) : null,
          name: (row.product_name ?? row.name ?? null) as string | null,
          qty: pickQty(row),
        });
      }
      if (data.length === 0) break;
      start += length;
      if (start < total) await sleep(500); // samme pause som Duells eget plugin
    }
    return out;
  },

  async fetchStockFor(store, secrets, eans) {
    // Duell har ikke et kjent "gi meg disse N"-kall; vi henter alt (butikker har få tusen rader).
    const all = await this.fetchStock(store, secrets);
    const want = new Set(eans);
    const m = new Map<string, number>();
    for (const l of all) if (l.ean && want.has(l.ean)) m.set(l.ean, l.qty);
    return m;
  },
};
