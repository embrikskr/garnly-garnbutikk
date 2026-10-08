/**
 * sync-products: speiler Shopify-varianter inn i products-tabellen (id-er, EAN, SKU, navn).
 * Kjøres manuelt etter produktendringer i Shopify, eller daglig via cron.
 *
 * Navn parses til brand / yarn_name / color_name for navnematching (§5), f.eks.
 *   vendor "Sandnes Garn", title "Lun Merino – Hvit"  → brand=Sandnes Garn, yarn=Lun Merino, color=Hvit
 *   variant-title "4372 Dyp Burgunder" (hvis farger er varianter) → color_code=4372, color_name=Dyp Burgunder
 */
import { adminClient, json, requireInternalSecret } from "../_shared/db.ts";
import { ensureVariantsTracked, iterateVariants } from "../_shared/shopify.ts";
import { normalizeEan } from "../_shared/adapters/types.ts";
import { gramFraShopify } from "../_shared/shipping/consignment.ts";
import { erGarnpakke } from "../_shared/lines.ts";
import { assignEans, type EanRow, staleEanHolders } from "../_shared/ean.ts";

Deno.serve(async (req) => {
  const unauthorized = requireInternalSecret(req);
  if (unauthorized) return unauthorized;
  const db = adminClient();
  let seen = 0, upserted = 0, withEan = 0;
  const rows: Array<Record<string, unknown> & EanRow> = [];
  const seenVariantIds: string[] = [];
  const untracked = new Map<string, string[]>();
  const garnpakkeVarianter: string[] = [];

  for await (const v of iterateVariants()) {
    seen++;
    if (v.product.status === "ARCHIVED") continue;
    const parsed = parseName(v.product.vendor, v.product.title, v.title);
    const ean = normalizeEan(v.barcode);
    if (ean) withEan++;
    seenVariantIds.push(v.id);
    // Garnpakker skal ALDRI få lagersporing. De settes sammen av garn butikken alt har,
    // så rutingen avgjør om de kan lages – ikke et lagertall. Slår vi på sporing, står de
    // med null og vises som utsolgt.
    //
    // Unntaket henger på Shopify-data (productType/tag), ikke på exclude_from_sync eller
    // navnemønster. Ved flyttingen 27.09 fikk produktene nye id-er og nye norske navn, og
    // et unntak basert på «Yarn kit%» ville stilltiende sluttet å virke. Dette overlever
    // neste flytting.
    if (erGarnpakke(v.product)) garnpakkeVarianter.push(v.id);
    else if (!v.inventoryItem.tracked) {
      untracked.set(v.product.id, [...(untracked.get(v.product.id) ?? []), v.id]);
    }
    rows.push({
      shopify_variant_id: v.id,
      shopify_product_id: v.product.id,
      shopify_inventory_item_id: v.inventoryItem.id,
      ean,
      sku: v.sku || null,
      name: v.title === "Default Title" ? v.product.title : `${v.product.title} – ${v.title}`,
      brand: parsed.brand, yarn_name: parsed.yarn, color_code: parsed.colorCode, color_name: parsed.colorName,
      // Vekten brukes til fraktbestillingen i panelet. Er den ikke satt i Shopify, står
      // kolonnen tom, og _shared/shipping/consignment.ts regner med en fallback per vare.
      grams: gramFraShopify(v.inventoryItem?.measurement?.weight?.value, v.inventoryItem?.measurement?.weight?.unit),
      active: v.product.status === "ACTIVE",
    });
  }
  // products.ean er unik: samme strekkode på to varianter (en farge flyttet til et annet produkt,
  // med utkastet igjen) gir EAN-en til den aktive, og raden som hadde den fra før mister den.
  const { rows: unike, duplicates } = assignEans(rows);
  const eksisterende: Array<{ id: string; ean: string | null; shopify_variant_id: string | null }> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("products").select("id, ean, shopify_variant_id").not("ean", "is", null).order("id").range(from, from + 999);
    if (error) return json({ error: error.message, at: "ean-oppslag" }, 500);
    eksisterende.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const frigjor = staleEanHolders(eksisterende, unike);
  for (let i = 0; i < frigjor.length; i += 200) {
    const { error } = await db.from("products").update({ ean: null }).in("id", frigjor.slice(i, i + 200));
    if (error) return json({ error: error.message, at: "ean-frigjoring" }, 500);
  }
  for (let i = 0; i < unike.length; i += 200) {
    const { error, data } = await db.from("products").upsert(unike.slice(i, i + 200), { onConflict: "shopify_variant_id" }).select("id");
    if (error) return json({ error: error.message, at: i }, 500);
    upserted += data?.length ?? 0;
  }
  // Garnpakker skal heller ikke ha lager skrevet fra kassesystemene. Ved flyttingen
  // fikk de nye rader, og unntaket fra 003 (som traff «Yarn kit%») gjelder ikke lenger.
  // Settes bare til true, aldri til false: manuelle unntak på andre produkter skal stå.
  let ekskludert = 0;
  for (let i = 0; i < garnpakkeVarianter.length; i += 200) {
    const { error, data } = await db.from("products").update({ exclude_from_sync: true })
      .in("shopify_variant_id", garnpakkeVarianter.slice(i, i + 200)).select("id");
    if (error) return json({ error: error.message, at: "garnpakke-unntak" }, 500);
    ekskludert += data?.length ?? 0;
  }

  // Varianter som er borte fra Shopify deaktiveres
  if (seenVariantIds.length) {
    await db.from("products").update({ active: false }).not("shopify_variant_id", "in", `(${seenVariantIds.map((s) => `"${s}"`).join(",")})`);
  }
  // Lagersporing må være på for at antall per location skal styre salg (§4)
  const tracked = await ensureVariantsTracked(untracked);
  return json({
    seen, upserted, with_ean: withEan, without_ean: rows.length - withEan, tracking_enabled: tracked, garnpakker_unntatt: ekskludert,
    ean_flyttet: frigjor.length, ean_duplikater: duplicates,
  });
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

/** Garnpakke? Kjennes på productType eller tag i Shopify, ikke på navn. */
