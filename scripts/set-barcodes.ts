/**
 * set-barcodes: legger EAN (barcode) på Shopify-varianter fra en CSV og slår på lagersporing
 * (inventoryItem.tracked), som begge mangler i butikken i dag (STATUS.md, funn 27.08).
 * Uten strekkoder fungerer bare navnematching; dette verktøyet tar butikkenes produktlister
 * (EAN + navn) og skriver dem inn i Shopify. Mutasjonen er validert mot Admin API-skjemaet
 * (Shopify MCP validate_graphql_codeblocks, 2025-07).
 *
 * Bruk:
 *   deno task set-barcodes -- liste.csv              # tørrkjøring: viser hva som ville blitt gjort
 *   deno task set-barcodes -- liste.csv --apply      # skriv til Shopify
 *   deno task set-barcodes -- liste.csv --apply --track-all   # slå på sporing for ALLE varianter
 *
 * CSV: kolonner ean og name/navn (skilletegn ; eller , – samme format som CSV-adapteren).
 * Navnet matches mot «Produkttittel – Varianttittel» med normName, ev. med merke foran.
 * Env: SHOPIFY_SHOP, SHOPIFY_ADMIN_TOKEN (kjør gjerne med --env-file=.env).
 */
import { parseCsv } from "../supabase/functions/_shared/adapters/csv.ts";
import { normName } from "../supabase/functions/_shared/matching.ts";
import { gql, iterateVariants } from "../supabase/functions/_shared/shopify.ts";

const M = `mutation SetBarcodes($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { field message } } }`;

interface VariantUpdate {
  id: string;
  barcode?: string;
  inventoryItem?: { tracked: boolean };
}

const csvPath = Deno.args.find((a) => !a.startsWith("--"));
const apply = Deno.args.includes("--apply");
const trackAll = Deno.args.includes("--track-all");
if (!csvPath) {
  console.error("Bruk: deno task set-barcodes -- <fil.csv> [--apply] [--track-all]");
  Deno.exit(1);
}

const rows = parseCsv(await Deno.readTextFile(csvPath)).filter((r) => r.ean && r.name);
const eanByName = new Map<string, string>();
const ambiguous = new Set<string>();
for (const r of rows) {
  const key = normName(r.name!);
  if (eanByName.has(key) && eanByName.get(key) !== r.ean) ambiguous.add(key);
  eanByName.set(key, r.ean!);
}
// Samme navn med ulik EAN i CSV-en er utrygt å skrive – hopp over de navnene
for (const key of ambiguous) eanByName.delete(key);
console.log(`CSV: ${rows.length} rader med EAN+navn, ${eanByName.size} unike navn${ambiguous.size ? `, ${ambiguous.size} tvetydige hoppet over` : ""}`);

const updatesByProduct = new Map<string, VariantUpdate[]>();
const matchedKeys = new Set<string>();
const unmatchedVariants: string[] = [];
let setBarcode = 0, alreadyOk = 0, conflicts = 0, enableTracking = 0;

for await (const v of iterateVariants()) {
  if (v.product.status === "ARCHIVED") continue;
  const displayName = v.title === "Default Title" ? v.product.title : `${v.product.title} – ${v.title}`;
  const keys = [normName(displayName), normName(`${v.product.vendor ?? ""} ${displayName}`)];
  const matchKey = keys.find((k) => eanByName.has(k));
  const ean = matchKey ? eanByName.get(matchKey)! : null;

  const update: VariantUpdate = { id: v.id };
  if (ean) {
    matchedKeys.add(matchKey!);
    if (v.barcode && v.barcode !== ean) {
      conflicts++;
      console.warn(`KONFLIKT: «${displayName}» har barcode ${v.barcode}, CSV sier ${ean} – hopper over`);
    } else if (v.barcode === ean) {
      alreadyOk++;
    } else {
      update.barcode = ean;
      setBarcode++;
    }
  } else {
    unmatchedVariants.push(displayName);
  }
  if ((ean || trackAll) && !v.inventoryItem.tracked) {
    update.inventoryItem = { tracked: true };
    enableTracking++;
  }
  if (update.barcode || update.inventoryItem) {
    const list = updatesByProduct.get(v.product.id) ?? [];
    list.push(update);
    updatesByProduct.set(v.product.id, list);
  }
}

const unmatchedCsv = [...eanByName.keys()].filter((k) => !matchedKeys.has(k));
console.log(`\nShopify: ${setBarcode} varianter får EAN, ${alreadyOk} har riktig EAN fra før, ${conflicts} konflikter, ${enableTracking} får lagersporing`);
if (unmatchedVariants.length) {
  console.log(`\n${unmatchedVariants.length} Shopify-varianter uten treff i CSV:`);
  for (const n of unmatchedVariants.slice(0, 40)) console.log("  - " + n);
  if (unmatchedVariants.length > 40) console.log(`  … og ${unmatchedVariants.length - 40} til`);
}
if (unmatchedCsv.length) {
  console.log(`\n${unmatchedCsv.length} CSV-navn uten treff i Shopify:`);
  for (const n of unmatchedCsv.slice(0, 40)) console.log("  - " + n);
  if (unmatchedCsv.length > 40) console.log(`  … og ${unmatchedCsv.length - 40} til`);
}

if (!apply) {
  console.log("\nTørrkjøring – ingenting skrevet. Kjør med --apply for å skrive til Shopify.");
  Deno.exit(0);
}

let products = 0;
for (const [productId, variants] of updatesByProduct) {
  for (let i = 0; i < variants.length; i += 250) {
    const res = await gql(M, { productId, variants: variants.slice(i, i + 250) });
    const errs = res.productVariantsBulkUpdate?.userErrors ?? [];
    if (errs.length) console.error(`FEIL for ${productId}: ` + errs.map((e: { message: string }) => e.message).join("; "));
  }
  products++;
}
console.log(`\nSkrevet til ${products} produkter. Kjør sync-products etterpå så products-tabellen speiler endringene.`);
