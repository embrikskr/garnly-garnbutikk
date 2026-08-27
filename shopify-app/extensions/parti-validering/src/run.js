// @ts-check
/**
 * Garnparti-regelen (byggeplan §7): hele antallet av én varelinje må kunne leveres av ÉN butikk.
 * Metafeltet garnly.stock_by_store = {"gid://shopify/Location/123": 4, ...} skrives av sync-store.
 * Mangler metafeltet, blokkerer vi ikke (ingen lagerdata enda; ruting eskalerer heller i etterkant).
 */

/**
 * @param {{ cart: { lines: Array<{ quantity: number, merchandise: { __typename: string, id?: string, product?: { title: string }, metafield?: { value: string } | null } }> } }} input
 * @returns {{ errors: Array<{ localizedMessage: string, target: string }> }}
 */
export function run(input) {
  // Summer per variant: kunden kan ha samme variant på flere linjer.
  const perVariant = new Map();
  for (const line of input.cart.lines) {
    const v = line.merchandise;
    if (v.__typename !== "ProductVariant" || !v.id) continue;
    const prev = perVariant.get(v.id) ?? { qty: 0, title: v.product?.title ?? "varen", metafield: v.metafield ?? null };
    prev.qty += line.quantity;
    if (!prev.metafield && v.metafield) prev.metafield = v.metafield;
    perVariant.set(v.id, prev);
  }

  const errors = [];
  for (const { qty, title, metafield } of perVariant.values()) {
    const max = maxSingleStoreQty(metafield);
    if (max === null || qty <= max) continue;
    const suggestion = max > 0 ? `Prøv ${max} eller færre, eller velg en annen farge.` : "Velg en annen farge.";
    errors.push({
      localizedMessage:
        `Vi har dessverre ikke ${qty} stk av «${title}» fra samme parti akkurat nå. ${suggestion}`,
      target: "$.cart",
    });
  }
  return { errors };
}

/**
 * Største antall én enkelt butikk (location) har. null = ingen lagerdata → ikke blokker.
 * @param {{ value: string } | null} metafield
 * @returns {number | null}
 */
function maxSingleStoreQty(metafield) {
  if (!metafield?.value) return null;
  let stock;
  try {
    stock = JSON.parse(metafield.value);
  } catch {
    return null;
  }
  if (!stock || typeof stock !== "object" || Array.isArray(stock)) return null;
  let max = 0;
  for (const v of Object.values(stock)) {
    const n = Number(v);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}
