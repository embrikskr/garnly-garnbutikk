/**
 * reconcile-inventory: nattlig avstemming av lager mot Shopify.
 *
 * Hvorfor den finnes: `sync-store` skriver bare når den ser en differanse mot SIN EGEN forrige
 * utregning. Endrer Shopify `on_hand` på egen hånd – ved fulfillment, retur med restock eller
 * manuell retting i admin – og vårt nye tall havner likt med det forrige, skrives ingenting.
 * Shopify blir stående feil, uten en eneste feilmelding.
 *
 * Reprodusert 29.09: #1002 ble sendt og slått ut i kassa mellom to synker uten at kassetallet
 * endret seg. Synken regnet 55 = forrige 55 og hoppet over. Shopify ble stående på 52.
 *
 * `sync-store` fanger nå de tilstandsskiftene vi selv kjenner til (v_pos_recent_transitions).
 * Denne fanger resten: alt Shopify har gjort som vi ikke vet om.
 *
 * Kall: { } for alle butikker, { "store_id": "..." } for én, { "dry_run": true } for å bare
 * rapportere avvik. Auth: x-cron-secret.
 */
import { adminClient, audit, json, requireInternalSecret } from "../_shared/db.ts";
import { getOnHandByLocation, setOnHandQuantities } from "../_shared/shopify.ts";
import type { StoreRow } from "../_shared/types.ts";

/** Tak på hvor mange avvik vi retter i én kjøring. Er det flere, er noe grunnleggende galt. */
const MAKS_AVVIK = 1000;

Deno.serve(async (req) => {
  const unauthorized = requireInternalSecret(req);
  if (unauthorized) return unauthorized;
  const body = await req.json().catch(() => ({}));
  const db = adminClient();

  const q = db.from("stores").select("*").eq("active", true).not("shopify_location_id", "is", null);
  const { data: stores } = body.store_id ? await q.eq("id", body.store_id) : await q;

  const work = (async () => {
    const results: Record<string, unknown>[] = [];
    for (const store of (stores ?? []) as StoreRow[]) {
      results.push(await reconcileOne(store, !!body.dry_run));
    }
    return results;
  })();

  // Samme grunn som i sync-store: pg_net gir opp etter 120 s, og en full avstemming av to
  // butikker tar lengre tid. Status havner i audit_log uansett.
  // @ts-ignore EdgeRuntime finnes i Supabase Edge Functions
  if (!body.wait && typeof EdgeRuntime !== "undefined") {
    // @ts-ignore
    EdgeRuntime.waitUntil(work.catch((e: unknown) => console.error("reconcile-inventory bakgrunnsfeil:", e)));
    return json({ started: (stores ?? []).length, background: true });
  }
  return json({ results: await work });
});

async function reconcileOne(store: StoreRow, dryRun: boolean) {
  const locationId = store.shopify_location_id!;
  try {
    const iShopify = await getOnHandByLocation(locationId);

    // Vårt fasit-tall per produkt. exclude_from_sync holdes utenfor: garnpakker har ikke
    // lagersporing, og skal ikke røres.
    const rows: Array<{ qty: number; products: { shopify_inventory_item_id: string | null; exclude_from_sync: boolean } | null }> = [];
    for (let from = 0;; from += 1000) {
      const { data, error } = await db()
        .from("inventory")
        .select("qty, products!inner(shopify_inventory_item_id, exclude_from_sync)")
        .eq("store_id", store.id)
        .eq("shopify_activated", true)
        .range(from, from + 999);
      if (error) throw new Error("inventory select: " + error.message);
      rows.push(...((data ?? []) as unknown as typeof rows));
      if (!data || data.length < 1000) break;
    }

    const avvik: Array<{ inventoryItemId: string; locationId: string; quantity: number }> = [];
    const eksempler: Array<{ item: string; shopify: number; garnly: number }> = [];
    let sett = 0;
    for (const r of rows) {
      const p = Array.isArray(r.products) ? r.products[0] : r.products;
      const itemId = p?.shopify_inventory_item_id;
      if (!itemId || p?.exclude_from_sync) continue;
      const iShop = iShopify.get(itemId);
      // Varer uten inventory level på locationen hopper vi over: de har aldri blitt
      // aktivert der, og skal ikke aktiveres av en avstemming.
      if (iShop === undefined) continue;
      sett++;
      if (iShop === r.qty) continue;
      avvik.push({ inventoryItemId: itemId, locationId, quantity: r.qty });
      if (eksempler.length < 10) eksempler.push({ item: itemId, shopify: iShop, garnly: r.qty });
    }

    if (avvik.length > MAKS_AVVIK) {
      const msg = `${avvik.length} avvik (tak ${MAKS_AVVIK}) – retter ingenting`;
      await audit("store", store.id, "reconcile_abort", { avvik: avvik.length, eksempler });
      const { notifyOps } = await import("../_shared/notify.ts");
      await notifyOps(`Lageravstemming stoppet for ${store.name}`, `${msg}. Noe er grunnleggende galt; sjekk før du kjører på nytt.`);
      return { store: store.name, checked: sett, deviations: avvik.length, fixed: 0, aborted: true };
    }

    if (!dryRun && avvik.length) await setOnHandQuantities(avvik, "correction");
    if (avvik.length) await audit("store", store.id, "reconciled", { avvik: avvik.length, dry_run: dryRun, eksempler });

    return { store: store.name, checked: sett, deviations: avvik.length, fixed: dryRun ? 0 : avvik.length, dry_run: dryRun };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[reconcile ${store.name}]`, msg);
    await audit("store", store.id, "reconcile_failed", { error: msg });
    return { store: store.name, error: msg };
  }
}

function db() {
  return adminClient();
}
