import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  authorizeUrl,
  hmacHex,
  isValidShopDomain,
  missingScopes,
  needsRefresh,
  oauthMessage,
  signState,
  STATE_TTL_S,
  verifyOauthHmac,
  verifyState,
} from "./shopify_oauth.ts";

const HEMMELIG = "hush";

Deno.test("isValidShopDomain: bare myshopify-domener", () => {
  assert(isValidShopDomain("garn-dk.myshopify.com"));
  assert(!isValidShopDomain("garn-dk.myshopify.com.evil.io"));
  assert(!isValidShopDomain("evil.io"));
  assert(!isValidShopDomain("Garn.myshopify.com"));
  assert(!isValidShopDomain(null));
});

Deno.test("oauthMessage: uten hmac, sortert på nøkkel", () => {
  const p = new URLSearchParams("shop=a.myshopify.com&timestamp=1&hmac=x&code=c&host=h");
  assertEquals(oauthMessage(p), "code=c&host=h&shop=a.myshopify.com&timestamp=1");
});

Deno.test("verifyOauthHmac: riktig signatur godtas, endret parameter avvises", async () => {
  const p = new URLSearchParams("shop=a.myshopify.com&timestamp=1700000000&code=abc");
  p.set("hmac", await hmacHex(HEMMELIG, oauthMessage(p)));
  assert(await verifyOauthHmac(p, HEMMELIG));
  assert(!(await verifyOauthHmac(p, "feil")));
  const endret = new URLSearchParams(p);
  endret.set("shop", "b.myshopify.com");
  assert(!(await verifyOauthHmac(endret, HEMMELIG)));
  const uten = new URLSearchParams(p);
  uten.delete("hmac");
  assert(!(await verifyOauthHmac(uten, HEMMELIG)));
});

Deno.test("authorizeUrl: tilgangene og redirect står i lenken", () => {
  const u = new URL(authorizeUrl({ shop: "a.myshopify.com", clientId: "id", redirectUri: "https://x/cb", state: "s" }));
  assertEquals(u.host, "a.myshopify.com");
  assertEquals(u.pathname, "/admin/oauth/authorize");
  assertEquals(u.searchParams.get("scope"), "read_products,read_inventory,read_locations,write_orders");
  assertEquals(u.searchParams.get("redirect_uri"), "https://x/cb");
});

Deno.test("missingScopes: write_ dekker read_, manglende meldes", () => {
  assertEquals(missingScopes("read_products,read_inventory,read_locations,write_orders"), []);
  assertEquals(missingScopes("write_products,write_inventory,read_locations,write_orders"), []);
  assertEquals(missingScopes("read_products,read_inventory"), ["read_locations", "write_orders"]);
});

Deno.test("state: gyldig for samme butikk, cookie og innen fristen", async () => {
  const nå = 1_800_000_000_000;
  const s = await signState("a.myshopify.com", "n1", nå, HEMMELIG);
  const ok = { shop: "a.myshopify.com", cookieNonce: "n1", nowMs: nå + 60_000, secret: HEMMELIG };
  assert(await verifyState(s, ok));
  assert(!(await verifyState(s, { ...ok, shop: "b.myshopify.com" })));
  assert(!(await verifyState(s, { ...ok, cookieNonce: "n2" })));
  assert(!(await verifyState(s, { ...ok, cookieNonce: null })));
  assert(!(await verifyState(s, { ...ok, secret: "feil" })));
  assert(!(await verifyState(s, { ...ok, nowMs: nå + (STATE_TTL_S + 1) * 1000 })));
  assert(!(await verifyState(null, ok)));
});

Deno.test("needsRefresh: fornyes fem minutter før utløp, aldri for nøkler uten utløp", () => {
  const nå = Date.parse("2026-11-02T12:00:00Z");
  assert(!needsRefresh("2026-11-02T12:30:00Z", nå));
  assert(needsRefresh("2026-11-02T12:04:00Z", nå));
  assert(needsRefresh("2026-11-02T11:00:00Z", nå));
  assert(!needsRefresh(null, nå));
});
