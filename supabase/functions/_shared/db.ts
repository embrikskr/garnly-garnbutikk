import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

let _client: SupabaseClient | null = null;

/** Service-role-klient. Kun for Edge Functions, aldri til frontend. */
export function adminClient(): SupabaseClient {
  if (_client) return _client;
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY mangler");
  _client = createClient(url, key, { auth: { persistSession: false } });
  return _client;
}

export async function audit(entity: string, entityId: string | null, event: string, payload?: unknown) {
  const { error } = await adminClient().from("audit_log").insert({ entity, entity_id: entityId, event, payload: payload ?? null });
  if (error) console.error("audit_log insert feilet:", error.message);
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

export function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

/** Enkel delt hemmelighet for kall fra pg_cron og interne kall mellom funksjoner. */
export function requireInternalSecret(req: Request): Response | null {
  const expected = Deno.env.get("CRON_SECRET");
  if (!expected) return json({ error: "CRON_SECRET ikke satt" }, 500);
  const got = req.headers.get("x-cron-secret");
  if (got !== expected) return json({ error: "unauthorized" }, 401);
  return null;
}

export async function callFunction(name: string, body: unknown): Promise<Response> {
  const base = Deno.env.get("SUPABASE_URL")!.replace(/\/$/, "") + "/functions/v1/";
  return fetch(base + name, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-cron-secret": Deno.env.get("CRON_SECRET") ?? "",
      Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
    },
    body: JSON.stringify(body),
  });
}
