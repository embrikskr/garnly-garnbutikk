/**
 * REN logikk: kallet fra admin.garnly.no (17.11.2026, migrasjon 038).
 *
 * admin.garnly.no har sin egen innlogging (appens Supabase-prosjekt). Serveren der sjekker
 * selv at brukeren er admin, og kaller så hit med denne basens service role-nøkkel og navnet
 * på den som trykket i headeren `x-garnly-actor`. Nøkkelen er bevis nok på at kallet kommer
 * fra en av våre servere. Navnet er bare for loggen, og uten navn nektes kallet, så
 * audit_log aldri får et tomt «av».
 *
 * Nøkkelen sammenlignes i konstant tid.
 */

const MAX_ACTOR = 200;

/** Like strenger, uten at tiden avslører hvor langt de stemmer. */
export function constantTimeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

export type BridgeResult =
  | { kind: "not_bridge" }
  | { kind: "missing_actor" }
  | { kind: "ok"; actor: string };

/**
 * Er kallet fra admin.garnly.no? `token` er det som står etter «Bearer», `serviceKey` er
 * SUPABASE_SERVICE_ROLE_KEY, `actorHeader` er x-garnly-actor.
 */
export function bridgeActor(token: string, serviceKey: string | undefined, actorHeader: string | null): BridgeResult {
  if (!token || !serviceKey || !constantTimeEqual(token, serviceKey)) return { kind: "not_bridge" };
  const actor = (actorHeader ?? "").trim().slice(0, MAX_ACTOR);
  if (!actor) return { kind: "missing_actor" };
  return { kind: "ok", actor: `${actor} (admin.garnly.no)` };
}
