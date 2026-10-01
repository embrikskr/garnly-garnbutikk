/**
 * Refusjoner fra Shopify → trekk i butikkens oppgjør.
 *
 * Webhooken (refunds/create) og den nattlige backstoppen går begge gjennom behandleRefusjon,
 * så det er én kodevei. Vi leser ikke beløpene ut av webhook-payloaden, men spør Shopify om
 * refusjonen – samme prinsipp som fulfillment_sync: payloaden er et varsel, Shopify er fasit.
 *
 * Trygt å kjøre om igjen: (shopify_refund_id, group_id) er unik i settlement_adjustments, og
 * en rad som alt finnes hoppes over. Provisjon, avrunding og hvilken måned trekket havner i
 * regnes av databasen (031); her avgjøres bare hvor mye varer som ble refundert per gruppe.
 */
import { adminClient, audit } from "./db.ts";
import { gql } from "./shopify.ts";
import { notifyOps } from "./notify.ts";
import { fordelRefusjon, type OppgjorsGruppe, tilOre } from "./settlement.ts";

type Penger = { shopMoney: { amount: string } };

interface ShopifyRefusjon {
  id: string;
  processedAt: string;
  totalRefundedSet: Penger;
  order: { id: string; name: string; taxesIncluded: boolean };
  refundLineItems: {
    nodes: Array<{ quantity: number; subtotalSet: Penger; totalTaxSet: Penger; lineItem: { id: string; variant: { id: string } | null } }>;
  };
  refundShippingLines: { nodes: Array<{ subtotalAmountSet: Penger; taxAmountSet: Penger }> };
}

// Validert mot Admin API-skjemaet 01.10.2026 (Shopify MCP validate_graphql_codeblocks).
const REFUSJON = `query Refusjon($id: ID!) {
  node(id: $id) {
    ... on Refund {
      id
      processedAt
      totalRefundedSet { shopMoney { amount } }
      order { id name taxesIncluded }
      refundLineItems(first: 100) {
        nodes {
          quantity
          subtotalSet { shopMoney { amount } }
          totalTaxSet { shopMoney { amount } }
          lineItem { id variant { id } }
        }
      }
      refundShippingLines(first: 10) {
        nodes {
          subtotalAmountSet { shopMoney { amount } }
          taxAmountSet { shopMoney { amount } }
        }
      }
    }
  }
}`;

export interface RefusjonUtfall {
  refusjon: string;
  ordre?: string;
  hoppetOver?: string;
  nye: number;
  fantesFra: number;
}

const kr = (ore: number) => (ore / 100).toFixed(2);

export async function behandleRefusjon(refundGid: string): Promise<RefusjonUtfall> {
  const db = adminClient();
  const data = await gql<{ node: ShopifyRefusjon | null }>(REFUSJON, { id: refundGid });
  const r = data.node;
  if (!r?.order) return { refusjon: refundGid, hoppetOver: "fant ikke refusjonen i Shopify", nye: 0, fantesFra: 0 };

  const { data: ro } = await db.from("routing_orders").select("id, is_test")
    .eq("shopify_order_id", r.order.id).maybeSingle();
  if (!ro) return { refusjon: r.id, ordre: r.order.name, hoppetOver: "ordren er ikke rutet av Garnly", nye: 0, fantesFra: 0 };
  // Testordrer telles aldri i oppgjøret – heller ikke refusjonene deres.
  if (ro.is_test) return { refusjon: r.id, ordre: r.order.name, hoppetOver: "testordre", nye: 0, fantesFra: 0 };

  const { data: grupper } = await db.from("routing_groups")
    .select("id, status, assigned_store_id, line_items")
    .eq("routing_order_id", ro.id);

  const fordeling = fordelRefusjon(
    {
      taxesIncluded: r.order.taxesIncluded,
      totalOre: tilOre(r.totalRefundedSet.shopMoney.amount),
      linjer: r.refundLineItems.nodes.map((l) => ({
        variantId: l.lineItem.variant?.id ?? null,
        antall: l.quantity,
        subtotalOre: tilOre(l.subtotalSet.shopMoney.amount),
        mvaOre: tilOre(l.totalTaxSet.shopMoney.amount),
      })),
      frakt: r.refundShippingLines.nodes.map((f) => ({
        subtotalOre: tilOre(f.subtotalAmountSet.shopMoney.amount),
        mvaOre: tilOre(f.taxAmountSet.shopMoney.amount),
      })),
    },
    (grupper ?? []).map((g: any): OppgjorsGruppe => ({
      id: g.id,
      status: g.status,
      storeId: g.assigned_store_id,
      varianter: (g.line_items ?? []).map((li: any) => li.variant_id).filter(Boolean),
    })),
  );

  let nye = 0;
  let fantesFra = 0;
  for (const t of fordeling.trekk) {
    const { data: rad, error } = await db.from("settlement_adjustments")
      .upsert({
        store_id: t.storeId,
        group_id: t.groupId,
        kind: "refund",
        shopify_refund_id: r.id,
        gross_inc_vat: -t.varebelopOre / 100,
        reason: `Refusjon ${r.order.name}`,
        occurred_at: r.processedAt,
      }, { onConflict: "shopify_refund_id,group_id", ignoreDuplicates: true })
      .select("amount_inc_vat, settlement_month")
      .maybeSingle();
    if (error) throw new Error(`settlement_adjustments: ${error.message}`);
    if (!rad) { fantesFra++; continue; }
    nye++;
    await audit("routing_group", t.groupId, "refund_recorded", {
      order: r.order.name,
      refund: r.id,
      refundert_varer: kr(t.varebelopOre),
      trekk: rad.amount_inc_vat,
      maaned: rad.settlement_month,
      frakt_ikke_trukket: kr(fordeling.fraktOre),
    });
  }

  // Det vi ikke kunne knytte til en butikk, sier vi fra om – én gang, når refusjonen er ny for
  // oss. Backstoppen går gjennom de samme refusjonene hver natt i tre døgn.
  if (fordeling.ikkeTrukket.length && fantesFra === 0) {
    const { count } = await db.from("audit_log").select("id", { count: "exact", head: true })
      .eq("event", "refund_not_deducted").eq("payload->>refund", r.id);
    if (!count) {
      const linjer = fordeling.ikkeTrukket.map((x) => `  ${kr(x.belopOre)} kr – ${x.grunn}`).join("\n");
      await audit("routing_order", ro.id, "refund_not_deducted", { order: r.order.name, refund: r.id, ikke_trukket: fordeling.ikkeTrukket });
      await notifyOps(
        `Refusjon på ${r.order.name} ikke trukket fra butikk`,
        `Refusjon ${r.id} på ${r.order.name} har beløp som ikke ble trukket fra noen butikk:\n${linjer}\n\n` +
          `Skal en butikk trekkes, legg det inn i settlement_adjustments for hånd.`,
      );
    }
  }

  return { refusjon: r.id, ordre: r.order.name, nye, fantesFra };
}

