/**
 * settlement-fees: henter det faktiske betalingsgebyret per ordre fra Shopify.
 *
 * Avtalen med butikkene trekker betalingsgebyret fra grunnlaget før det deles (migrasjon 040).
 * Gebyret står på ordrens transaksjoner i Shopify og lagres i routing_orders.payment_fee.
 * En periode kan ikke avregnes før alle ordrene i den har gebyret.
 *
 * To veier inn:
 *   - pg_cron hver halvtime (040), med x-cron-secret
 *   - admin.garnly.no («Hent gebyrer nå»), med service role-nøkkelen og x-garnly-actor
 *     (_shared/admin_bridge.ts)
 *
 *   {}                      ordrer som er gitt til en butikk og mangler gebyr
 *   { "dry_run": true }     les og regn, men skriv ingenting
 *   { "order": "#1040" }    én ordre, også om gebyret finnes fra før (overskriver)
 *
 * Testordrer hentes ikke: de telles aldri i oppgjøret. Regelen for hva som er gebyret, står i
 * _shared/payment_fee.ts.
 */
import { adminClient, json, requireInternalSecret } from "../_shared/db.ts";
import { gql } from "../_shared/shopify.ts";
import { bridgeActor } from "../_shared/admin_bridge.ts";
import { type FeeTransaction, gebyrFraTransaksjoner } from "../_shared/payment_fee.ts";

// Samme form som i Admin API 2025-07; kjørt mot butikken 18.11.2026 for #1019–#1055.
const GEBYRER = `query Gebyrer($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Order {
      id
      name
      currencyCode
      transactions(first: 25) {
        kind
        status
        gateway
        fees { amount { amount currencyCode } }
      }
    }
  }
}`;

interface ShopifyOrdre {
  id: string;
  name: string;
  currencyCode: string;
  transactions: FeeTransaction[];
}

const MAKS = 100;

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, melding: "method not allowed" }, 405);

  let av = "cron";
  if (req.headers.get("x-cron-secret") !== null) {
    const nei = requireInternalSecret(req);
    if (nei) return nei;
  } else {
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const bridge = bridgeActor(token, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), req.headers.get("x-garnly-actor"));
    if (bridge.kind === "missing_actor") return json({ ok: false, melding: "x-garnly-actor mangler" }, 400);
    if (bridge.kind !== "ok") return json({ ok: false, melding: "unauthorized" }, 401);
    av = bridge.actor;
  }

  const body = await req.json().catch(() => ({}));
  const dryRun = body.dry_run === true;
  const enOrdre = typeof body.order === "string" && body.order.trim() ? body.order.trim() : null;

  try {
    const db = adminClient();
    let q = db.from("routing_orders")
      .select("id, shopify_order_id, shopify_order_name, routing_groups!inner(status)")
      .eq("is_test", false)
      .in("routing_groups.status", ["assigned", "fulfilled"])
      .order("created_at", { ascending: true })
      .limit(MAKS);
    q = enOrdre ? q.eq("shopify_order_name", enOrdre) : q.is("payment_fee", null);
    const { data: rader, error } = await q;
    if (error) throw new Error(`routing_orders: ${error.message}`);

    const ordrer = (rader ?? []) as Array<{ id: string; shopify_order_id: string; shopify_order_name: string | null }>;
    if (ordrer.length === 0) return json({ ok: true, hentet: 0, venter: [], manuelt: [], melding: "Ingen ordrer mangler gebyr." });

    const hentet: Array<{ ordre: string | null; gebyr: number }> = [];
    const venter: Array<{ ordre: string | null; grunn: string }> = [];
    const manuelt: Array<{ ordre: string | null; grunn: string }> = [];

    for (let i = 0; i < ordrer.length; i += 50) {
      const bunke = ordrer.slice(i, i + 50);
      const data = await gql<{ nodes: Array<ShopifyOrdre | null> }>(GEBYRER, { ids: bunke.map((o) => o.shopify_order_id) });
      const perId = new Map((data.nodes ?? []).filter((n): n is ShopifyOrdre => !!n?.id).map((n) => [n.id, n]));

      for (const o of bunke) {
        const s = perId.get(o.shopify_order_id);
        if (!s) {
          manuelt.push({ ordre: o.shopify_order_name, grunn: "ordren finnes ikke i Shopify" });
          continue;
        }
        const utfall = gebyrFraTransaksjoner(s.transactions ?? [], s.currencyCode);
        if (utfall.kind === "vent") {
          venter.push({ ordre: o.shopify_order_name, grunn: utfall.grunn });
          continue;
        }
        if (utfall.kind === "manuelt") {
          manuelt.push({ ordre: o.shopify_order_name, grunn: utfall.grunn });
          continue;
        }
        const gebyr = utfall.ore / 100;
        hentet.push({ ordre: o.shopify_order_name, gebyr });
        if (dryRun) continue;
        // Uten «order» skrives bare der gebyret mangler, så to samtidige kjøringer ikke
        // overskriver hverandre – og et gebyr lagt inn for hånd blir stående.
        let upd = db.from("routing_orders")
          .update({ payment_fee: gebyr, payment_fee_synced_at: new Date().toISOString(), payment_fee_source: "shopify" })
          .eq("id", o.id);
        if (!enOrdre) upd = upd.is("payment_fee", null);
        const { error: e2 } = await upd;
        if (e2) throw new Error(`routing_orders ${o.shopify_order_name}: ${e2.message}`);
      }
    }

    console.log("[settlement-fees]", JSON.stringify({ av, dryRun, hentet: hentet.length, venter: venter.length, manuelt: manuelt.length }));
    return json({
      ok: true,
      dry_run: dryRun,
      hentet: hentet.length,
      gebyrer: hentet,
      venter,
      manuelt,
      melding: `Hentet gebyret for ${hentet.length} ${hentet.length === 1 ? "ordre" : "ordrer"}.` +
        (venter.length ? ` ${venter.length} venter på Shopify.` : "") +
        (manuelt.length ? ` ${manuelt.length} må legges inn for hånd.` : ""),
    });
  } catch (e) {
    console.error("[settlement-fees]", e);
    return json({ ok: false, melding: (e as Error).message }, 500);
  }
});
