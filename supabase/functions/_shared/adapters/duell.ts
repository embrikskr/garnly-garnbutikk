/**
 * Duell (Kasseservice) adapter. Verifisert mot Garnkildens konto (klient 722490) 03.–09.09.2026.
 *
 *   POST /v1/getaccesstokens   { client_number, client_token } -> { token }  (JWT, ca. 3 døgn, bundet til avsender-IP)
 *   GET  /v1/department/list   -> { departments: [ { department_id, department_name, api_token, ... } ] }
 *   GET  /v1/product/list      ?length=100&start=N
 *        -> { products: [ { product_id, product_number, product_name, barcode, category_name, is_deleted, ... } ], total_count }
 *   GET  /v1/all/product/stock ?department=<api_token>&length=100&start=N
 *        -> { data: [ { product_id, product_number, department: [ { department_id, stock, actual_stock } ] } ], total_count }
 *
 * VIKTIG, verifisert mot ekte konto:
 *  - API-et gir maks 100 rader per side uansett hva `length` sier. Sidebladingen MÅ flytte
 *    `start` med antall rader vi faktisk fikk; flytter man den med ønsket sidestørrelse,
 *    hoppes resten over (Garnkilden ga 700 av 3345 rader før dette ble rettet).
 *  - Strekkoden finnes KUN i product/list, lager KUN i all/product/stock. De kobles på
 *    product_id. product_number er IKKE unikt og duger ikke som nøkkel.
 *  - product/list er klient-omfattende og tar ~2 min å bla gjennom (6010 produkter, 5155 med
 *    strekkode, 2881 av 3115 garn). Synken går hvert 5. minutt, så katalogen mellomlagres i
 *    tabellen `pos_catalog` og friskes opp daglig av pos-catalog-funksjonen.
 *  - Bare filter[view_on_webshop] og filter[category_id] virker. filter[category_name],
 *    filter[updated_at] og kommaseparerte filter[product_number] ignoreres eller gir 0 treff.
 *  - API-et ligger bak AWS WAF som blokkerer datasenter-IP-er. Supabase har ingen fast utgående
 *    IP, så kallene rutes gjennom en fast-IP-proxy (DUELL_PROXY_URL) som Duell har hvitelistet.
 *
 * external_id (for product_aliases) = product_number.
 * pos_config:  { "department": "<department api_token>" }   (hentes fra department/list)
 * secrets:     { "client_number": "...", "client_token": "..." }
 */
import { adminClient } from "../db.ts";
import type { StockLine, StoreRow } from "../types.ts";
import { AdapterError, normalizeEan, type PosAdapter, sleep } from "./types.ts";

const BASE = "https://api.kasseservice.no/v1/";
/** Duell returnerer aldri mer enn 100 rader per side, uansett hva `length` sier. */
const PAGE = 100;
/** Hvor gammel den mellomlagrede katalogen kan bli før vi blar den gjennom på nytt. */
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

const tokenCache = new Map<string, { token: string; at: number }>();

/**
 * Duell krever at kall kommer fra en hvitelistet, fast IP. Supabase Edge Functions har ingen,
 * så vi ruter gjennom proxyen i DUELL_PROXY_URL (http://bruker:passord@host:port) når den er
 * satt. Uten den kalles Duell direkte. Klienten opprettes én gang og gjenbrukes.
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
  _proxyClient = D.createHttpClient({ proxy: { url: `${u.protocol}//${u.host}`, basicAuth } });
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
  if (cached && Date.now() - cached.at < 12 * 60 * 60 * 1000) return cached.token;
  const res = await duellFetch(BASE + "getaccesstokens", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "Garnly Sync" },
    body: JSON.stringify({ client_number: secrets.client_number, client_token: secrets.client_token }),
  });
  const text = await res.text();
  if (text.startsWith("<")) throw new AdapterError("Duell: fikk HTML (WAF/captcha) i stedet for JSON – IP-en er trolig blokkert", res.status);
  const json = JSON.parse(text);
  if (!res.ok || !json?.token) throw new AdapterError(`Duell login feilet: ${res.status} ${text.slice(0, 200)}`, res.status);
  tokenCache.set(key, { token: json.token, at: Date.now() });
  return json.token;
}

// deno-lint-ignore no-explicit-any
async function get(path: string, params: Record<string, string>, secrets: Record<string, string>, retry = true): Promise<any> {
  const token = await login(secrets);
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await duellFetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": "Garnly Sync" } });
  if (res.status === 401 && retry) {
    tokenCache.delete(secrets.client_number);
    return get(path, params, secrets, false);
  }
  if (res.status === 429) {
    await sleep(2000);
    return get(path, params, secrets, false);
  }
  const text = await res.text();
  if (text.startsWith("<")) throw new AdapterError(`Duell ${path}: fikk HTML (WAF/captcha) – IP-en er trolig blokkert`, res.status);
  const json = JSON.parse(text);
  if (!res.ok || json?.status === false) throw new AdapterError(`Duell ${path} feilet: ${res.status} ${json?.message ?? ""}`, res.status);
  return json;
}

/** Paginerer på antall mottatte rader (API-et capper til 100 uansett hva vi ber om). */
async function allPages(
  path: string,
  key: string,
  extra: Record<string, string>,
  secrets: Record<string, string>,
  onPage?: (rows: Array<Record<string, unknown>>) => void,
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  let start = 0;
  for (let guard = 0; guard < 1000; guard++) {
    const json = await get(path, { length: String(PAGE), start: String(start), ...extra }, secrets);
    const rows: Array<Record<string, unknown>> = json[key] ?? [];
    if (onPage) onPage(rows);
    else out.push(...rows);
    const total = Number(json.total_count ?? 0);
    start += rows.length;
    if (rows.length === 0 || start >= total) break;
    await sleep(150);
  }
  return out;
}

