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
import { activateInventoryAtLocation, enableTracking, setOnHandQuantities, setStockByStoreMetafields } from "../_shared/shopify.ts";
import type { ProductRow, StoreRow } from "../_shared/types.ts";
import { matchLines } from "../_shared/matching.ts";
import { sellableQty } from "../_shared/inventory.ts";
import { dueCutoff, isDue, scheduleFromEnv } from "../_shared/schedule.ts";

/**
 * Aktivering av nye varer på locationen koster to Shopify-kall per vare. Åpnes mange produkter
 * på en gang (35 utkast og ~1 000 farger 09.10.2026), rekkes det ikke i én kjøring. Da aktiveres
 * det i bolker til kjøringen har brukt så lang tid, og hver bolk markeres med en gang. Resten
 * er «strandet» (lager, men ikke aktivert) og tas av neste kjøring.
 */
const AKTIVER_TIL_MS = 240_000;
const AKTIVER_BOLK = 25;

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
    // Hvor ofte det synkes avgjøres i schedule.ts: sjeldnere om natten (lokal tid, så
    // sommertid følger med), og med slakk så 15-minutters-merket ikke havner mellom to
    // cron-tikk. Se filhodet der.
    const schedule = scheduleFromEnv();
    const cutoff = dueCutoff(new Date(), schedule);
    if (!cutoff) return json({ started: 0, skipped: "natt", night_interval_min: schedule.nightIntervalMin });
    const { data } = await db.from("stores").select("*").eq("active", true).in("pos_system", ["duell", "mystore", "csv"]);
    stores = (data ?? []).filter((s: StoreRow) => isDue(s.last_sync_at, cutoff));
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
  const start = Date.now();
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
    // Alias: kassesystemets egen id → Garnly-produkt, for varer uten brukbar EAN (007).
    const { data: aliasRows } = await db.from("product_aliases").select("external_id, product_id").eq("store_id", store.id);
    const aliases = new Map<string, string>((aliasRows ?? []).map((a: { external_id: string; product_id: string }) => [a.external_id, a.product_id]));
    const { matched, unmatched } = matchLines(lines, products, aliases);

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

    // Garnly-salg butikkens kasse ennå ikke har trukket fra. Se inventory.ts for hvorfor.
    // Endringer her slår gjennom i diffen under, fordi de inngår i qty: bekrefter butikken
    // et uttrekk, går tallet opp igjen og varen skrives til Shopify uten at kassa endret seg.
    const pendingByProduct = new Map<string, number>();
    for (let from = 0;; from += 1000) {
      const { data, error } = await db.from("v_pos_pending_deduction").select("product_id, qty").eq("store_id", store.id).range(from, from + 999);
      if (error) throw new Error("v_pos_pending_deduction select: " + error.message);
      for (const r of (data ?? []) as Array<{ product_id: string; qty: number }>) {
        pendingByProduct.set(r.product_id, (pendingByProduct.get(r.product_id) ?? 0) + Number(r.qty));
      }
      if (!data || data.length < 1000) break;
    }
    const ventende = [...pendingByProduct.values()].reduce((a, b) => a + b, 0);
    if (ventende) console.log(`[sync] ${store.name}: trekker fra ${ventende} enheter som venter på uttrekk i kassa`);

    const upserts: Array<{ store_id: string; product_id: string; qty_raw: number; qty: number; synced_at: string }> = [];
    const changes: Array<{ product: ProductRow; qty: number }> = [];
    const now = new Date().toISOString();
    const productById = new Map((products ?? []).map((p: ProductRow) => [p.id, p]));

    // Produkter Garnly selger som butikken ikke rapporterte: 0
    for (const p of products ?? []) if (!qtyByProduct.has(p.id)) qtyByProduct.set(p.id, 0);

    for (const [productId, raw] of qtyByProduct) {
      const qty = sellableQty(raw, store.safety_stock, pendingByProduct.get(productId) ?? 0);
      upserts.push({ store_id: store.id, product_id: productId, qty_raw: raw, qty, synced_at: now });
      if (prevMap.get(productId) !== qty) changes.push({ product: productById.get(productId)!, qty });
    }

    for (let i = 0; i < upserts.length; i += 1000) {
      const { error } = await db.from("inventory").upsert(upserts.slice(i, i + 1000), { onConflict: "store_id,product_id" });
      if (error) throw new Error("inventory upsert: " + error.message);
    }

    // Unmatched. Tom streng i stedet for NULL (NULL er "unik" i unique-constrainten).
    // Dedupliser på (ean, sku) FØR upsert: flere linjer kan dele samme nøkkel (samme ean
    // på produkt + variant, gjentatt varenr), og da nekter Postgres å røre raden to ganger
    // i én ON CONFLICT-batch (feilkode 21000). Summerer antallet for like nøkler.
    if (unmatched.length) {
      const byKey = new Map<string, { store_id: string; ean: string; sku: string; name: string | null; qty: number; last_seen: string }>();
      for (const u of unmatched) {
        // external_id som reserve: uten den blir Duell-varer uten EAN usynlige i umatchet-lista,
        // og da har man ingenting å lage alias fra.
        if (!u.ean && !u.sku && !u.external_id) continue;
        const ean = u.ean ?? "", sku = u.sku ?? u.external_id ?? "";
        const key = `${ean}${sku}`;
        const prev = byKey.get(key);
        if (prev) prev.qty += u.qty;
        else byKey.set(key, { store_id: store.id, ean, sku, name: u.name, qty: u.qty, last_seen: now });
      }
      const rows = [...byKey.values()];
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await db.from("unmatched_items").upsert(rows.slice(i, i + 500), { onConflict: "store_id,ean,sku", ignoreDuplicates: false });
        if (error) throw new Error("unmatched_items upsert: " + error.message);
      }
    }

    // Varer som skal røres i Shopify: de som har endret antall, PLUSS varer med lager som
    // ennå ikke er aktivert på locationen. Uten det andre blir en vare usynlig for alltid
    // hvis en kjøring dør mellom inventory-upserten over og Shopify-skrivingen under:
    // basen har da riktig antall, neste kjøring ser ingen endring, og varen får aldri noe
    // inventory level. Den viser seg som utsolgt i butikken selv om lageret er inne.
    const changed = new Set(changes.map((c) => c.product.id));
    const stranded: Array<{ product: ProductRow; qty: number }> = [];
    for (const [productId, raw] of qtyByProduct) {
      if (changed.has(productId) || activatedSet.has(productId)) continue;
      const qty = sellableQty(raw, store.safety_stock, pendingByProduct.get(productId) ?? 0);
      const product = productById.get(productId);
      if (qty > 0 && product) stranded.push({ product, qty });
    }
    if (stranded.length) console.log(`[sync] ${store.name}: ${stranded.length} varer med lager manglet aktivering, tas nå`);

    // Varer som nettopp er sendt eller slått ut i kassa skrives ALLTID, uavhengig av diff.
    //
    // Diffen over sammenligner mot vår egen forrige utregning, ikke mot Shopify. Endrer
    // Shopify on_hand selv – ved fulfillment, retur med restock eller manuell retting – og
    // vårt nye tall havner tilfeldigvis likt med det forrige, skrives ingenting og Shopify
    // blir stående feil. Reprodusert 29.09: #1002 ble sendt og slått ut i kassa mellom to
    // synker uten at kassetallet endret seg; synken regnet 55 = forrige 55 og hoppet over,
    // og Shopify ble stående på 52.
    //
    // Dette dekker de tilstandsskiftene vi selv kjenner til. Returer med restock og manuelle
    // endringer i Shopify-admin fanges av den nattlige avstemmingen (reconcile-inventory).
    const { data: recent, error: recentErr } = await db.from("v_pos_recent_transitions").select("product_id").eq("store_id", store.id);
    if (recentErr) throw new Error("v_pos_recent_transitions select: " + recentErr.message);
    const alt = new Set([...changed, ...stranded.map((s) => s.product.id)]);
    const transitions: Array<{ product: ProductRow; qty: number }> = [];
    for (const r of (recent ?? []) as Array<{ product_id: string }>) {
      if (alt.has(r.product_id)) continue;
      const product = productById.get(r.product_id);
      if (!product) continue;
      const raw = qtyByProduct.get(r.product_id) ?? 0;
      transitions.push({ product, qty: sellableQty(raw, store.safety_stock, pendingByProduct.get(r.product_id) ?? 0) });
      alt.add(r.product_id);
    }
    if (transitions.length) console.log(`[sync] ${store.name}: ${transitions.length} varer nettopp sendt/slått ut i kassa, skrives uansett diff`);

    const work = [...changes, ...stranded, ...transitions];

    // Shopify
    let shopifyWritten = 0;
    if (!dryRun && store.shopify_location_id && work.length) {
      const withItem = work.filter((c) => c.product.shopify_inventory_item_id);
      // Aktiver (lagersporing + inventoryActivate) bare varer som faktisk har lager.
      // Å aktivere alle 0-varer butikken ikke fører ville kostet tusenvis av kall ved
      // første synk; en vare uten inventory level på locationen vises uansett som utsolgt der.
      // Én gang per (butikk, produkt), sporet i inventory.shopify_activated.
      const toActivate = withItem.filter((c) => c.qty > 0 && !activatedSet.has(c.product.id));
      let aktivert = 0;
      for (let i = 0; i < toActivate.length && Date.now() - start < AKTIVER_TIL_MS; i += AKTIVER_BOLK) {
        const bolk = toActivate.slice(i, i + AKTIVER_BOLK);
        const itemIds = bolk.map((c) => c.product.shopify_inventory_item_id!);
        await enableTracking(itemIds);
        await activateInventoryAtLocation(itemIds, store.shopify_location_id);
        const { error } = await db.from("inventory").update({ shopify_activated: true }).eq("store_id", store.id).in("product_id", bolk.map((c) => c.product.id));
        if (error) throw new Error("inventory shopify_activated: " + error.message);
        for (const c of bolk) activatedSet.add(c.product.id);
        aktivert += bolk.length;
      }
      if (aktivert < toActivate.length) {
        console.log(`[sync] ${store.name}: aktiverte ${aktivert} av ${toActivate.length} nye varer, resten tas neste kjøring`);
      }
      // Skriv lager for varer som er aktivert (nå eller før). 0-varer som aldri ble aktivert
      // hoppes over – de har ingen inventory level på locationen og skal ikke ha det.
      const writable = withItem.filter((c) => activatedSet.has(c.product.id));
      await setOnHandQuantities(writable.map((c) => ({
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

    // last_sync_at settes IKKE her. Den ble satt da synken startet (claim over), og det er
    // riktig anker for frekvensen: flytter vi den til slutten, blir avstanden til neste synk
    // 15 min PLUSS kjøretiden. Strikkefryd bruker ~130 s, og drev dermed til 20 min mens
    // Garnkilden på ~45 s traff 15. Målt 27.09.2026.
    await db.from("stores").update({ last_sync_status: "ok", last_sync_rows: lines.length, consecutive_sync_failures: 0 }).eq("id", store.id);
    await db.from("sync_runs").update({ finished_at: now, status: "ok", rows_read: lines.length, rows_matched: matched.length, rows_changed: changes.length }).eq("id", runId);
    return { store: store.name, rows: lines.length, matched: matched.length, unmatched: unmatched.length, changed: changes.length, shopify_written: shopifyWritten, dry_run: dryRun };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[sync ${store.name}]`, msg);
    const failures = store.consecutive_sync_failures + 1;
    // Samme her: claim-tidspunktet står. En synk som feiler raskt skal ikke prøves igjen
    // umiddelbart, og en som feiler seint skal ikke skyve neste forsøk ekstra langt ut.
    await db.from("stores").update({ last_sync_status: "error: " + msg.slice(0, 200), consecutive_sync_failures: failures }).eq("id", store.id);
    await db.from("sync_runs").update({ finished_at: new Date().toISOString(), status: "error", error: msg }).eq("id", runId);
    await audit("store", store.id, "sync_failed", { error: msg, failures });
    if (failures === 3) {
      const { notifyOps } = await import("../_shared/notify.ts");
      await notifyOps(`Synk feiler for ${store.name}`, `3 synker på rad har feilet.\n\n${msg}`);
    }
    return { store: store.name, error: msg };
  }
}
