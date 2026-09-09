/**
 * Duell (Kasseservice) adapter.
 *
 * Endepunkter hentet fra Duells egen WooCommerce-integrasjon
 * (github.com/Kasseservice/woocommerce-3x). Full dokumentasjon: https://api.kasseservice.no/docs
 *
 *   POST /v1/getaccesstokens        { client_number, client_token }  -> { status, token }
 *   GET  /v1/all/product/stock      ?department=<token>&length=N&start=M&filter[view_on_webshop]=true
 *                                   -> { status, total_count, data: [ { product_number, department: [ { stock } ] } ] }
 *   GET  /v1/product/list           ?length=N&start=M&filter[view_on_webshop]=true
 *                                   -> { status, total_count, products: [ { product_number, barcode, product_name, ... } ] }
 *
 * pos_config:  { "department": "<department token>", "page_size": 100 }
 * secrets:     { "client_number": "...", "client_token": "..." }
 *
 * VERIFISERT mot Garnkilden (klient 722490) 2026-09-09:
 *  - `length` er hardt begrenset til 100 rader per side, uansett hva man ber om. Sidebladingen
 *    MÅ derfor flytte `start` med antall rader vi faktisk fikk, ikke med ønsket sidestørrelse.
 *  - `all/product/stock` inneholder verken strekkode eller navn – bare product_number og antall.
 *    Strekkoden ligger i `product/list` (5155 av 6010 produkter har den, 2881 av 3115 garn).
 *    Den er klient-omfattende og tar ~2 min å bla gjennom, så den mellomlagres i `pos_catalog`
 *    og friskes opp én gang i døgnet (se refreshCatalog + pos-catalog-funksjonen).
 *  - Bare `filter[view_on_webshop]` og `filter[category_id]` virker. `filter[category_name]`,
 *    `filter[updated_at]` og kommaseparerte `filter[product_number]` ignoreres eller gir 0 treff.
 */
import { adminClient } from "../db.ts";
import type { StockLine, StoreRow } from "../types.ts";
import { AdapterError, normalizeEan, type PosAdapter, sleep } from "./types.ts";

const BASE = "https://api.kasseservice.no/v1/";
/** Duell returnerer aldri mer enn 100 rader per side, uansett hva `length` sier. */
const MAX_PAGE = 100;
/** Hvor gammel katalogen kan bli før vi blar den gjennom på nytt. */
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

const tokenCache = new Map<string, { token: string; at: number }>();

/**
 * Duells API krever at kall kommer fra en hvitelistet, fast IP. Supabase Edge Functions har
 * ingen fast utgående IP, så vi ruter Duell-kallene gjennom en fast-IP-proxy når DUELL_PROXY_URL
 * er satt (f.eks. http://bruker:passord@host:port). Uten den kalles Duell direkte (som før).
 * Klienten opprettes én gang og gjenbrukes.
 */
let _proxyClient: unknown | null | undefined;
function proxyClient(): unknown | null {
  if (_proxyClient !== undefined) return _proxyClient;
  const raw = Deno.env.get("DUELL_PROXY_URL");
  // deno-lint-ignore no-explicit-any
  const D = Deno as any;
  if (!raw || typeof D.createHttpClient !== "function") return (_proxyClient = null);
  const u = new URL(raw);
  const basicAuth = u.username ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } : undefined;
  const proxyUrl = `${u.protocol}//${u.host}`;
  _proxyClient = D.createHttpClient({ proxy: { url: proxyUrl, basicAuth } });
  return _proxyClient;
}

/** fetch som ruter gjennom Duell-proxyen hvis konfigurert. */
function duellFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const client = proxyClient();
  // deno-lint-ignore no-explicit-any
  return fetch(input, (client ? { ...init, client } : init) as any);
}