function qtyOf(row: Record<string, unknown>): number {
  const dep = row.department as Array<Record<string, unknown>> | undefined;
  const n = Number(dep?.[0]?.stock ?? 0);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

/** Katalogen deles av alle avdelinger under samme Duell-klient. */
function catalogSource(secrets: Record<string, string>): string {
  return `duell:${secrets.client_number}`;
}

interface CatalogEntry {
  sku: string | null;
  ean: string | null;
  name: string | null;
  deleted: boolean;
}

/**
 * Blar gjennom hele produktkatalogen og lagrer strekkode + navn i `pos_catalog`.
 * Tar ~2 minutter. Kjøres daglig av pos-catalog-funksjonen, eller automatisk første gang
 * en butikk synkes uten katalog.
 */
export async function refreshCatalog(secrets: Record<string, string>): Promise<{ rows: number; withEan: number }> {
  const source = catalogSource(secrets);
  // product_id er primærnøkkelen; samme id kan komme flere ganger hvis katalogen endrer seg
  // under sidebladingen, og da nekter Postgres å røre raden to ganger i én ON CONFLICT-batch.
  const byId = new Map<string, Record<string, unknown>>();
  let withEan = 0;

  await allPages("product/list", "products", {}, secrets, (rows) => {
    for (const p of rows) {
      const posId = p.product_id ? String(p.product_id) : "";
      if (!posId) continue;
      const ean = normalizeEan(p.barcode);
      if (ean && !byId.has(posId)) withEan++;
      byId.set(posId, {
        source,
        pos_id: posId,
        sku: p.product_number ? String(p.product_number) : null,
        ean,
        name: (p.product_name ?? null) as string | null,
        category: (p.category_name ?? null) as string | null,
        supplier: (p.supplier_name ?? null) as string | null,
        deleted: !!p.is_deleted,
        updated_at: new Date().toISOString(),
      });
    }
  });

  const batch = [...byId.values()];
  const db = adminClient();
  for (let i = 0; i < batch.length; i += 500) {
    const { error } = await db.from("pos_catalog").upsert(batch.slice(i, i + 500), { onConflict: "source,pos_id" });
    if (error) throw new AdapterError(`Kunne ikke lagre Duell-katalog: ${error.message}`);
  }
  console.log(`[duell] katalog ${source}: ${batch.length} produkter, ${withEan} med strekkode`);
  return { rows: batch.length, withEan };
}

/** Leser mellomlagret katalog. PostgREST gir maks 1000 rader per kall, så vi blar. */
async function loadCatalog(source: string): Promise<{ map: Map<string, CatalogEntry>; refreshedAt: number | null }> {
  const db = adminClient();
  const map = new Map<string, CatalogEntry>();
  let refreshedAt: number | null = null;
  for (let from = 0;; from += 1000) {
    const { data, error } = await db
      .from("pos_catalog")
      .select("pos_id, sku, ean, name, deleted, updated_at")
      .eq("source", source)
      .range(from, from + 999);
    if (error) throw new AdapterError(`Kunne ikke lese Duell-katalog: ${error.message}`);
    for (const r of data ?? []) {
      map.set(String(r.pos_id), { sku: r.sku, ean: r.ean, name: r.name, deleted: !!r.deleted });
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
    if (!department) throw new AdapterError(`Butikk ${store.name}: pos_config.department (Duell api_token fra department/list) mangler`);

    const source = catalogSource(secrets);
    let { map: products, refreshedAt } = await loadCatalog(source);
    // Uten katalog er hver lagerrad bare en id og matcher ingenting. Bygg den ved behov.
    if (products.size === 0 || refreshedAt === null || Date.now() - refreshedAt > CATALOG_TTL_MS) {
      try {
        await refreshCatalog(secrets);
        ({ map: products } = await loadCatalog(source));
      } catch (e) {
        // En utdatert katalog er bedre enn ingen synk – logg og fortsett med det vi har.
        console.error(`[duell] katalogoppfriskning feilet: ${(e as Error).message}`);
        if (products.size === 0) throw e;
      }
    }

    const out: StockLine[] = [];
    let withEan = 0;
    await allPages("all/product/stock", "data", { department }, secrets, (rows) => {
      for (const row of rows) {
        const p = products.get(String(row.product_id));
        if (p?.deleted) continue;
        const sku = p?.sku ?? (row.product_number ? String(row.product_number) : null);
        if (p?.ean) withEan++;
        out.push({ ean: p?.ean ?? null, sku, name: p?.name ?? null, qty: qtyOf(row), external_id: sku });
      }
    });
    console.log(`[duell] ${store.name}: ${out.length} lagerrader, ${withEan} med strekkode (katalog: ${products.size} produkter)`);
    return out;
  },

  async fetchStockFor(store, secrets, eans) {
    // Ingen kjent "gi meg disse"-spørring; hele lagerlisten er ~6 000 rader = 60 kall (~15 s).
    const all = await this.fetchStock(store, secrets);
    const want = new Set(eans);
    const m = new Map<string, number>();
    for (const l of all) if (l.ean && want.has(l.ean)) m.set(l.ean, l.qty);
    return m;
  },
};

/** Hjelper for onboarding: lister avdelinger (department api_token) for en Duell-konto. */
export async function listDepartments(secrets: Record<string, string>) {
  const json = await get("department/list", {}, secrets);
  return (json.departments ?? []).map((d: Record<string, unknown>) => ({ id: d.department_id, name: d.department_name, api_token: d.api_token, city: d.city }));
}
