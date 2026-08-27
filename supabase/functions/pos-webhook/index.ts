/**
 * pos-webhook: mottar webhooks fra kassesystemer og trigger en synk for butikken.
 *   Mystore: POST /pos-webhook?store=<slug>  med header X-No-Mystore-Hmac-Sha256 (secret = store_secrets.secrets.webhook_secret)
 *
 * Vi bruker ikke innholdet i webhooken, bare signalet "noe endret seg" → kjør sync-store for butikken.
 * Debounce: maks én synk per butikk per 60 s.
 */
import { adminClient, callFunction, json } from "../_shared/db.ts";

const lastTrigger = new Map<string, number>();

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const slug = url.searchParams.get("store");
  if (!slug) return json({ error: "store mangler" }, 400);
  const raw = await req.text();
  const db = adminClient();
  const { data: store } = await db.from("stores").select("id, pos_system, last_sync_at").eq("slug", slug).maybeSingle();
  if (!store) return json({ error: "ukjent butikk" }, 404);
  const { data: sec } = await db.from("store_secrets").select("secrets").eq("store_id", store.id).maybeSingle();
  const secret = (sec?.secrets as Record<string, string>)?.webhook_secret;

  if (store.pos_system === "mystore") {
    const header = req.headers.get("x-no-mystore-hmac-sha256");
    if (!secret || !header || !(await hmacOk(raw, secret, header))) return json({ error: "invalid hmac" }, 401);
  } else {
    return json({ error: "webhook ikke støttet for " + store.pos_system }, 400);
  }

  const now = Date.now();
  if ((lastTrigger.get(store.id) ?? 0) > now - 60_000) return json({ ok: true, debounced: true });
  lastTrigger.set(store.id, now);
  // Fire-and-forget
  callFunction("sync-store", { store_id: store.id }).catch((e) => console.error(e));
  return json({ ok: true });
});

async function hmacOk(body: string, secret: string, header: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return b64 === header;
}
