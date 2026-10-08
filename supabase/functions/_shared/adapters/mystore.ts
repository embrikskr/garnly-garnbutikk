/**
 * Mystore / Acendy API v2 adapter.
 * Dokumentasjon: https://mystoreapi.docs.apiary.io/
 * Feltnavn VERIFISERT mot ekte butikk (strikkefryd) 04.09.2026:
 *   products-attributter: name (objekt per språk, f.eks. {"no": "..."}), ean, sku, quantity,
 *   quantity_physical, quantity_reserved, status (0 = inaktiv), updated_at m.fl.
 *   product-variants-attributter: ean, sku, quantity, disabled + relationships.product.
 *   NB: "products_name" finnes IKKE som felt; ugyldige fieldsets gir 400.
 * Fargen, VERIFISERT 09.10.2026 (Saga, variant 116301):
 *   product-variants-listen har meta.product_variants = [{ products_stock_id, products_stock_attributes: "7-3648" }],
 *   dvs. <product-option-id>-<product-option-value-id>. product-options/7 → name {"no": "Farger Filcolana"},
 *   product-option-values/3648 → name {"no": "111 Pumpkin"}. Alle 5 038 variantene hos Strikkefryd har
 *   nøyaktig ett slikt par. Fargeverdiene (~3 800) mellomlagres i pos_catalog (source
 *   "mystore-farger:<shop>"), så synken bare henter nye; fargesettene (~75) hentes hver gang.
 *
 *   Base: https://api.mystore.no/shops/<shop>/
 *   Headers: Authorization: Bearer <token>, Accept: application/vnd.api+json
 *   Rate limit: 120 kall/min per token.
 *
 * pos_config:  { "shop": "butikknavn", "use_variants": true }
 * secrets:     { "token": "<personal access token>" }
 *
 * Produkter MED varianter: lageret ligger på variantene, produktets quantity ignoreres.
 * Produkter UTEN varianter: produktets quantity brukes.
 * Inaktive produkter (status 0) og deaktiverte varianter hoppes over.
 * En variant får navnet «<produkt> <farge>» («Saga 111 Pumpkin»), og yarn/color/brand hver for seg
 * til matchsteget garnnavn + fargekode. Fargesettet («Farger Filcolana») er merket.
 * external_id (for product_aliases) = "v:<variant-id>" for varianter, "p:<product-id>" for produkter uten varianter.
 */
import { adminClient } from "../db.ts";
import type { StockLine, StoreRow } from "../types.ts";
import { AdapterError, borProveIgjen, dekodHtml, normalizeEan, type PosAdapter, sleep } from "./types.ts";

const PAGE = 50;
/** Hvor mange ganger en side prøves på nytt ved 429 eller 5xx. Se borProveIgjen. */
const MAKS_FORSOK = 3;
/** Fargeverdiene i mellomlageret friskes helt opp så ofte; nye verdier hentes enkeltvis før det. */
const FARGER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Mangler flere verdier enn dette, er det raskere å bla gjennom hele lista (~76 sider) enn å hente én og én. */
const FARGER_ENKELTVIS_MAKS = 40;

interface JsonApiResource {
  id: string;
  type: string;
  attributes: Record<string, unknown>;
  relationships?: Record<string, { data: { id: string; type: string } | { id: string; type: string }[] | null }>;
}

async function getPage(
  store: StoreRow,
  secrets: Record<string, string>,
  resource: string,
  page: number,
  extra: Record<string, string> = {},
  forsok = 1,
): Promise<{ data: JsonApiResource[]; last: boolean; meta: Record<string, unknown> }> {
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
  if (res.status === 404 && page > 1) return { data: [], last: true, meta: {} };
  if (!res.ok && borProveIgjen(res.status) && forsok < MAKS_FORSOK) {
    // 429 trenger å vente ut vinduet; 504 trenger bare at serveren puster.
    await res.body?.cancel();
    await sleep(res.status === 429 ? 5000 : 2000 * forsok);
    return getPage(store, secrets, resource, page, extra, forsok + 1);
  }
  if (!res.ok) {
    const halen = forsok > 1 ? ` (etter ${forsok} forsøk)` : "";
    throw new AdapterError(`Mystore ${resource} side ${page}${halen}: ${res.status} ${(await res.text()).slice(0, 200)}`, res.status);
  }
  const json = await res.json();
  const data: JsonApiResource[] = json.data ?? [];
  const last = data.length < PAGE || !json.links?.next;
  return { data, last, meta: json.meta ?? {} };
}

