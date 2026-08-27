/**
 * Shopify Admin GraphQL-klient. Alle operasjoner er validert mot Admin API 2025-07-skjemaet.
 *
 * Env: SHOPIFY_SHOP (kycbgs-yy.myshopify.com), SHOPIFY_ADMIN_TOKEN (custom app), SHOPIFY_API_VERSION
 */
const API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") ?? "2025-07";

export class ShopifyError extends Error {
  constructor(message: string, public readonly details?: unknown) {
    super(message);
    this.name = "ShopifyError";
  }
}

export async function gql<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const shop = Deno.env.get("SHOPIFY_SHOP");
  const token = Deno.env.get("SHOPIFY_ADMIN_TOKEN");
  if (!shop || !token) throw new ShopifyError("SHOPIFY_SHOP / SHOPIFY_ADMIN_TOKEN mangler");

  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    const body = await res.json();
    if (body.errors?.length) {
      const throttled = body.errors.some((e: any) => e.extensions?.code === "THROTTLED");
      if (throttled && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      throw new ShopifyError("GraphQL-feil: " + body.errors.map((e: any) => e.message).join("; "), body.errors);
    }
    return body.data as T;
  }
  throw new ShopifyError("Shopify: for mange forsøk (throttled)");
}

function assertNoUserErrors(res: any, op: string) {
  const errs = res?.[op]?.userErrors;
  if (errs?.length) throw new ShopifyError(`${op}: ` + errs.map((e: any) => `${(e.field ?? []).join(".")} ${e.message}`).join("; "), errs);
}

// ---------------------------------------------------------------------------
// Lager
// ---------------------------------------------------------------------------

export interface QtyChange {
  inventoryItemId: string;
  locationId: string;
  quantity: number;
}

/** Setter "available" absolutt på en location. Maks 250 per kall, batches automatisk. */
export async function setAvailableQuantities(changes: QtyChange[], reason = "correction") {
  const Q = `mutation SetQty($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) { inventoryAdjustmentGroup { createdAt } userErrors { field message code } } }`;
  for (let i = 0; i < changes.length; i += 250) {
    const batch = changes.slice(i, i + 250);
    const res = await gql(Q, {
      input: {
        name: "available",
        reason,
        ignoreCompareQuantity: true,
        quantities: batch.map((c) => ({ inventoryItemId: c.inventoryItemId, locationId: c.locationId, quantity: c.quantity })),
      },
    });
    assertNoUserErrors(res, "inventorySetQuantities");
  }
}

/** Sørger for at inventory items er aktivert på en location (kreves før setAvailableQuantities). */
export async function activateInventoryAtLocation(inventoryItemIds: string[], locationId: string) {
  const M = `mutation Act($inventoryItemId: ID!, $locationId: ID!) {
    inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId, available: 0) { inventoryLevel { id } userErrors { field message } } }`;
  for (const id of inventoryItemIds) {
    const res = await gql(M, { inventoryItemId: id, locationId });
    const errs = res.inventoryActivate?.userErrors ?? [];
    // "already active"-varianter ignoreres
    const real = errs.filter((e: any) => !/already/i.test(e.message));
    if (real.length) throw new ShopifyError("inventoryActivate: " + real.map((e: any) => e.message).join("; "));
  }
}

/** Alle varianter i butikken med strekkode/inventory item. Brukes til å speile products-tabellen. */
export async function* iterateVariants() {
  const Q = `query($after: String) { productVariants(first: 250, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { id sku barcode title inventoryItem { id tracked } product { id title vendor status } } } }`;
  let after: string | null = null;
  while (true) {
    const res: any = await gql(Q, { after });
    for (const n of res.productVariants.nodes) yield n;
    if (!res.productVariants.pageInfo.hasNextPage) break;
    after = res.productVariants.pageInfo.endCursor;
  }
}

/** Skriver metafelt garnly.stock_by_store på varianter (brukes av Validation Function, §7). */
export async function setStockByStoreMetafields(entries: Array<{ variantId: string; stockByLocation: Record<string, number> }>) {
  const M = `mutation SetMeta($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) { metafields { id } userErrors { field message } } }`;
  for (let i = 0; i < entries.length; i += 25) {
    const batch = entries.slice(i, i + 25);
    const res = await gql(M, {
      metafields: batch.map((e) => ({
        ownerId: e.variantId,
        namespace: "garnly",
        key: "stock_by_store",
        type: "json",
        value: JSON.stringify(e.stockByLocation),
      })),
    });
    assertNoUserErrors(res, "metafieldsSet");
  }
}

// ---------------------------------------------------------------------------
// Ordre og fulfillment orders
// ---------------------------------------------------------------------------

export interface ShopifyOrder {
  id: string;
  name: string;
  email: string | null;
  shippingAddress: {
    name: string; address1: string; address2: string | null; zip: string; city: string;
    country: string; countryCodeV2: string; phone: string | null;
  } | null;
  fulfillmentOrders: {
    nodes: Array<{
      id: string;
      status: string;
      assignedLocation: { location: { id: string } | null };
      lineItems: {
        nodes: Array<{
          id: string; remainingQuantity: number; totalQuantity: number;
          lineItem: { id: string; title: string; quantity: number; variant: { id: string; barcode: string | null; sku: string | null; inventoryItem: { id: string } } | null };
        }>;
      };
    }>;
  };
}

