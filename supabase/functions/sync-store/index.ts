/**
 * sync-store: leser lager fra butikkens kassesystem og speiler det til Supabase + Shopify.
 *
 * Kall:
 *   { "mode": "due" }            – synk butikker som er "due" (pg_cron hvert 5. min; hver butikk hvert 15.)
 *   { "store_id": "<uuid>" }     – synk én butikk nå
 *   { "store_id": "...", "dry_run": true }  – hent og match, ikke skriv til Shopify
 *
 * Auth: x-cron-secret.
 */
import { adminClient, audit, json, requireInternalSecret } from "../_shared/db.ts";
import { getAdapter } from "../_shared/adapters/index.ts";
import { activateInventoryAtLocation, setAvailableQuantities, setStockByStoreMetafields } from "../_shared/shopify.ts";
import type { ProductRow, StoreRow } from "../_shared/types.ts";
import { matchLines } from "../_shared/matching.ts";

const SYNC_INTERVAL_MIN = Number(Deno.env.get("SYNC_INTERVAL_MIN") ?? 15);

Deno.serve(async (req) => {
  const unauthorized = requireInternalSecret(req);
  if (unauthorized) return unauthorized;
  const body = await req.json().catch(() => ({}));
  const db = adminClient();

  let stores: StoreRow[] = [];
  if (body.store_id) {
    const { data } = await db.from("stores").select("*").eq("id", body.store_id).single();
    if (data) stores = [data];
  } else {
    const { data } = await db.from("stores").select("*").eq("active", true).in("pos_system", ["duell", "mystore", "csv"]);
    const cutoff = Date.now() - SYNC_INTERVAL_MIN * 60 * 1000;
    stores = (data ?? []).filter((s: StoreRow) => !s.last_sync_at || new Date(s.last_sync_at).getTime() < cutoff);
  }

  const results: Record<string, unknown>[] = [];
  for (const store of stores) {
    results.push(await syncOne(store, !!body.dry_run));
  }
  return json({ synced: results.length, results });
});

async function syncOne(store: StoreRow, dryRun: boolean) {
  const db = adminClient();
  const { data: run } = await db.from("sync_runs").insert({ store_id: store.id }).select().single();
  const runId = run?.id;
  try {
    const { data: sec } = await db.from("store_secrets").select("secrets").eq("store_id", store.id).maybeSingle();
    const adapter = getAdapter(store.pos_system);
    const lines = await adapter.fetchStock(store, (sec?.secrets ?? {}) as Record<string, string>);

    const { data: products } = await db.from("products").select("*").eq("active", true);
    const { matched, unmatched } = matchLines(lines, products ?? []);

    // Slå sammen duplikater (samme produkt kan komme flere ganger, f.eks. flere avdelinger)
    const qtyByProduct = new Map<string, number>();
    for (const { product, line } of matched) qtyByProduct.set(product.id, (qtyByProduct.get(product.id) ?? 0) + line.qty);

    // Forrige tilstand for diff
    const { data: prev } = await db.from("inventory").select("product_id, qty").eq("store_id", store.id);
    const prevMap = new Map((prev ?? []).map((r: { product_id: string; qty: number }) => [r.product_id, r.qty]));

    const upserts: Array<{ store_id: string; product_id: string; qty_raw: number; qty: number; synced_at: string }> = [];
    const changes: Array<{ product: ProductRow; qty: number }> = [];
    const now = new Date().toISOString();
    const productById = new Map((products ?? []).map((p: ProductRow) => [p.id, p]));

    // Produkter Garnly selger som butikken ikke rapporterte: 0
    for (const p of products ?? []) if (!qtyByProduct.has(p.id)) qtyByProduct.set(p.id, 0);

    for (const [productId, raw] of qtyByProduct) {
      const qty = Math.max(0, raw - store.safety_stock);
      upserts.push({ store_id: store.id, product_id: productId, qty_raw: raw, qty, synced_at: now });
      if (prevMap.get(productId) !== qty) changes.push({ product: productById.get(productId)!, qty });
    }

    for (let i = 0; i < upserts.length; i += 1000) {
      const { error } = await db.from("inventory").upsert(upserts.slice(i, i + 1000), { onConflict: "store_id,product_id" });
      if (error) throw new Error("inventory upsert: " + error.message);
    }

    // Unmatched
    if (unmatched.length) {
      const rows = unmatched.filter((u) => u.ean || u.sku).map((u) => ({
        store_id: store.id, ean: u.ean, sku: u.sku, name: u.name, qty: u.qty, last_seen: now,
      }));
      for (let i = 0; i < rows.length; i += 500) {
        await db.from("unmatched_items").upsert(rows.slice(i, i + 500), { onConflict: "store_id,ean,sku", ignoreDuplicates: false });
      }
    }

    // Shopify
    let shopifyWritten = 0;
    if (!dryRun && store.shopify_location_id && changes.length) {
      const withItem = changes.filter((c) => c.product.shopify_inventory_item_id);
      // Første synk: aktiver items på location (idempotent, men koster ett kall per item, så bare når prev var tom)
      if (prevMap.size === 0) {
        await activateInventoryAtLocation(withItem.map((c) => c.product.shopify_inventory_item_id!), store.shopify_location_id);
      }
      await setAvailableQuantities(withItem.map((c) => ({
        inventoryItemId: c.product.shopify_inventory_item_id!,
        locationId: store.shopify_location_id!,
        quantity: c.qty,
      })));
      shopifyWritten = withItem.length;

      // Metafelt for kassevalidering (§7): stock per location på hver endret variant
      const ids = withItem.map((c) => c.product.id);
      const { data: allLoc } = await db.from("inventory").select("product_id, qty, stores!inner(shopify_location_id)").in("product_id", ids);
      const byVariant = new Map<string, Record<string, number>>();
      for (const r of (allLoc ?? []) as any[]) {
        const p = productById.get(r.product_id);
        if (!p?.shopify_variant_id || !r.stores?.shopify_location_id) continue;
        const m = byVariant.get(p.shopify_variant_id) ?? {};
        m[r.stores.shopify_location_id] = r.qty;
        byVariant.set(p.shopify_variant_id, m);
      }
      await setStockByStoreMetafields([...byVariant].map(([variantId, stockByLocation]) => ({ variantId, stockByLocation })));
    }

    await db.from("stores").update({ last_sync_at: now, last_sync_status: "ok", last_sync_rows: lines.length, consecutive_sync_failures: 0 }).eq("id", store.id);
    await db.from("sync_runs").update({ finished_at: now, status: "ok", rows_read: lines.length, rows_matched: matched.length, rows_changed: changes.length }).eq("id", runId);
    return { store: store.name, rows: lines.length, matched: matched.length, unmatched: unmatched.length, changed: changes.length, shopify_written: shopifyWritten, dry_run: dryRun };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[sync ${store.name}]`, msg);
    const failures = store.consecutive_sync_failures + 1;
    await db.from("stores").update({ last_sync_at: new Date().toISOString(), last_sync_status: "error: " + msg.slice(0, 200), consecutive_sync_failures: failures }).eq("id", store.id);
    await db.from("sync_runs").update({ finished_at: new Date().toISOString(), status: "error", error: msg }).eq("id", runId);
    await audit("store", store.id, "sync_failed", { error: msg, failures });
    if (failures === 3) {
      const { notifyOps } = await import("../_shared/notify.ts");
      await notifyOps(`Synk feiler for ${store.name}`, `3 synker på rad har feilet.\n\n${msg}`);
    }
    return { store: store.name, error: msg };
  }
}
