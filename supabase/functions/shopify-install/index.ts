/**
 * shopify-install: Garnly-appen i en partnerbutikks egen Shopify (se _shared/shopify_oauth.ts).
 *
 * Er både appens URL og redirect-URL i Dev Dashboard (samme adresse; tilbakekallet har `code`):
 *
 *   GET ?shop&hmac&timestamp…   butikken installerer eller åpner appen → godkjenningssiden i Shopify
 *   GET ?code&shop&state&hmac…  butikken har godkjent → bytt koden i nøkler, lagre i store_secrets
 *
 * Er appen alt installert med alle tilganger, sier vi bare det – et nytt bytte ville trukket
 * tilbake fornyingsnøkkelen som lagersynken bruker.
 *
 * Svarene er ren tekst: Supabase viser uansett ikke HTML fra Edge Functions på eget domene.
 * verify_jwt må være av; kallet kommer fra Shopify og butikkens nettleser, ikke fra en innlogget bruker.
 */
import { audit } from "../_shared/db.ts";
import { exchangeCode, readSecrets, storeByShop } from "../_shared/partner_shop.ts";
import { authorizeUrl, isValidShopDomain, missingScopes, needsRefresh, signState, verifyOauthHmac, verifyState } from "../_shared/shopify_oauth.ts";

const COOKIE = "garnly_oauth";

function tekst(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...headers } });
}

function cookieNonce(req: Request): string | null {
  const m = (req.headers.get("cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? m[1] : null;
}

function redirectUri(): string {
  return `${Deno.env.get("SUPABASE_URL")!.replace(/\/$/, "")}/functions/v1/shopify-install`;
}

Deno.serve(async (req) => {
  if (req.method !== "GET") return tekst("Method not allowed", 405);
  const params = new URL(req.url).searchParams;
  const shop = params.get("shop");
  if (!isValidShopDomain(shop)) return tekst("Ugyldig butikkadresse.", 400);

  const butikk = await storeByShop(shop);
  if (!butikk) {
    console.error("[shopify-install] ukjent butikk", shop);
    return tekst(`${shop} er ikke satt opp hos Garnly ennå. Kontakt Garnly.`, 404);
  }
  const secrets = await readSecrets(butikk.id);
  const app = secrets.app;
  if (!app?.client_id || !app?.client_secret) {
    console.error("[shopify-install] mangler app-nøkler for", butikk.name);
    return tekst("Garnly-appen er ikke ferdig satt opp for butikken. Kontakt Garnly.", 500);
  }
  if (!(await verifyOauthHmac(params, app.client_secret))) return tekst("Forespørselen kom ikke fra Shopify.", 401);

  const code = params.get("code");

  // ---- tilbakekall: butikken har godkjent ----------------------------------
  if (code) {
    const ok = await verifyState(params.get("state"), { shop, cookieNonce: cookieNonce(req), nowMs: Date.now(), secret: app.client_secret });
    if (!ok) return tekst("Innloggingen er utløpt eller ble startet i en annen nettleser. Åpne Garnly-appen i Shopify på nytt.", 403);
    let lagret;
    try {
      lagret = await exchangeCode(butikk.id, shop, app, code);
    } catch (e) {
      console.error("[shopify-install] bytte av kode feilet", shop, e instanceof Error ? e.message : e);
      return tekst("Shopify ga oss ikke tilgang. Prøv igjen, eller kontakt Garnly.", 502);
    }
    const mangler = missingScopes(lagret.scope);
    await audit("store", butikk.id, "shopify_app_installed", { shop, scope: lagret.scope, mangler });
    if (mangler.length) return tekst(`Garnly fikk ikke all tilgangen den trenger (${mangler.join(", ")}). Kontakt Garnly.`, 403);
    return tekst(
      `Garnly er koblet til ${butikk.name}. Du kan lukke dette vinduet.`,
      200,
      { "Set-Cookie": `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` },
    );
  }

  // ---- første kall: installasjon, eller butikken åpner appen ---------------
  const t = secrets.shopify;
  const ferdig = t?.shop === shop && t.refresh_token && !missingScopes(t.scope).length &&
    !(t.refresh_expires_at && needsRefresh(t.refresh_expires_at, Date.now(), 7 * 24 * 3600 * 1000));
  if (ferdig) return tekst(`Garnly er koblet til ${butikk.name}. Det er ingenting mer å gjøre her.`);

  const nonce = crypto.randomUUID();
  const state = await signState(shop, nonce, Date.now(), app.client_secret);
  return new Response(null, {
    status: 302,
    headers: {
      Location: authorizeUrl({ shop, clientId: app.client_id, redirectUri: redirectUri(), state }),
      "Set-Cookie": `${COOKIE}=${nonce}; Path=/; Max-Age=900; HttpOnly; Secure; SameSite=Lax`,
    },
  });
});