async function login(secrets: Record<string, string>): Promise<string> {
  const key = secrets.client_number;
  const cached = tokenCache.get(key);
  if (cached && Date.now() - cached.at < 20 * 60 * 60 * 1000) return cached.token;

  const res = await duellFetch(BASE + "getaccesstokens", {
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

// deno-lint-ignore no-explicit-any
async function get(path: string, params: Record<string, string>, secrets: Record<string, string>, retry = true): Promise<any> {
  const token = await login(secrets);
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await duellFetch(url, {
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

/**
 * Blar gjennom et Duell-endepunkt. Duell kapper sider til 100 rader, så vi flytter `start` med
 * antall rader vi faktisk fikk. (Flyttet vi den med ønsket sidestørrelse, hoppet vi over resten.)
 */
async function paginate(
  path: string,
  params: Record<string, string>,
  secrets: Record<string, string>,
  rowsOf: (json: Record<string, unknown>) => Array<Record<string, unknown>>,
  onPage: (rows: Array<Record<string, unknown>>) => void,
): Promise<number> {
  let start = 0;
  let total = Infinity;
  let guard = 0;
  while (start < total && guard++ < 500) {
    const json = await get(path, { ...params, length: String(MAX_PAGE), start: String(start) }, secrets);
    const t = Number(json.total_count ?? 0);
    if (Number.isFinite(t) && t > 0) total = t;
    const rows = rowsOf(json);
    if (rows.length === 0) break;
    onPage(rows);
    start += rows.length;
    if (start < total) await sleep(300);
  }
  return start;
}

function pickEan(row: Record<string, unknown>): string | null {
  for (const k of ["barcode", "ean", "gtin", "product_barcode", "ean_code"]) {
    const e = normalizeEan(row[k]);
    if (e) return e;
  }
  return null;
}

function pickQty(row: Record<string, unknown>): number {
  const dep = row.department as Array<Record<string, unknown>> | undefined;
  const raw = dep?.[0]?.stock ?? row.stock ?? 0;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

/** Katalogen deles av alle avdelinger under samme Duell-klient. */
function catalogSource(secrets: Record<string, string>): string {
  return `duell:${secrets.client_number}`;
}

export interface CatalogEntry {
  ean: string | null;
  name: string | null;
}

/**
 * Blar gjennom hele produktkatalogen og lagrer strekkode + navn i `pos_catalog`.
 * Tar ~1–2 minutter. Kjøres av pos-catalog-funksjonen (daglig cron), eller automatisk
 * første gang en butikk synkes uten katalog.
 */
export async function refreshCatalog(secrets: Record<string, string>): Promise<{ rows: number; withEan: number }> {
  const source = catalogSource(secrets);
  const batch: Array<Record<string, unknown>> = [];
  let withEan = 0;

  const rows = await paginate(
    "product/list",
    { "filter[view_on_webshop]": "true" },
    secrets,
    (j) => (j.products as Array<Record<string, unknown>>) ?? [],
    (page) => {
      for (const p of page) {
        const sku = p.product_number ? String(p.product_number) : "";
        if (!sku) continue;
        const ean = pickEan(p);
        if (ean) withEan++;
        batch.push({
          source,
          sku,
          ean,
          name: (p.product_name ?? null) as string | null,
          category: (p.category_name ?? null) as string | null,
          supplier: (p.supplier_name ?? null) as string | null,
          updated_at: new Date().toISOString(),
        });
      }
    },
  );

  const db = adminClient();
  for (let i = 0; i < batch.length; i += 500) {
    const { error } = await db.from("pos_catalog").upsert(batch.slice(i, i + 500), { onConflict: "source,sku" });
    if (error) throw new AdapterError(`Kunne ikke lagre Duell-katalog: ${error.message}`);
  }
  console.log(`[duell] katalog ${source}: ${batch.length} produkter (${withEan} med strekkode) av ${rows} rader`);
  return { rows: batch.length, withEan };
}

/** Leser mellomlagret katalog. PostgREST gir maks 1000 rader per kall, så vi blar. */
async function loadCatalog(source: string): Promise<{ map: Map<string, CatalogEntry>; refreshedAt: number | null }> {
  const db = adminClient();
  const map = new Map<string, CatalogEntry>();
  let refreshedAt: number | null = null;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("pos_catalog")
      .select("sku, ean, name, updated_at")
      .eq("source", source)
      .range(from, from + 999);
    if (error) throw new AdapterError(`Kunne ikke lese Duell-katalog: ${error.message}`);
    for (const r of data ?? []) {
      map.set(String(r.sku), { ean: r.ean, name: r.name });
      const t = Date.parse(r.updated_at as string);
      if (Number.isFinite(t) && (refreshedAt === null || t > refreshedAt)) refreshedAt = t;
    }
    if (!data || data.length < 1000) break;
  }
  return { map, refreshedAt };
}

export const duellAdapter: PosAdapter = {
  system: "duell",

  async fetchStock(store: StoreRow, secrets): Promise<StockLine[]> {
    const department = String(store.pos_config.department ?? "");
    if (!department) throw new AdapterError(`Butikk ${store.name}: pos_config.department mangler`);

    const source = catalogSource(secrets);
    let { map: catalog, refreshedAt } = await loadCatalog(source);
    // Uten katalog er hver rad bare et produktnummer og matcher ingenting. Bygg den ved behov.
    if (catalog.size === 0 || refreshedAt === null || Date.now() - refreshedAt > CATALOG_TTL_MS) {
      try {
        await refreshCatalog(secrets);
        ({ map: catalog } = await loadCatalog(source));
      } catch (e) {
        // En utdatert katalog er bedre enn ingen synk – logg og fortsett med det vi har.
        console.error(`[duell] katalogoppfriskning feilet: ${(e as Error).message}`);
        if (catalog.size === 0) throw e;
      }
    }

    const out: StockLine[] = [];
    let firstLogged = false;
    let enriched = 0;
    await paginate(
      "all/product/stock",
      { department, "filter[view_on_webshop]": "true" },
      secrets,
      (j) => (j.data as Array<Record<string, unknown>>) ?? [],
      (page) => {
        if (!firstLogged && page[0]) {
          console.log("[duell] eksempelrad:", JSON.stringify(page[0]).slice(0, 600));
          firstLogged = true;
        }
        for (const row of page) {
          const sku = row.product_number ? String(row.product_number) : null;
          const fromCatalog = sku ? catalog.get(sku) : undefined;
          const ean = pickEan(row) ?? fromCatalog?.ean ?? null;
          if (ean && !pickEan(row)) enriched++;
          out.push({
            ean,
            sku,
            name: ((row.product_name ?? row.name) as string | null) ?? fromCatalog?.name ?? null,
            qty: pickQty(row),
          });
        }
      },
    );
    console.log(`[duell] ${store.name}: ${out.length} lagerrader, ${enriched} fikk strekkode fra katalogen (${catalog.size} i katalog)`);
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
