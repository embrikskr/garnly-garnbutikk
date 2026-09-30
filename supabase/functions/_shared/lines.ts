/**
 * REN logikk for varelinjene butikken skal plukke fra.
 *
 * `line_items` på routing_groups lagret opprinnelig bare `title`, som er Shopifys
 * *produkt*navn. På kortet sto det «Merinoull» – uten farge, uten strekkode, uten bilde – og
 * butikken måtte gjette hvilket nøste av tretti de skulle hente. Derfor lagres varianttittel,
 * SKU, strekkode og bilde-URL sammen med linja, på det tidspunktet ordren kom inn.
 *
 * Feltene denormaliseres bevisst i stedet for å leses fra `products` ved visning: da viser
 * kortet det kunden faktisk kjøpte, selv om produktet senere endres eller avpubliseres.
 *
 * Garnpakker har ingen strekkode og ingen variantbilde – variantene er størrelser (XS, S, M).
 * Innholdet står i Shopify-metafeltet `garnly.garn_innhold`, én garnsort per linje. Det er
 * ikke en Shopify-bundle, så `productVariantComponents` er tomt; metafeltet er eneste kilde.
 */

import type { LineItem } from "./types.ts";

/** Shopify-noden vi bygger linja av. Typen er med vilje løs, så gamle svar også går inn. */
export interface ShopifyLinjeNode {
  id: string;
  remainingQuantity: number;
  lineItem: {
    title: string;
    variant?: {
      id: string;
      title?: string | null;
      sku?: string | null;
      barcode?: string | null;
      image?: { url?: string | null } | null;
      product?: {
        productType?: string | null;
        tags?: string[] | null;
        featuredImage?: { url?: string | null } | null;
        metafield?: { value?: string | null } | null;
      } | null;
    } | null;
  };
}

/** «Default Title» er Shopifys plassholder for produkter uten varianter. Den skal ikke vises. */
export function variantTittel(title: string | null | undefined): string | null {
  const t = (title ?? "").trim();
  return !t || t === "Default Title" ? null : t;
}

/**
 * Garnpakke? Samme regel som i sync-products: Shopifys egen productType eller tag.
 * Aldri navnemønster – ved butikkflyttingen 27.09 fikk produktene nye navn, og et unntak
 * basert på «Yarn kit%» sluttet stilltiende å virke.
 */
export function erGarnpakke(product: { productType?: string | null; tags?: string[] | null } | null | undefined): boolean {
  if (!product) return false;
  if ((product.productType ?? "").trim().toLowerCase() === "garnpakke") return true;
  return (product.tags ?? []).some((t) => t.trim().toLowerCase() === "garnpakke");
}

/** Innholdet i en garnpakke, én garnsort per linje. Tåler tomme linjer og \r\n. */
export function kitLinjer(metafelt: string | null | undefined, maks = 12): string[] {
  return String(metafelt ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, maks);
}

/** Variantbildet hvis det finnes, ellers produktbildet. */
export function bildeUrl(v: ShopifyLinjeNode["lineItem"]["variant"]): string | null {
  return v?.image?.url ?? v?.product?.featuredImage?.url ?? null;
}

/** Bygger én varelinje. Beløpene regnes ut av den som kaller, siden de avhenger av andelen. */
export function byggLinje(
  node: ShopifyLinjeNode,
  productId: string,
  amountIncVat: number,
  vatAmount: number,
): LineItem {
  const v = node.lineItem.variant;
  const garnpakke = erGarnpakke(v?.product);
  const innhold = garnpakke ? kitLinjer(v?.product?.metafield?.value) : [];
  return {
    line_item_id: node.id,
    variant_id: v!.id,
    product_id: productId,
    qty: node.remainingQuantity,
    title: node.lineItem.title,
    variant_title: variantTittel(v?.title),
    sku: v?.sku?.trim() || null,
    barcode: v?.barcode?.trim() || null,
    image_url: bildeUrl(v),
    ...(innhold.length ? { kit_contents: innhold } : {}),
    amount_inc_vat: amountIncVat,
    vat_amount: vatAmount,
  };
}
