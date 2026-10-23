/**
 * Varianter som er borte fra Shopify (slettet, eller produktet er arkivert).
 *
 * REN logikk, ingen I/O. sync-products sendte tidligere alle ~7 800 variant-id-ene i én
 * `not in (...)` i URL-en til PostgREST. Den ble for lang, kallet feilet, og feilen ble ikke
 * sjekket – så slettede varianter ble stående aktive i products (oppdaget 22.10.2026, da to
 * dobbelte farger ble slettet). Nå regnes forskjellen ut her, og radene oppdateres etter id.
 */
export function goneVariantRows(
  existing: Array<{ id: string; shopify_variant_id: string | null; active: boolean }>,
  seenVariantIds: Iterable<string>,
): string[] {
  const seen = new Set(seenVariantIds);
  return existing.filter((r) => r.active && r.shopify_variant_id && !seen.has(r.shopify_variant_id)).map((r) => r.id);
}
