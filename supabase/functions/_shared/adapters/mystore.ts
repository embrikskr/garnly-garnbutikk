/**
 * Mystore / Acendy API v2 adapter.
 * Dokumentasjon: https://mystoreapi.docs.apiary.io/
 *
 *   Base: https://api.mystore.no/shops/<shop>/
 *   Headers: Authorization: Bearer <token>, Accept: application/vnd.api+json
 *   GET products?page[number]=n&page[size]=50&fields[products]=sku,ean,quantity,updated_at,products_name
 *   GET product-variants?page[number]=n&page[size]=50   (varianter har egne sku/ean/quantity)
 *   Rate limit: 120 kall/min per token.
 *   Filter: filter[updated_at][path]=updated_at&filter[updated_at][value]=<ts>&filter[updated_at][operator]=gte
 *
 * pos_config:  { "shop": "butikknavn", "use_variants": true }
 * secrets:     { "token": "<personal access token>" }
 *
 * Produkter MED varianter: lageret ligger på variantene, produktets quantity ignoreres.
 * Produkter UTEN varianter: produktets quantity brukes.
 */
import type { StockLine, StoreRow } from "../types.ts";
import { AdapterError, normalizeEan, type PosAdapter, sleep } from "./types.ts";

const PAGE = 50;

interface JsonApiResource {
  id: string;
  type: string;
  attributes: Record<string, unknown>;
  relationships?: Record<string, { data: { id: string; type: string } | { id: string; type: string }[] | null }>;
}

async function getPage(store: StoreRow, secrets: Record<string, string>, resource: string, page: number, extra: Record<string, string> = {}): Promise<{ data: JsonApiResource[]; last: boolean }> {
  const shop = String(store.pos_config.shop ?? "");
  if (!shop) throw new AdapterError(`Butikk ${store.name}: pos_config.shop mangler`);
  const url = new URL(`https://api.mystore.no/shops/${shop}/${resource}`);
  url.searchParams.set("page[number]", String(page));
  url.searchParams.set("page[size]", String(PAGE));
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${secrets.token}`,
      Accept: "application/vnd.api+json",
      "User-Agent": "Garnly Sync",
    },
  });
  if (res.status === 429) {
    await sleep(5000);
    return getPage(store, secrets, resource, page, extra);
  }
  if (res.status === 404 && page > 1) return { data: [], last: true };
  if (!res.ok) throw new AdapterError(`Mystore ${resource} side ${page}: ${res.status} ${(await res.text()).slice(0, 200)}`, res.status);
  const json = await res.json();
  const data: JsonApiResource[] = json.data ?? [];
  const last = data.length < PAGE || !json.links?.next;
  return { data, last };
}

async function getAll(store: StoreRow, secrets: Record<string, string>, resource: string, extra: Record<string, string> = {}): Promise<JsonApiResource[]> {
  const out: JsonApiResource[] = [];
  for (let page = 1; page < 10000; page++) {
    const { data, last } = await getPage(store, secrets, resource, page, extra);
    out.push(...data);
    if (last) break;
    await sleep(550); // ~110 kall/min, under grensen på 120
  }
  return out;
}

function qtyOf(a: Record<string, unknown>): number {
  const n = Number(a.quantity ?? 0);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function nameOf(a: Record<string, unknown>): string | null {
  const n = a.products_name ?? a.name;
  if (n && typeof n === "object") return (n as Record<string, string>).no ?? Object.values(n as Record<string, string>)[0] ?? null;
  return n ? String(n) : null;
}

export const mystoreAdapter: PosAdapter = {
  system: "mystore",

  async fetchStock(store, secrets): Promise<StockLine[]> {
    const products = await getAll(store, secrets, "products", {
      "fields[products]": "sku,ean,quantity,products_name,updated_at",
    });
    const useVariants = store.pos_config.use_variants !== false;
    const variants = useVariants ? await getAll(store, secrets, "product-variants") : [];

    // Produkter som har varianter: lageret ligger på variantene
    const productsWithVariants = new Set<string>();
    const out: StockLine[] = [];
    for (const v of variants) {
      const rel = v.relationships?.product?.data;
      const pid = rel && !Array.isArray(rel) ? rel.id : null;
      if (pid) productsWithVariants.add(pid);
      const parent = pid ? products.find((p) => p.id === pid) : undefined;
      out.push({
        ean: normalizeEan(v.attributes.ean),
        sku: v.attributes.sku ? String(v.attributes.sku) : null,
        name: parent ? nameOf(parent.attributes) : null,
        qty: qtyOf(v.attributes),
      });
    }
    for (const p of products) {
      if (productsWithVariants.has(p.id)) continue;
      out.push({
        ean: normalizeEan(p.attributes.ean),
        sku: p.attributes.sku ? String(p.attributes.sku) : null,
        name: nameOf(p.attributes),
        qty: qtyOf(p.attributes),
      });
    }
    return out;
  },

  async fetchStockFor(store, secrets, eans) {
    const all = await this.fetchStock(store, secrets);
    const want = new Set(eans);
    const m = new Map<string, number>();
    for (const l of all) if (l.ean && want.has(l.ean)) m.set(l.ean, l.qty);
    return m;
  },
};
