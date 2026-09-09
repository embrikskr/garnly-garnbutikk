/**
 * Shopify Admin GraphQL-klient. Alle operasjoner er validert mot Admin API 2025-07-skjemaet.
 *
 * Env: SHOPIFY_SHOP (kycbgs-yy.myshopify.com), SHOPIFY_API_VERSION, og én av:
 *   - SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (Dev Dashboard-app i egen organisasjon;
 *     token hentes med client credentials-grant og fornyes automatisk – utløper etter 24 t)
 *   - SHOPIFY_ADMIN_TOKEN (fast token fra en eldre admin-opprettet custom app)
 */
const API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") ?? "2025-07";

export class ShopifyError extends Error {
  constructor(message: string, public readonly details?: unknown) {
    super(message);
    this.name = "ShopifyError";
  }
}

let cachedToken: { token: string; at: number } | null = null;

/** Admin-token: fast token hvis satt, ellers client credentials-grant med cache (fornyes før 24 t). */
export async function adminToken(shop: string): Promise<string> {
  const fixed = Deno.env.get("SHOPIFY_ADMIN_TOKEN");
  if (fixed) return fixed;
  const id = Deno.env.get("SHOPIFY_CLIENT_ID");
  const secret = Deno.env.get("SHOPIFY_CLIENT_SECRET");
  if (!id || !secret) throw new ShopifyError("SHOPIFY_ADMIN_TOKEN eller SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET mangler");
  if (cachedToken && Date.now() - cachedToken.at < 23 * 3600 * 1000) return cachedToken.token;
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: id, client_secret: secret, grant_type: "client_credentials" }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new ShopifyError(`Shopify client credentials feilet: ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  }
  cachedToken = { token: json.access_token as string, at: Date.now() };
  return cachedToken.token;
}

export async function gql<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const shop = Deno.env.get("SHOPIFY_SHOP");
  if (!shop) throw new ShopifyError("SHOPIFY_SHOP mangler");

  for (let attempt = 0; attempt < 4; attempt++) {
    const token = await adminToken(shop);
    const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 401) {
      // Token kan være utløpt/tilbakekalt: tøm cache og prøv igjen med ferskt token
      cachedToken = null;
      if (attempt < 3) continue;
      throw new ShopifyError("Shopify: 401 unauthorized etter fornyet token");
    }
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

/**
 * Setter fysisk lager ("on_hand") absolutt på en location. Maks 250 per kall, batches automatisk.
 *
 * VIKTIG: vi skriver on_hand, ikke available. Kassesystemet teller det som fysisk står i
 * butikken, og det er nøyaktig Shopifys on_hand. available er on_hand minus det som er lovet
 * bort til ubetjente ordrer (committed), og den regner Shopify ut selv.
 *
 * Skrev vi available, ville hver synk mens en ordre lå ubehandlet blåst opp lageret: med 13 i
 * kassa og 1 solgt på nett står Shopify på available=12, committed=1, on_hand=13. Faller kassa
 * til 11 og vi skriver available=11, blir on_hand 12 – Shopify tror det står 12 i butikken når
 * det står 11, og selger én for mye. Skriver vi on_hand=11, blir available 10, som er riktig.
 * Verifisert mot ekte data 09.09.2026.
 * Admin API 2026-07: inventorySetQuantities krever @idempotent-direktiv (nøkkel per batch,
 * stabil over gql()-retries) og changeFromQuantity på hver rad. Vi er kilden til sannhet, så
 * changeFromQuantity = null slår av compare-and-swap-sjekken.
 */
export async function setOnHandQuantities(changes: QtyChange[], reason = "correction") {
  const Q = `mutation SetQty($input: InventorySetQuantitiesInput!, $key: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $key) { inventoryAdjustmentGroup { createdAt } userErrors { field message code } } }`;
  for (let i = 0; i < changes.length; i += 250) {
    const batch = changes.slice(i, i + 250);
    const res = await gql(Q, {
      key: crypto.randomUUID(),
      input: {
        name: "on_hand",
        reason,
        referenceDocumentUri: "gid://garnly-sync/StoreSync/inventory",
        quantities: batch.map((c) => ({ inventoryItemId: c.inventoryItemId, locationId: c.locationId, quantity: c.quantity, changeFromQuantity: null })),
      },
    });
    assertNoUserErrors(res, "inventorySetQuantities");
  }
}

/**
 * Slår på lagersporing (inventoryItem.tracked) for varianter som mangler det.
 * Uten sporing selger Shopify ubegrenset uansett hva vi skriver til locations.
 * variantsByProduct: productId -> variant-id-er som er untracked.
 */
export async function ensureVariantsTracked(variantsByProduct: Map<string, string[]>) {
  const M = `mutation Track($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { field message } } }`;
  let n = 0;
  for (const [productId, variantIds] of variantsByProduct) {
    for (let i = 0; i < variantIds.length; i += 100) {
      const res = await gql(M, {
        productId,
        variants: variantIds.slice(i, i + 100).map((id) => ({ id, inventoryItem: { tracked: true } })),
      });
      assertNoUserErrors(res, "productVariantsBulkUpdate(tracked)");
      n += Math.min(100, variantIds.length - i);
    }
  }
  return n;
}

/** Slår på lagersporing (inventoryItem.tracked) – kreves før lager kan settes. Idempotent. */
export async function enableTracking(inventoryItemIds: string[]) {
  const M = `mutation Track($id: ID!) {
    inventoryItemUpdate(id: $id, input: { tracked: true }) { inventoryItem { id tracked } userErrors { field message } } }`;
  for (const id of inventoryItemIds) {
    const res = await gql(M, { id });
    assertNoUserErrors(res, "inventoryItemUpdate");
  }
}

/**
 * Sørger for at inventory items er aktivert på en location (kreves før setAvailableQuantities).
 * 2026-07: inventoryActivate krever @idempotent-direktiv.
 */
export async function activateInventoryAtLocation(inventoryItemIds: string[], locationId: string) {
  const M = `mutation Act($inventoryItemId: ID!, $locationId: ID!, $key: String!) {
    inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId, available: 0) @idempotent(key: $key) { inventoryLevel { id } userErrors { field message } } }`;
  for (const id of inventoryItemIds) {
    const res = await gql(M, { inventoryItemId: id, locationId, key: crypto.randomUUID() });
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
/**
 * Flytter en fulfillment order til butikkens location.
 *
 * Shopify har som regel allerede tildelt en location ved ordreopprettelse, og velger
 * gjerne nettopp den butikken som har varen. Er det butikken som godtar, avviser
 * Shopify flyttingen med «Cannot move to the current origin location», og aksepten
 * krasjet. Vi sjekker derfor hvor den ligger først, og tåler feilen om den likevel
 * oppstår (to butikker kan svare tett i tid).
 */
export async function moveFulfillmentOrder(foId: string, locationId: string, lineItems?: Array<{ id: string; quantity: number }>): Promise<string> {
  const Q = `query Where($id: ID!) { fulfillmentOrder(id: $id) { id assignedLocation { location { id } } } }`;
  const cur = await gql(Q, { id: foId });
  if (cur?.fulfillmentOrder?.assignedLocation?.location?.id === locationId) return foId;

  const M = `mutation Move($id: ID!, $newLocationId: ID!, $fulfillmentOrderLineItems: [FulfillmentOrderLineItemInput!]) {
    fulfillmentOrderMove(id: $id, newLocationId: $newLocationId, fulfillmentOrderLineItems: $fulfillmentOrderLineItems) {
      movedFulfillmentOrder { id } originalFulfillmentOrder { id } remainingFulfillmentOrder { id } userErrors { field message } } }`;
  const res = await gql(M, { id: foId, newLocationId: locationId, fulfillmentOrderLineItems: lineItems ?? null });
  const errs: Array<{ message?: string }> = res.fulfillmentOrderMove?.userErrors ?? [];
  if (errs.some((e) => /current origin location/i.test(e.message ?? ""))) return foId;
  assertNoUserErrors(res, "fulfillmentOrderMove");
  return res.fulfillmentOrderMove.movedFulfillmentOrder?.id ?? foId;
}

/** Splitter ut gitte linjer i egen fulfillment order. Returnerer { newId, remainingId }. */
/**
 * Splitter en fulfillment order som ligger på hold, og lar begge delene ligge på hold.
 *
 * Shopify nekter å splitte en fulfillment order som er på hold: «is currently not in a
 * splittable state». Vi holder alle ordrer under ruting, så holdet må slippes først og
 * settes tilbake på begge delene etterpå. Vinduet der ordren er uten hold er brøkdeler
 * av et sekund, og den er uansett ikke tildelt noen butikk ennå.
 */
export async function splitHeldFulfillmentOrder(foId: string, lineItems: Array<{ id: string; quantity: number }>) {
  await releaseHold(foId);
  try {
    const res = await splitFulfillmentOrder(foId, lineItems);
    await holdFulfillmentOrder(res.newId, "Garnly ordreruting pågår");
    if (res.remainingId) await holdFulfillmentOrder(res.remainingId, "Garnly ordreruting pågår");
    return res;
  } catch (e) {
    // Fikk vi ikke splittet, må holdet tilbake, ellers står ordren åpen for pakking.
    await holdFulfillmentOrder(foId, "Garnly ordreruting pågår").catch(() => {});
    throw e;
  }
}

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
  // Webhooks opprettet av appen via API signeres med appens client secret
  const secret = Deno.env.get("SHOPIFY_WEBHOOK_SECRET") || Deno.env.get("SHOPIFY_CLIENT_SECRET");
  if (!secret || !hmacHeader) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  if (b64.length !== hmacHeader.length) return false;
  let diff = 0;
  for (let i = 0; i < b64.length; i++) diff |= b64.charCodeAt(i) ^ hmacHeader.charCodeAt(i);
  return diff === 0;
}