export async function getOrder(orderId: string): Promise<ShopifyOrder> {
  const Q = `query Order($id: ID!) { order(id: $id) { id name email
    shippingAddress { name address1 address2 zip city country countryCodeV2 phone }
    fulfillmentOrders(first: 10) { nodes { id status assignedLocation { location { id } }
      lineItems(first: 50) { nodes { id remainingQuantity totalQuantity
        lineItem { id title quantity variant { id barcode sku inventoryItem { id } } } } } } } } }`;
  const res = await gql(Q, { id: orderId });
  if (!res.order) throw new ShopifyError(`Ordre ${orderId} finnes ikke`);
  return res.order;
}

export async function holdFulfillmentOrder(foId: string, reasonNotes: string) {
  const M = `mutation Hold($id: ID!, $fulfillmentHold: FulfillmentOrderHoldInput!) {
    fulfillmentOrderHold(id: $id, fulfillmentHold: $fulfillmentHold) { fulfillmentOrder { id status } userErrors { field message } } }`;
  const res = await gql(M, { id: foId, fulfillmentHold: { reason: "OTHER", reasonNotes, notifyMerchant: false, handle: "garnly-routing" } });
  const errs = res.fulfillmentOrderHold?.userErrors ?? [];
  if (errs.length && !errs.some((e: any) => /already.*hold/i.test(e.message))) assertNoUserErrors(res, "fulfillmentOrderHold");
}

export async function releaseHold(foId: string) {
  const M = `mutation Release($id: ID!) { fulfillmentOrderReleaseHold(id: $id) { fulfillmentOrder { id status } userErrors { field message } } }`;
  const res = await gql(M, { id: foId });
  const errs = res.fulfillmentOrderReleaseHold?.userErrors ?? [];
  if (errs.length && !errs.some((e: any) => /not.*on hold/i.test(e.message))) assertNoUserErrors(res, "fulfillmentOrderReleaseHold");
}

/** Flytter hele (eller deler av) en fulfillment order til en location. Returnerer ny FO-id. */
export async function moveFulfillmentOrder(foId: string, locationId: string, lineItems?: Array<{ id: string; quantity: number }>): Promise<string> {
  const M = `mutation Move($id: ID!, $newLocationId: ID!, $fulfillmentOrderLineItems: [FulfillmentOrderLineItemInput!]) {
    fulfillmentOrderMove(id: $id, newLocationId: $newLocationId, fulfillmentOrderLineItems: $fulfillmentOrderLineItems) {
      movedFulfillmentOrder { id } originalFulfillmentOrder { id } remainingFulfillmentOrder { id } userErrors { field message } } }`;
  const res = await gql(M, { id: foId, newLocationId: locationId, fulfillmentOrderLineItems: lineItems ?? null });
  assertNoUserErrors(res, "fulfillmentOrderMove");
  return res.fulfillmentOrderMove.movedFulfillmentOrder.id;
}

/** Splitter ut gitte linjer i egen fulfillment order. Returnerer { newId, remainingId }. */
export async function splitFulfillmentOrder(foId: string, lineItems: Array<{ id: string; quantity: number }>) {
  const M = `mutation Split($fulfillmentOrderSplits: [FulfillmentOrderSplitInput!]!) {
    fulfillmentOrderSplit(fulfillmentOrderSplits: $fulfillmentOrderSplits) {
      fulfillmentOrderSplits { fulfillmentOrder { id } remainingFulfillmentOrder { id } } userErrors { field message } } }`;
  const res = await gql(M, { fulfillmentOrderSplits: [{ fulfillmentOrderId: foId, fulfillmentOrderLineItems: lineItems }] });
  assertNoUserErrors(res, "fulfillmentOrderSplit");
  const s = res.fulfillmentOrderSplit.fulfillmentOrderSplits[0];
  return { newId: s.fulfillmentOrder.id as string, remainingId: s.remainingFulfillmentOrder?.id as string | undefined };
}

export async function createFulfillment(foId: string, tracking?: { number: string; url?: string; company?: string }) {
  const M = `mutation Fulfill($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) { fulfillment { id status } userErrors { field message } } }`;
  const res = await gql(M, {
    fulfillment: {
      lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: foId }],
      notifyCustomer: true,
      trackingInfo: tracking ? { number: tracking.number, url: tracking.url, company: tracking.company } : undefined,
    },
  });
  assertNoUserErrors(res, "fulfillmentCreate");
  return res.fulfillmentCreate.fulfillment.id as string;
}

// ---------------------------------------------------------------------------
// Webhook-verifisering
// ---------------------------------------------------------------------------
export async function verifyShopifyHmac(rawBody: string, hmacHeader: string | null): Promise<boolean> {
  const secret = Deno.env.get("SHOPIFY_WEBHOOK_SECRET");
  if (!secret || !hmacHeader) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  if (b64.length !== hmacHeader.length) return false;
  let diff = 0;
  for (let i = 0; i < b64.length; i++) diff |= b64.charCodeAt(i) ^ hmacHeader.charCodeAt(i);
  return diff === 0;
}