async function getAll(
  store: StoreRow,
  secrets: Record<string, string>,
  resource: string,
  extra: Record<string, string> = {},
  onMeta?: (meta: Record<string, unknown>) => void,
): Promise<JsonApiResource[]> {
  const out: JsonApiResource[] = [];
  for (let page = 1; page < 10000; page++) {
    const { data, last, meta } = await getPage(store, secrets, resource, page, extra);
    out.push(...data);
    onMeta?.(meta);
    if (last) break;
    await sleep(550); // ~110 kall/min, under grensen på 120
  }
  return out;
}

/** Én ressurs, f.eks. product-option-values/3648. Null hvis den ikke finnes. */
async function getOne(store: StoreRow, secrets: Record<string, string>, path: string): Promise<JsonApiResource | null> {
  const shop = String(store.pos_config.shop ?? "");
  const res = await fetch(`https://api.mystore.no/shops/${shop}/${path}`, {
    headers: { Authorization: `Bearer ${secrets.token}`, Accept: "application/vnd.api+json", "User-Agent": "Garnly Sync" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new AdapterError(`Mystore ${path}: ${res.status}`, res.status);
  return (await res.json()).data ?? null;
}

/**
 * Fargeverdiene som variantene peker på (id → «111 Pumpkin»), fra mellomlageret i pos_catalog.
 * Nye verdier hentes enkeltvis; er lageret tomt, gammelt eller mangler mange, blas hele lista.
 * Feiler det, synker vi videre uten farger: fargen er et matchhjelpemiddel, ikke lager.
 */
async function loadColorValues(store: StoreRow, secrets: Record<string, string>, needed: Set<string>): Promise<Map<string, string>> {
  const db = adminClient();
  const source = `mystore-farger:${store.pos_config.shop}`;
  const map = new Map<string, string>();
  // Også verdier uten navn (slettet i Mystore) er «kjent», ellers hentes de på nytt hver kjøring.
  const kjent = new Set<string>();
  let eldst: number | null = null;
  for (let from = 0;; from += 1000) {
    const { data, error } = await db.from("pos_catalog").select("pos_id, name, updated_at").eq("source", source).range(from, from + 999);
    if (error) {
      console.error(`[mystore] ${store.name}: kunne ikke lese fargeverdier, synker uten farger: ${error.message}`);
      return map;
    }
    for (const r of data ?? []) {
      kjent.add(String(r.pos_id));
      if (r.name) map.set(String(r.pos_id), r.name);
      const t = Date.parse(r.updated_at as string);
      if (Number.isFinite(t) && (eldst === null || t < eldst)) eldst = t;
    }
    if (!data || data.length < 1000) break;
  }
  const mangler = [...needed].filter((id) => !kjent.has(id));
  const gammel = eldst === null || Date.now() - eldst > FARGER_TTL_MS;
  if (!gammel && mangler.length === 0) return map;

  try {
    const nye: Array<{ id: string; name: string | null }> = [];
    if (gammel || mangler.length > FARGER_ENKELTVIS_MAKS) {
      for (const v of await getAll(store, secrets, "product-option-values")) nye.push({ id: v.id, name: nameOf(v.attributes) });
    } else {
      for (const id of mangler) {
        const v = await getOne(store, secrets, `product-option-values/${id}`);
        nye.push({ id, name: v ? nameOf(v.attributes) : null });
        await sleep(550);
      }
    }
    const now = new Date().toISOString();
    const rows = nye.map((v) => ({ source, pos_id: v.id, name: v.name, category: "fargeverdi", deleted: false, updated_at: now }));
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await db.from("pos_catalog").upsert(rows.slice(i, i + 500), { onConflict: "source,pos_id" });
      if (error) throw new AdapterError(`Kunne ikke lagre Mystore-farger: ${error.message}`);
    }
    for (const v of nye) if (v.name) map.set(v.id, v.name);
    console.log(`[mystore] ${store.name}: ${nye.length} fargeverdier hentet (${gammel ? "hele lista" : "nye"})`);
  } catch (e) {
    console.error(`[mystore] ${store.name}: fargeverdier feilet, synker uten de nye: ${(e as Error).message}`);
  }
  return map;
}

/** «7-3648» → [["7", "3648"]]. Flere par støttes, men er ikke sett i ekte data. */
function optionPairs(attrs: unknown): Array<[string, string]> {
  return String(attrs ?? "").split(/[^0-9-]+/).map((p) => p.split("-")).filter((p) => p.length === 2 && p[0] && p[1]) as Array<[string, string]>;
}

function qtyOf(a: Record<string, unknown>): number {
  const n = Number(a.quantity ?? 0);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function nameOf(a: Record<string, unknown>): string | null {
  const n = a.products_name ?? a.name;
  const s = n && typeof n === "object" ? (n as Record<string, string>).no ?? Object.values(n as Record<string, string>)[0] ?? null : n ? String(n) : null;
  return s ? dekodHtml(s) : null;
}

export const mystoreAdapter: PosAdapter = {
  system: "mystore",

  async fetchStock(store, secrets): Promise<StockLine[]> {
    const products = await getAll(store, secrets, "products", {
      "fields[products]": "sku,ean,quantity,name,updated_at,status",
    });
    const useVariants = store.pos_config.use_variants !== false;
    const attrsByVariant = new Map<string, string>();
    const variants = useVariants
      ? await getAll(store, secrets, "product-variants", {}, (meta) => {
        for (const m of (meta.product_variants ?? []) as Array<{ products_stock_id: number; products_stock_attributes: string }>) {
          attrsByVariant.set(String(m.products_stock_id), m.products_stock_attributes);
        }
      })
      : [];

    // Fargesett («Farger Filcolana») og fargeverdier («111 Pumpkin») for variantene
    const sett = new Map<string, string>();
    const verdier = new Set<string>();
    for (const a of attrsByVariant.values()) for (const [, v] of optionPairs(a)) verdier.add(v);
    let farger = new Map<string, string>();
    if (verdier.size) {
      try {
        for (const o of await getAll(store, secrets, "product-options")) {
          const n = nameOf(o.attributes);
          if (n) sett.set(o.id, n);
        }
      } catch (e) {
        console.error(`[mystore] ${store.name}: fargesett feilet: ${(e as Error).message}`);
      }
      farger = await loadColorValues(store, secrets, verdier);
    }

    const productById = new Map(products.map((p) => [p.id, p]));
    const isActive = (p: JsonApiResource | undefined) => !p || Number(p.attributes.status ?? 1) !== 0;

    // Produkter som har varianter: lageret ligger på variantene
    const productsWithVariants = new Set<string>();
    const out: StockLine[] = [];
    for (const v of variants) {
      const rel = v.relationships?.product?.data;
      const pid = rel && !Array.isArray(rel) ? rel.id : null;
      if (pid) productsWithVariants.add(pid);
      const parent = pid ? productById.get(pid) : undefined;
      if (v.attributes.disabled || !isActive(parent)) continue;
      const produkt = parent ? nameOf(parent.attributes) : null;
      // Fargen er paret hvis sett heter «Farge…»; ellers det første (alle varianter har ett i dag).
      const par = optionPairs(attrsByVariant.get(v.id));
      const [settId, verdiId] = par.find(([o]) => /^farge/i.test(sett.get(o) ?? "")) ?? par[0] ?? [];
      const farge = verdiId ? farger.get(verdiId) ?? null : null;
      out.push({
        ean: normalizeEan(v.attributes.ean),
        sku: v.attributes.sku ? String(v.attributes.sku) : null,
        name: produkt && farge ? `${produkt} ${farge}` : produkt,
        qty: qtyOf(v.attributes),
        external_id: `v:${v.id}`,
        yarn: produkt,
        color: farge,
        brand: settId ? sett.get(settId) ?? null : null,
      });
    }
    for (const p of products) {
      if (productsWithVariants.has(p.id) || !isActive(p)) continue;
      out.push({
        ean: normalizeEan(p.attributes.ean),
        sku: p.attributes.sku ? String(p.attributes.sku) : null,
        name: nameOf(p.attributes),
        qty: qtyOf(p.attributes),
        external_id: `p:${p.id}`,
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
