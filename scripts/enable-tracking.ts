/**
 * enable-tracking: slår på lagersporing (inventoryItem.tracked = true) på alle varianter i
 * Shopify som ikke allerede spores. Uten sporing selger Shopify ubegrenset (oversell); med
 * sporing på begrenses salg til faktisk lager, og varer ingen butikk fører vises som utsolgt.
 *
 * Idempotent og gjenopptakbart: hopper over varianter som allerede har tracked=true, og
 * arkiverte produkter. Trygt å kjøre flere ganger.
 *
 * Bruk:  deno run --allow-net --allow-env scripts/enable-tracking.ts [--apply]
 *   uten --apply: teller bare hvor mange som ville blitt endret (tørrkjøring)
 *   med  --apply: skrur på sporing
 * Env:   SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, SHOPIFY_API_VERSION
 */
import { enableTracking, iterateVariants } from "../supabase/functions/_shared/shopify.ts";

const apply = Deno.args.includes("--apply");

let seen = 0, alreadyTracked = 0, archived = 0, toEnable = 0, enabled = 0;
const batch: string[] = [];

async function flush() {
  if (!batch.length) return;
  await enableTracking(batch.splice(0)); // enableTracking tar en liste og kaller per item
}

for await (const v of iterateVariants()) {
  seen++;
  if (v.product.status === "ARCHIVED") { archived++; continue; }
  if (v.inventoryItem.tracked) { alreadyTracked++; continue; }
  toEnable++;
  if (!apply) continue;
  batch.push(v.inventoryItem.id);
  if (batch.length >= 50) {
    await flush();
    enabled += 50;
    if (enabled % 500 === 0) console.log(`  ${enabled} slått på …`);
  }
}
if (apply) {
  const rest = batch.length;
  await flush();
  enabled += rest;
}

console.log(`\nSett: ${seen} varianter. Allerede sporet: ${alreadyTracked}. Arkiverte (hoppet over): ${archived}.`);
if (apply) console.log(`Lagersporing slått PÅ for ${enabled} varianter.`);
else console.log(`${toEnable} varianter ville fått lagersporing på. Kjør med --apply for å gjøre det.`);
