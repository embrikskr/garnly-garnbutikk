/**
 * backfill-store-inventory: første gangs lagerskriving til Shopify for én butikk.
 *
 * Bakgrunn: cron-synken (sync-store) skriver lager i bakgrunnen med et begrenset tidsbudsjett.
 * En butikks aller første synk må aktivere + slå på lagersporing på tusenvis av varianter, noe
 * som ikke rekkes innenfor én Edge Function-kjøring. Dette verktøyet gjør den tunge engangsjobben
 * fra en maskin uten tidsgrense, gjenopptakbart, og markerer inventory.shopify_activated slik at
 * de påfølgende cron-synkene bare håndterer små endringer.
 *
 * Forutsetter at sync-store allerede har kjørt (dry_run er nok) så inventory-tabellen er fylt.
 * Skriver KUN varer med qty > 0 (varianter uten lager får ingen inventory level på locationen).
 *
 * Bruk:  deno run --allow-net --allow-env scripts/backfill-store-inventory.ts <butikk-slug>
 * Env:   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import { activateInventoryAtLocation, enableTracking, setAvailableQuantities, setStockByStoreMetafields } from "../supabase/functions/_shared/shopify.ts";

const slug = Deno.args[0];
if (!slug) {
  console.error("Bruk: deno run ... scripts/backfill-store-inventory.ts <butikk-slug>");
  Deno.exit(1);
}

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

const { data: store } = await db.from("stores").select("*").eq("slug", slug).single();
if (!store) throw new Error(`Fant ikke butikk med slug ${slug}`);
if (!store.shopify_location_id) throw new Error(`${store.name} mangler shopify_location_id`);
console.log(`Backfill for ${store.name} → location ${store.shopify_location_id}`);

// Hent inventory qty>0 for butikken, join produkt (paginert)
interface Row { product_id: string; qty: number; shopify_activated: boolean; inventory_item_id: string | null; variant_id: string | null }
const rows: Row[] = [];
for (let from = 0;; from += 1000) {
  const { data, error } = await db
    .from("inventory")
    .select("product_id, qty, shopify_activated, products!inner(shopify_inventory_item_id, shopify_variant_id, exclude_from_sync)")
    .eq("store_id", store.id).gt("qty", 0).range(from, from + 999);
  if (error) throw new Error("inventory select: " + error.message);
  for (const r of (data ?? []) as any[]) {
    if (r.products.exclude_from_sync) continue;
    rows.push({ product_id: r.product_id, qty: r.qty, shopify_activated: r.shopify_activated, inventory_item_id: r.products.shopify_inventory_item_id, variant_id: r.products.shopify_variant_id });
  }
  if (!data || data.length < 1000) break;
}
const withItem = rows.filter((r) => r.inventory_item_id);
console.log(`${rows.length} varer med lager, ${withItem.length} med inventory item.`);

// 1) Aktiver + lagersporing for varer som ikke er aktivert (gjenopptakbart: marker i bolker)
const toActivate = withItem.filter((r) => !r.shopify_activated);
console.log(`Aktiverer ${toActivate.length} varer …`);
let done = 0;
for (const r of toActivate) {
  await enableTracking([r.inventory_item_id!]);
  await activateInventoryAtLocation([r.inventory_item_id!], store.shopify_location_id);
  await db.from("inventory").update({ shopify_activated: true }).eq("store_id", store.id).eq("product_id", r.product_id);
  if (++done % 50 === 0) console.log(`  ${done}/${toActivate.length} aktivert`);
}
console.log(`Aktivering ferdig (${done}).`);

// 2) Sett lager (batches på 250 håndteres i setAvailableQuantities)
console.log(`Skriver lager for ${withItem.length} varer …`);
await setAvailableQuantities(withItem.map((r) => ({ inventoryItemId: r.inventory_item_id!, locationId: store.shopify_location_id, quantity: r.qty })));

// 3) Metafelt garnly.stock_by_store per variant (§7)
const byVariant = new Map<string, Record<string, number>>();
for (const r of withItem) {
  if (!r.variant_id) continue;
  byVariant.set(r.variant_id, { [store.shopify_location_id]: r.qty });
}
console.log(`Skriver stock_by_store-metafelt for ${byVariant.size} varianter …`);
await setStockByStoreMetafields([...byVariant].map(([variantId, stockByLocation]) => ({ variantId, stockByLocation })));

console.log("Backfill ferdig. Videre lagerendringer håndteres av cron-synken.");
