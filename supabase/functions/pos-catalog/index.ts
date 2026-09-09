/**
 * Frisker opp den mellomlagrede produktkatalogen for kassesystemer som ikke gir strekkode
 * i lagerkallet (per i dag bare Duell). Kjøres av pg_cron én gang i døgnet.
 *
 * Katalogen er klient-omfattende, så vi blar den gjennom én gang per client_number,
 * ikke én gang per butikk.
 */
import { adminClient, json, requireInternalSecret } from "../_shared/db.ts";
import { refreshCatalog } from "../_shared/adapters/duell.ts";
import type { StoreRow } from "../_shared/types.ts";

Deno.serve(async (req) => {
  const unauthorized = requireInternalSecret(req);
  if (unauthorized) return unauthorized;
  const body = await req.json().catch(() => ({})) as { wait?: boolean };

  const db = adminClient();
  // Ikke filtrer på active: butikker under oppsett er inaktive, og det er nettopp da katalogen
  // trengs for å se om matchingen holder. Ett crawl per klient uansett hvor mange butikker.
  const { data: stores, error } = await db.from("stores").select("*").eq("pos_system", "duell");
  if (error) return json({ error: error.message }, 500);

  const done = new Set<string>();
  const results: Array<Record<string, unknown>> = [];

  const work = (async () => {
  for (const store of (stores ?? []) as StoreRow[]) {
    const { data: sec } = await db.from("store_secrets").select("secrets").eq("store_id", store.id).maybeSingle();
    const secrets = (sec?.secrets ?? {}) as Record<string, string>;
    const client = secrets.client_number;
    if (!client) {
      results.push({ store: store.name, skipped: "client_number mangler" });
      continue;
    }
    if (done.has(client)) {
      results.push({ store: store.name, skipped: `klient ${client} allerede oppfrisket` });
      continue;
    }
    done.add(client);
    try {
      const r = await refreshCatalog(secrets);
      results.push({ store: store.name, client, ...r });
    } catch (e) {
      results.push({ store: store.name, client, error: (e as Error).message });
    }
  }
  })();

  // Ett crawl tar ~2 minutter, som er akkurat grensen for pg_net. Svar med en gang og
  // fullfør i bakgrunnen; resultatet leses av v_pos_catalog_status. {"wait":true} for å vente.
  // @ts-ignore EdgeRuntime finnes i Supabase Edge Functions
  if (!body.wait && typeof EdgeRuntime !== "undefined") {
    // @ts-ignore
    EdgeRuntime.waitUntil(work.catch((e: unknown) => console.error("pos-catalog bakgrunnsfeil:", e)));
    return json({ started: (stores ?? []).length, background: true });
  }
  await work;
  return json({ clients: done.size, results });
});
