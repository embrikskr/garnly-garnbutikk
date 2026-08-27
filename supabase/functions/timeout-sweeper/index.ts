/**
 * timeout-sweeper: pg_cron hvert minutt. Finner tilbud med utløpt frist,
 * markerer expired, øker timeout_streak for butikken, og sender neste tilbud.
 */
import { adminClient, audit, json, requireInternalSecret } from "../_shared/db.ts";
import { makeNextOffer } from "../_shared/offers.ts";

Deno.serve(async (req) => {
  const unauthorized = requireInternalSecret(req);
  if (unauthorized) return unauthorized;
  const db = adminClient();
  const now = new Date().toISOString();
  const { data: expired } = await db.from("offers").select("id, store_id, routing_group_id").eq("status", "offered").lt("deadline_at", now).limit(200);

  const touchedGroups = new Set<string>();
  for (const o of expired ?? []) {
    // Betinget oppdatering så vi ikke kolliderer med et svar som kom akkurat nå
    const { data: upd } = await db.from("offers").update({ status: "expired", responded_at: now }).eq("id", o.id).eq("status", "offered").select("id");
    if (!upd?.length) continue;
    await db.rpc("mark_store_timeout", { p_store_id: o.store_id });
    await audit("offer", o.id, "expired", { store_id: o.store_id });
    touchedGroups.add(o.routing_group_id);
  }
  for (const g of touchedGroups) await makeNextOffer(g);
  return json({ expired: touchedGroups.size });
});
