/**
 * Kall mot en partnerbutikks egen Shopify, med nøkkelen fra Garnly-appen (se shopify_oauth.ts).
 *
 * `store_secrets.secrets` for en slik butikk:
 *   {
 *     "app":     { "client_id": "...", "client_secret": "..." },   ← lagt inn av Garnly når appen lages
 *     "shopify": { "shop", "access_token", "access_expires_at",       ← skrevet av shopify-install
 *                  "refresh_token", "refresh_expires_at", "scope", "installed_at" }
 *   }
 * Butikken finnes på `stores.pos_config.shop_domain`. Raden må finnes før butikken installerer,
 * ellers vet vi ikke hvilken butikk nøkkelen hører til.
 *
 * Nøkkelen utløper etter én time og fornyes her. To kall som fornyer samtidig går bra: Shopify
 * lar den gamle fornyingsnøkkelen virke til den nye er brukt, og den som lagres sist, er gyldig.
 */
import { adminClient } from "./db.ts";
import { expiresAt, needsRefresh } from "./shopify_oauth.ts";

/**
 * Egen API-versjon for partnerbutikkene, uavhengig av Garnlys egen (SHOPIFY_API_VERSION).
 * 2026-10 fordi lagerlesingen bruker `InventoryItem.variants` og `ProductVariant.barcodes`;
 * `variant` og `barcode` er utfaset der (sjekket 11.11.2026).
 */
const API_VERSION = Deno.env.get("PARTNER_SHOPIFY_API_VERSION") ?? "2026-10";

export interface PartnerApp {
  client_id: string;
  client_secret: string;
}

export interface PartnerTokens {
  shop: string;
  access_token: string;
  access_expires_at: string | null;
  refresh_token: string | null;
  refresh_expires_at: string | null;
  scope: string;
  installed_at: string;
}

export interface PartnerSecrets {
  app?: PartnerApp;
  shopify?: PartnerTokens;
  [k: string]: unknown;
}

interface TokenSvar {
  access_token: string;
  scope: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
}

export async function storeByShop(shop: string): Promise<{ id: string; name: string } | null> {
  const { data, error } = await adminClient().from("stores").select("id, name").eq("pos_config->>shop_domain", shop).maybeSingle();
  if (error) throw new Error(`Fant ikke butikk for ${shop}: ${error.message}`);
  return data;
}

export async function readSecrets(storeId: string): Promise<PartnerSecrets> {
  const { data, error } = await adminClient().from("store_secrets").select("secrets").eq("store_id", storeId).maybeSingle();
  if (error) throw new Error(`store_secrets: ${error.message}`);
  return (data?.secrets ?? {}) as PartnerSecrets;
}

async function lagreNokler(storeId: string, shop: string, svar: TokenSvar, installedAt?: string) {
  const nå = Date.now();
  const gamle = await readSecrets(storeId);
  const shopify: PartnerTokens = {
    shop,
    access_token: svar.access_token,
    access_expires_at: expiresAt(nå, svar.expires_in),
    refresh_token: svar.refresh_token ?? null,
    refresh_expires_at: expiresAt(nå, svar.refresh_token_expires_in),
    scope: svar.scope ?? gamle.shopify?.scope ?? "",
    installed_at: installedAt ?? gamle.shopify?.installed_at ?? new Date(nå).toISOString(),
  };
  const { error } = await adminClient().from("store_secrets")
    .upsert({ store_id: storeId, secrets: { ...gamle, shopify }, updated_at: new Date(nå).toISOString() }, { onConflict: "store_id" });
  if (error) throw new Error(`Kunne ikke lagre nøkkelen: ${error.message}`);
  return shopify;
}

async function tokenKall(shop: string, body: Record<string, string>): Promise<TokenSvar> {
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    // Aldri logg selve svaret: det kan inneholde nøkler.
    throw new Error(`Shopify ga ingen nøkkel (${res.status}${json.error ? `: ${json.error}` : ""})`);
  }
  return json as TokenSvar;
}

/** Bytter koden fra godkjenningen i nøkler og lagrer dem. Returnerer tilgangene butikken ga. */
export async function exchangeCode(storeId: string, shop: string, app: PartnerApp, code: string): Promise<PartnerTokens> {
  const svar = await tokenKall(shop, { client_id: app.client_id, client_secret: app.client_secret, code, expiring: "1" });
  return await lagreNokler(storeId, shop, svar, new Date().toISOString());
}

/** Gyldig nøkkel for butikkens Shopify, fornyet ved behov. */
export async function partnerAccessToken(storeId: string): Promise<{ shop: string; token: string }> {
  const s = await readSecrets(storeId);
  const t = s.shopify;
  if (!t?.access_token) throw new Error("Butikken har ikke installert Garnly-appen ennå.");
  if (!needsRefresh(t.access_expires_at, Date.now())) return { shop: t.shop, token: t.access_token };

  if (!t.refresh_token || !s.app) throw new Error("Nøkkelen er utløpt og kan ikke fornyes. Butikken må installere Garnly-appen på nytt.");
  if (t.refresh_expires_at && Date.parse(t.refresh_expires_at) < Date.now()) {
    throw new Error("Fornyingsnøkkelen er utløpt (90 dager uten bruk). Butikken må åpne Garnly-appen i Shopify på nytt.");
  }
  const svar = await tokenKall(t.shop, {
    client_id: s.app.client_id,
    client_secret: s.app.client_secret,
    grant_type: "refresh_token",
    refresh_token: t.refresh_token,
  });
  const ny = await lagreNokler(storeId, t.shop, svar);
  return { shop: ny.shop, token: ny.access_token };
}

/** GraphQL mot butikkens Shopify. Prøver igjen ved 429 (for mange kall). */
export async function partnerGql<T = any>(storeId: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  for (let forsok = 0; forsok < 4; forsok++) {
    const { shop, token } = await partnerAccessToken(storeId);
    const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 1500 * (forsok + 1)));
      continue;
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${shop}: ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
    if (json.errors?.length) {
      if (json.errors.some((e: { extensions?: { code?: string } }) => e.extensions?.code === "THROTTLED")) {
        await new Promise((r) => setTimeout(r, 1500 * (forsok + 1)));
        continue;
      }
      throw new Error(`${shop}: ${JSON.stringify(json.errors).slice(0, 300)}`);
    }
    return json.data as T;
  }
  throw new Error("For mange kall mot butikkens Shopify – prøv igjen senere.");
}
