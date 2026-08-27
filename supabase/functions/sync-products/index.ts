/**
 * sync-products: speiler Shopify-varianter inn i products-tabellen (id-er, EAN, SKU, navn).
 * Kjøres manuelt etter produktendringer i Shopify, eller daglig via cron.
 *
 * Navn parses til brand / yarn_name / color_name for navnematching (§5), f.eks.
 *   vendor "Sandnes Garn", title "Lun Merino – Hvit"  → brand=Sandnes Garn, yarn=Lun Merino, color=Hvit
 *   variant-title "4372 Dyp Burgunder" (hvis farger er varianter) → color_code=4372, color_name=Dyp Burgunder
 */
import { adminClient, json, requireInternalSecret } from "../_shared/db.ts";
import { iterateVariants } from "../_shared/shopify.ts";
import { normalizeEan } from "../_shared/adapters/types.ts";

Deno.serve(async (req) => {
  const unauthorized = requireInternalSecret(req);
  if (unauthorized) return unauthorized;
  const db = adminClient();
  let seen = 0, upserted = 0, withEan = 0;
  const rows: Record<string, unknown>[] = [];
  const seenVariantIds: string[] = [];

  for await (const v of iterateVariants()) {
    seen++;
    if (v.product.status === "ARCHIVED") continue;
    const parsed = parseName(v.product.vendor, v.product.title, v.title);
    const ean = normalizeEan(v.barcode);
    if (ean) withEan++;
    seenVariantIds.push(v.id);
    rows.push({
      shopify_variant_id: v.id,
      shopify_product_id: v.product.id,
      shopify_inventory_item_id: v.inventoryItem.id,
      ean,
      sku: v.sku || null,
      name: v.title === "Default Title" ? v.product.title : `${v.product.title} – ${v.title}`,
      brand: parsed.brand, yarn_name: parsed.yarn, color_code: parsed.colorCode, color_name: parsed.colorName,
      active: v.product.status === "ACTIVE",
    });
  }
  for (let i = 0; i < rows.length; i += 200) {
    const { error, data } = await db.from("products").upsert(rows.slice(i, i + 200), { onConflict: "shopify_variant_id" }).select("id");
    if (error) return json({ error: error.message, at: i }, 500);
    upserted += data?.length ?? 0;
  }
  // Varianter som er borte fra Shopify deaktiveres
  if (seenVariantIds.length) {
    await db.from("products").update({ active: false }).not("shopify_variant_id", "in", `(${seenVariantIds.map((s) => `"${s}"`).join(",")})`);
  }
  return json({ seen, upserted, with_ean: withEan, without_ean: rows.length - withEan });
});

export function parseName(vendor: string | null, productTitle: string, variantTitle: string) {
  const brand = vendor?.trim() || null;
  let yarn = productTitle.trim();
  let colorName: string | null = null;
  let colorCode: string | null = null;
  // "Lun Merino – Hvit" / "Lun Merino - Hvit"
  const m = productTitle.match(/^(.*?)\s+[–—-]\s+(.+)$/);
  if (m) { yarn = m[1].trim(); colorName = m[2].trim(); }
  if (variantTitle && variantTitle !== "Default Title") {
    const vm = variantTitle.match(/^(\d{3,5})\s+(.+)$/);
    if (vm) { colorCode = vm[1]; colorName = vm[2].trim(); } else colorName = variantTitle.trim();
  }
  if (colorName) {
    const cm = colorName.match(/^(\d{3,5})\s+(.+)$/);
    if (cm) { colorCode = cm[1]; colorName = cm[2].trim(); }
  }
  return { brand, yarn, colorCode, colorName };
}
