/**
 * partner-preview: prøvekjøring av lagerlesingen for en partnerbutikk med egen Shopify.
 *
 *   POST { "store_id": "<uuid>" } + x-cron-secret
 *
 * Leser butikkens lager gjennom Garnly-appen og kobler det mot Garnlys varer med samme matching
 * som sync-store, men skriver ingenting – verken inventory, unmatched_items eller Shopify. Svaret
 * er et sammendrag: hvor mange varer, hvor mange med lager og strekkode, hvor mange som traff
 * Garnlys sortiment og hvordan, «continue selling»-fordelingen, og eksempler på det som ikke traff.
 *
 * Laget for KreStoffer 18.11.2026, før sync-store deployes med shopify-adapteren: en feil i
 * sync-store stopper synken for alle butikkene, denne rører ingen andre.
 */
import { adminClient, json, requireInternalSecret } from "../_shared/db.ts";
import { hentNivaer, lagerRegel, tilLagerlinjer } from "../_shared/adapters/shopify.ts";
import { matchLines } from "../_shared/matching.ts";
import type { ProductRow, StoreRow } from "../_shared/types.ts";

Deno.serve(async (req) => {
  const nei = requireInternalSecret(req);
  if (nei) return nei;
  const { store_id } = await req.json().catch(() => ({}));
  const db = adminClient();
  const { data: store } = await db.from("stores").select("*").eq("id", store_id).maybeSingle();
  if (!store || store.pos_system !== "shopify") return json({ error: "fant ingen shopify-butikk med den id-en" }, 400);

  try {
    const { lokasjon, noder } = await hentNivaer(store as StoreRow);
    const linjer = tilLagerlinjer(noder, lagerRegel(store.pos_config));

    const products: ProductRow[] = [];
    for (let from = 0;; from += 1000) {
      const { data, error } = await db.from("products").select("*").eq("active", true).eq("exclude_from_sync", false).range(from, from + 999);
      if (error) throw new Error("products: " + error.message);
      products.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
    const { data: aliasRows } = await db.from("product_aliases").select("external_id, product_id").eq("store_id", store.id);
    const aliases = new Map<string, string>((aliasRows ?? []).map((a: { external_id: string; product_id: string }) => [a.external_id, a.product_id]));
    const { matched, unmatched } = matchLines(linjer, products, aliases);

    const ledig = (n: (typeof noder)[number]) => n.quantities.find((q) => q.name === "available")?.quantity ?? 0;
    const sporet = noder.filter((n) => n.item?.tracked);
    const policy = (p: string) => sporet.filter((n) => n.item?.variants.nodes[0]?.inventoryPolicy === p);
    const via: Record<string, number> = {};
    for (const m of matched) via[m.via] = (via[m.via] ?? 0) + 1;
    const merker: Record<string, number> = {};
    for (const l of linjer) if (l.brand) merker[l.brand] = (merker[l.brand] ?? 0) + 1;
    const garnlyMedLager = new Set(matched.filter((m) => m.line.qty > 0).map((m) => m.product.id));
    const fordeling = (liste: typeof noder) => ({
      over_0: liste.filter((n) => ledig(n) > 0).length,
      lik_0: liste.filter((n) => ledig(n) === 0).length,
      under_0: liste.filter((n) => ledig(n) < 0).length,
    });

    return json({
      butikk: store.name,
      lokasjon: lokasjon.name,
      lagernivaer: noder.length,
      uten_lagersporing: noder.length - sporet.length,
      linjer: linjer.length,
      med_strekkode: linjer.filter((l) => l.ean).length,
      ledig_antall: fordeling(sporet),
      continue_selling: { CONTINUE: { antall: policy("CONTINUE").length, ...fordeling(policy("CONTINUE")) }, DENY: { antall: policy("DENY").length, ...fordeling(policy("DENY")) } },
      garnly_varer_aktive: products.length,
      traff_garnly: matched.length,
      traff_via: via,
      traff_med_lager: matched.filter((m) => m.line.qty > 0).length,
      garnly_varer_med_lager_hos_butikken: garnlyMedLager.size,
      ikke_truffet: unmatched.length,
      ikke_truffet_med_lager_og_strekkode: unmatched.filter((l) => l.qty > 0 && l.ean).length,
      merker_topp: Object.entries(merker).sort((a, b) => b[1] - a[1]).slice(0, 25),
      eksempler_truffet: matched.filter((m) => m.line.qty > 0).slice(0, 15).map((m) => ({ deres: m.line.name, garnly: m.product.name, via: m.via, ledig: m.line.qty })),
      eksempler_ikke_truffet: unmatched.filter((l) => l.qty > 0).slice(0, 20).map((l) => ({ navn: l.name, merke: l.brand, ean: l.ean, ledig: l.qty })),
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