/**
 * Backstop: refusjoner der webhooken aldri kom fram. Ser på ordrer endret de siste dagene med
 * status refundert eller delvis refundert, og kjører hver refusjon gjennom samme vei.
 */
export async function refusjonsBackstop(dager = 3): Promise<{ ordrer: number; utfall: RefusjonUtfall[] }> {
  const fra = new Date(Date.now() - dager * 86400_000).toISOString();
  const q = `updated_at:>='${fra}' AND (financial_status:refunded OR financial_status:partially_refunded)`;
  const utfall: RefusjonUtfall[] = [];
  let ordrer = 0;
  let after: string | null = null;
  do {
    const side: any = await gql(
      `query RefunderteOrdrer($q: String!, $after: String) {
        orders(first: 50, after: $after, query: $q, sortKey: UPDATED_AT) {
          pageInfo { hasNextPage endCursor }
          nodes { id refunds(first: 50) { id } }
        }
      }`,
      { q, after },
    );
    for (const o of side.orders.nodes) {
      ordrer++;
      for (const ref of o.refunds) {
        try {
          utfall.push(await behandleRefusjon(ref.id));
        } catch (e) {
          utfall.push({ refusjon: ref.id, hoppetOver: `feil: ${(e as Error).message}`, nye: 0, fantesFra: 0 });
        }
      }
    }
    after = side.orders.pageInfo.hasNextPage ? side.orders.pageInfo.endCursor : null;
  } while (after);
  return { ordrer, utfall };
}

/**
 * Sørger for at Shopify sender refunds/create hit. Må registreres av appen selv (med appens
 * token), ellers signeres webhooken med en annen hemmelighet enn den verifyShopifyHmac sjekker.
 */
export async function sikreWebhook(): Promise<{ fantes: boolean; id: string; uri: string }> {
  const uri = `${Deno.env.get("SUPABASE_URL")!.replace(/\/$/, "")}/functions/v1/order-refunded`;
  const liste: any = await gql(`query Webhooks {
    webhookSubscriptions(first: 50, topics: [REFUNDS_CREATE]) { nodes { id topic uri } }
  }`);
  const finnes = liste.webhookSubscriptions.nodes.find((n: any) => n.uri === uri);
  if (finnes) return { fantes: true, id: finnes.id, uri };
  const ny: any = await gql(
    `mutation OpprettWebhook($sub: WebhookSubscriptionInput!) {
      webhookSubscriptionCreate(topic: REFUNDS_CREATE, webhookSubscription: $sub) {
        webhookSubscription { id topic uri }
        userErrors { field message }
      }
    }`,
    { sub: { uri, format: "JSON" } },
  );
  const feil = ny.webhookSubscriptionCreate.userErrors;
  if (feil?.length) throw new Error(`webhookSubscriptionCreate: ${JSON.stringify(feil)}`);
  return { fantes: false, id: ny.webhookSubscriptionCreate.webhookSubscription.id, uri };
}
