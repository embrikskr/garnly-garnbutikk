/** Engangs-tokens for godta/avslå-lenker. Lagres kun som sha256-hash i offers.token_hash. */

export function newToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function offerLinks(token: string): { accept: string; decline: string } {
  const base = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "") + "/functions/v1/offer-respond";
  return {
    accept: `${base}?t=${token}&a=accept`,
    decline: `${base}?t=${token}&a=decline`,
  };
}
