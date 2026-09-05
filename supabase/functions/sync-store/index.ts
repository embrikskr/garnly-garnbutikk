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
import { activateInventoryAtLocation, enableTracking, setAvailableQuantities, setStockByStoreMetafields } from "../_shared/shopify.ts";
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

  const work = (async () => {
    const results: Record<string, unknown>[] = [];
    for (const store of stores) {
      results.push(await syncOne(store, !!body.dry_run));
    }
    return results;
  })();

  // pg_cron-kallet (pg_net) har 120 s timeout, mens en full synk kan ta flere minutter.
  // Uten wait:true svarer vi derfor med en gang og fullfører i bakgrunnen; status
  // havner uansett i sync_runs. Manuelle kall kan sende {"wait":true} for å få resultatet.
  // @ts-ignore EdgeRuntime finnes i Supabase Edge Functions
  if (!body.wait && typeof EdgeRuntime !== "undefined") {
    // @ts-ignore
    EdgeRuntime.waitUntil(work.catch((e: unknown) => console.error("sync-store bakgrunnsfeil:", e)));
    return json({ started: stores.length, background: true });
  }
  const results = await work;
  return json({ synced: results.length, results });
});

async function syncOne(store: StoreRow, dryRun: boolean) {
  const db = adminClient();
  // Claim: sett last_sync_at med en gang så en overlappende cron-kjøring (synken går i
  // bakgrunnen og kan ta > 5 min) hopper over butikken via due-filteret i stedet for å
  // kjøre parallelt og klippe diffen. Ekte kjøring; dry_run rører ikke butikkstatus.
  if (!dryRun) await db.from("stores").update({ last_sync_at: new Date().toISOString() }).eq("id", store.id);
  const { data: run } = await db.from("sync_runs").insert({ store_id: store.id }).select().single();
  const runId = run?.id;
  try {
    const { data: sec } = await db.from("store_secrets").select("secrets").eq("store_id", store.id).maybeSingle();
    const adapter = getAdapter(store.pos_system);
    const lines = await adapter.fetchStock(store, (sec?.secrets ?? {}) as Record<string, string>);

    // PostgREST returnerer maks 1000 rader per kall – pagineres eksplisitt.
    // exclude_from_sync: bare garn skal synkes (003) – kits o.l. holdes helt utenfor.
    const products: ProductRow[] = [];
    for (let from = 0;; from += 1000) {
      const { data, error } = await db.from("products").select("*").eq("active", true).eq("exclude_from_sync", false).range(from, from + 999);
      if (error) throw new Error("products select: " + error.message);
      products.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
    const { matched, unmatched } = matchLines(lines, products);

    // Slå sammen duplikater (samme produkt kan komme flere ganger, f.eks. flere avdelinger)
    const qtyByProduct = new Map<string, number>();
    for (const { product, line } of matched) qtyByProduct.set(product.id, (qtyByProduct.get(product.id) ?? 0) + line.qty);

    // Forrige tilstand for diff (paginert, samme 1000-radersgrense)
    const prev: Array<{ product_id: string; qty: number; shopify_activated: boolean }> = [];
    for (let from = 0;; from += 1000) {
      const { data, error } = await db.from("inventory").select("product_id, qty, shopify_activated").eq("store_id", store.id).range(from, from + 999);
      if (error) throw new Error("inventory select: " + error.message);
      prev.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
    const prevMap = new Map(prev.map((r) => [r.product_id, r.qty]));
    const activatedSet = new Set(prev.filter((r) => r.shopify_activated).map((r) => r.product_id));

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
      // Tom streng i stedet for NULL: NULL er "unik" i unique-constrainten og gir duplikater
      const rows = unmatched.filter((u) => u.ean || u.sku).map((u) => ({
        store_id: store.id, ean: u.ean ?? "", sku: u.sku ?? "", name: u.name, qty: u.qty, last_seen: now,
      }));
      for (let i = 0; i < rows.length; i += 500) {
        await db.from("unmatched_items").upsert(rows.slice(i, i + 500), { onConflict: "store_id,ean,sku", ignoreDuplicates: false });
      }
    }

    // Shopify
    let shopifyWritten = 0;
    if (!dryRun && store.shopify_location_id && changes.length) {
      const withItem = changes.filter((c) => c.product.shopify_inventory_item_id);
      // Aktiver (lagersporing + inventoryActivate) bare varer som faktisk har lager.
      // Å aktivere alle 0-varer butikken ikke fører ville kostet tusenvis av kall ved
      // første synk; en vare uten inventory level på locationen vises uansett som utsolgt der.
      // Én gang per (butikk, produkt), sporet i inventory.shopify_activated.
      const toActivate = withItem.filter((c) => c.qty > 0 && !activatedSet.has(c.product.id));
      if (toActivate.length) {
        const itemIds = toActivate.map((c) => c.product.shopify_inventory_item_id!);
        await enableTracking(itemIds);
        await activateInventoryAtLocation(itemIds, store.shopify_location_id);
        for (let i = 0; i < toActivate.length; i += 500) {
          await db.from("inventory").update({ shopify_activated: true }).eq("store_id", store.id).in("product_id", toActivate.slice(i, i + 500).map((c) => c.product.id));
        }
        for (const c of toActivate) activatedSet.add(c.product.id);
      }
      // Skriv lager for varer som er aktivert (nå eller før). 0-varer som aldri ble aktivert
      // hoppes over – de har ingen inventory level på locationen og skal ikke ha det.
      const writable = withItem.filter((c) => activatedSet.has(c.product.id));
      await setAvailableQuantities(writable.map((c) => ({
        inventoryItemId: c.product.shopify_inventory_item_id!,
        locationId: store.shopify_location_id!,
        quantity: c.qty,
      })));
      shopifyWritten = writable.length;

      // Metafelt for kassevalidering (§7): stock per location på hver skrevet variant.
      // .in() med tusenvis av id-er sprenger URL-grensen – chunkes i bolker på 200.
      const ids = writable.map((c) => c.product.id);
      const allLoc: any[] = [];
      for (let i = 0; i < ids.length; i += 200) {
        const { data, error } = await db.from("inventory").select("product_id, qty, stores!inner(shopify_location_id)").in("product_id", ids.slice(i, i + 200));
        if (error) throw new Error("inventory metafelt-select: " + error.message);
        allLoc.push(...(data ?? []));
      }
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
