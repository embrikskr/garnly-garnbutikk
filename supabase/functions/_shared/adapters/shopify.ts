/**
 * Shopify-adapter: lager fra en partnerbutikks egen Shopify (først KreStoffer, Odense).
 *
 * Butikken har installert Garnly-appen (se _shared/shopify_oauth.ts og shopify-partner-app/);
 * nøkkelen ligger i store_secrets og hentes og fornyes av partnerGql. `secrets`-argumentet
 * brukes derfor ikke her.
 *
 * Feltene er sjekket mot Admin API 2026-10 (11.11.2026), mot Garnlys egen butikk:
 *   locations { id name isActive fulfillsOnlineOrders }
 *   location.inventoryLevels { quantities(names: ["available"]) item { id sku tracked
 *     variants(first: 1) { id title barcodes { value } product { title vendor status } } } }
 *
 * Antallet er «available», ikke «on_hand»: det butikken alt har solgt i egen nettbutikk og ikke
 * sendt ennå, er ikke ledig for Garnly. Varer uten lagersporing (tracked = false) har ikke noe
 * meningsfullt antall og hoppes over.
 *
 * pos_config: { "shop_domain": "navn.myshopify.com", "location_id"?: "gid://shopify/Location/…" }
 * Har butikken én aktiv lokasjon for nettordrer, brukes den. Har den flere, må location_id settes.
 *
 * external_id (for product_aliases) = "v:<variant-id>".
 */
import { partnerGql } from "../partner_shop.ts";
import type { StockLine, StoreRow } from "../types.ts";
import { AdapterError, normalizeEan, type PosAdapter } from "./types.ts";

/** 100 per side: med variant og strekkoder per nivå blir 250 for dyrt for Shopifys kostnadsgrense. */
const SIDE = 100;

export interface Lokasjon {
  id: string;
  name: string;
  isActive: boolean;
  fulfillsOnlineOrders: boolean;
}

export interface NivaNode {
  quantities: Array<{ name: string; quantity: number }>;
  item: {
    id: string;
    sku: string | null;
    tracked: boolean;
    variants: {
      nodes: Array<{
        id: string;
        title: string | null;
        barcodes: { nodes: Array<{ value: string }> };
        product: { title: string; vendor: string | null; status: string } | null;
      }>;
    };
  } | null;
}

/** Lokasjonen lageret leses fra. REN logikk. */
export function velgLokasjon(lokasjoner: Lokasjon[], valgt: string | null | undefined): Lokasjon {
  if (valgt) {
    const l = lokasjoner.find((x) => x.id === valgt);
    if (!l) throw new AdapterError(`Lokasjonen ${valgt} (pos_config.location_id) finnes ikke i butikkens Shopify.`);
    return l;
  }
  const aktive = lokasjoner.filter((l) => l.isActive && l.fulfillsOnlineOrders);
  if (aktive.length === 1) return aktive[0];
  if (!aktive.length) throw new AdapterError("Butikken har ingen aktiv lokasjon for nettordrer i Shopify.");
  throw new AdapterError(
    `Butikken har ${aktive.length} lokasjoner (${aktive.map((l) => `${l.name} = ${l.id}`).join(", ")}). ` +
      "Sett pos_config.location_id til den nettlageret ligger på.",
  );
}

/** Shopifys standardnavn på en vare uten varianter. Det er ikke en farge. */
const UTEN_VARIANT = "Default Title";

/** Lagernivåene fra Shopify som lagerlinjer. REN logikk. */
export function tilLagerlinjer(noder: NivaNode[]): StockLine[] {
  const ut: StockLine[] = [];
  for (const n of noder) {
    const item = n.item;
    const v = item?.variants.nodes[0];
    if (!item || !v || !item.tracked) continue;
    const antall = n.quantities.find((q) => q.name === "available")?.quantity ?? 0;
    const produkt = v.product?.title?.trim() ?? "";
    const farge = v.title && v.title !== UTEN_VARIANT ? v.title.trim() : null;
    const ean = v.barcodes.nodes.map((b) => normalizeEan(b.value)).find((e) => e) ?? null;
    ut.push({
      ean,
      sku: item.sku?.trim() || null,
      name: farge ? `${produkt} ${farge}` : produkt || null,
      // Negativt «available» betyr oversolgt i egen butikk: ingenting ledig for Garnly.
      qty: Math.max(0, antall),
      external_id: `v:${v.id.split("/").pop()}`,
      yarn: produkt || null,
      color: farge,
      brand: v.product?.vendor?.trim() || null,
    });
  }
  return ut;
}

const LOKASJONER = `query { locations(first: 50) { nodes { id name isActive fulfillsOnlineOrders } } }`;

const NIVAER = `query Lager($id: ID!, $after: String) {
  location(id: $id) {
    inventoryLevels(first: ${SIDE}, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        quantities(names: ["available"]) { name quantity }
        item { id sku tracked
          variants(first: 1) { nodes { id title barcodes(first: 3) { nodes { value } } product { title vendor status } } } }
      }
    }
  }
}`;

async function hentLager(store: StoreRow): Promise<StockLine[]> {
  const lok = await partnerGql<{ locations: { nodes: Lokasjon[] } }>(store.id, LOKASJONER);
  const valgt = (store.pos_config as { location_id?: string } | null)?.location_id;
  const lokasjon = velgLokasjon(lok.locations.nodes, valgt);

  const noder: NivaNode[] = [];
  let after: string | null = null;
  for (let side = 0; side < 500; side++) {
    const res: { location: { inventoryLevels: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: NivaNode[] } } | null } =
      await partnerGql(store.id, NIVAER, { id: lokasjon.id, after });
    const conn = res.location?.inventoryLevels;
    if (!conn) throw new AdapterError(`Fikk ikke lest lokasjonen ${lokasjon.name} i butikkens Shopify.`);
    noder.push(...conn.nodes);
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return tilLagerlinjer(noder);
}

export const shopifyAdapter: PosAdapter = {
  system: "shopify",
  fetchStock: (store) => hentLager(store),
  async fetchStockFor(store, _secrets, eans) {
    const vil = new Set(eans.map((e) => normalizeEan(e)).filter(Boolean));
    const m = new Map<string, number>();
    for (const l of await hentLager(store)) if (l.ean && vil.has(l.ean)) m.set(l.ean, (m.get(l.ean) ?? 0) + l.qty);
    return m;
  },
};
