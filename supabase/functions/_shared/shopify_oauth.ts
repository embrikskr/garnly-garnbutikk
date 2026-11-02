/**
 * Garnly-appen i partnerbutikkenes egen Shopify – innloggingen (OAuth authorization code grant).
 *
 * Utenlandske partnerbutikker (først en dansk) har lageret sitt i egen Shopify. Siden januar 2026
 * kan ikke butikker lage API-nøkler i Shopify-admin selv lenger, så de installerer en app fra
 * Garnly. Appen lages i Shopifys Dev Dashboard med «custom distribution» – én app per butikk,
 * fordi en slik app bare kan installeres i én butikk. Klient-id og -hemmelighet ligger derfor
 * per butikk i `store_secrets`, ikke i Edge Function-secrets. Se `shopify-partner-app/README.md`.
 *
 * Flyten (`shopify-install`):
 *   1. Butikken klikker installasjonslenken. Shopify sender dem til appens URL med `shop` og `hmac`.
 *   2. Vi sjekker hmac og sender dem til Shopifys godkjenningsside med tilgangene under.
 *   3. Shopify sender dem tilbake med en kode, som vi bytter i en nøkkel som utløper etter én time,
 *      og en fornyingsnøkkel som varer i 90 dager (`expiring=1`). Se `partner_shop.ts`.
 *
 * REN logikk, ingen I/O (bortsett fra WebCrypto).
 */

/**
 * Det appen får gjøre i butikkens Shopify:
 *   - lese produkter, varianter og strekkoder (kobling til Garnlys varer)
 *   - lese lager og lokasjoner (lagersynk)
 *   - opprette ordrer merket «Garnly» når butikken godtar en ordre (varene trekkes fra lageret)
 * Appen endrer aldri produkter eller priser.
 */
export const PARTNER_SCOPES = ["read_products", "read_inventory", "read_locations", "write_orders"] as const;

/** Bare ekte myshopify-domener – ellers kunne `shop` sende brukeren og koden hvor som helst. */
export function isValidShopDomain(shop: string | null | undefined): shop is string {
  return !!shop && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop);
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function likeStrenger(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Meldingen Shopify signerer: alle parametre unntatt hmac (og signature), sortert, som k=v&k=v. */
export function oauthMessage(params: URLSearchParams): string {
  return [...params.entries()]
    .filter(([k]) => k !== "hmac" && k !== "signature")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

/** Er forespørselen fra Shopify? Gjelder både første kall (installasjon) og tilbakekallet med koden. */
export async function verifyOauthHmac(params: URLSearchParams, clientSecret: string): Promise<boolean> {
  const hmac = params.get("hmac");
  if (!hmac) return false;
  return likeStrenger(await hmacHex(clientSecret, oauthMessage(params)), hmac.toLowerCase());
}

export function authorizeUrl(a: { shop: string; clientId: string; redirectUri: string; state: string }): string {
  const q = new URLSearchParams({ client_id: a.clientId, scope: PARTNER_SCOPES.join(","), redirect_uri: a.redirectUri, state: a.state });
  return `https://${a.shop}/admin/oauth/authorize?${q}`;
}

/** Tilganger vi ba om, men ikke fikk. En write_-tilgang dekker samme read_. */
export function missingScopes(granted: string, wanted: readonly string[] = PARTNER_SCOPES): string[] {
  const fikk = new Set(granted.split(",").map((s) => s.trim()).filter(Boolean));
  return wanted.filter((s) => !fikk.has(s) && !(s.startsWith("read_") && fikk.has(`write_${s.slice(5)}`)));
}

/**
 * `state` binder tilbakekallet til samme butikk, samme nettleser og de siste 15 minuttene:
 * `<tid>.<nonce>.<signatur>`, der nonce også ligger i en HttpOnly-cookie. Uten den kunne noen
 * lure en innlogget bruker til å fullføre en innlogging de selv har startet.
 */
export async function signState(shop: string, nonce: string, nowMs: number, secret: string): Promise<string> {
  const ts = Math.floor(nowMs / 1000);
  return `${ts}.${nonce}.${await hmacHex(secret, `${shop}|${ts}|${nonce}`)}`;
}

export const STATE_TTL_S = 15 * 60;

export async function verifyState(
  state: string | null,
  a: { shop: string; cookieNonce: string | null; nowMs: number; secret: string },
): Promise<boolean> {
  if (!state || !a.cookieNonce) return false;
  const [tsStr, nonce, sig] = state.split(".");
  const ts = Number(tsStr);
  if (!Number.isFinite(ts) || !nonce || !sig || nonce !== a.cookieNonce) return false;
  const alder = Math.floor(a.nowMs / 1000) - ts;
  if (alder < 0 || alder > STATE_TTL_S) return false;
  return likeStrenger(await hmacHex(a.secret, `${a.shop}|${ts}|${nonce}`), sig);
}

export function expiresAt(nowMs: number, seconds: number | null | undefined): string | null {
  return typeof seconds === "number" ? new Date(nowMs + seconds * 1000).toISOString() : null;
}

/** Fornyes når det er under fem minutter igjen, så et kall ikke rekker å gå ut midt i en synk. */
export function needsRefresh(accessExpiresAt: string | null | undefined, nowMs: number, marginMs = 5 * 60 * 1000): boolean {
  if (!accessExpiresAt) return false; // ikke-utløpende nøkkel
  return Date.parse(accessExpiresAt) - nowMs < marginMs;
}
