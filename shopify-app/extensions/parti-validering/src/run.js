// @ts-check
/**
 * Garnparti-regelen (byggeplan §7): hele antallet av én varelinje må kunne leveres av ÉN butikk.
 * Metafeltet garnly.stock_by_store = {"NO:gid://shopify/Location/123": 4, "DK:gid://…": 30} skrives av
 * sync-store. Mangler metafeltet, blokkerer vi ikke (ingen lagerdata enda; ruting eskalerer heller).
 *
 * Aldri over tollgrensen (byggeplan §15b, migrasjon 039): bare lokasjoner i kundens land teller.
 * Landet er leveringsadressens, ellers markedets (localization). Nøkler uten land (skrevet før
 * 18.11.2026) er norske, som alle butikkene var da.
 */

const HJEMLAND = "NO";

/**
 * Landet kurven skal leveres i. REN logikk.
 * @param {{ localization?: { country?: { isoCode?: string } | null } | null, cart: { deliveryGroups?: Array<{ deliveryAddress?: { countryCode?: string | null } | null }> } }} input
 * @returns {string}
 */
export function kundeland(input) {
  const levering = (input.cart.deliveryGroups ?? []).map((g) => g?.deliveryAddress?.countryCode).find((c) => c);
  const land = String(levering ?? input.localization?.country?.isoCode ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(land) ? land : HJEMLAND;
}

/**
 * @param {{ localization?: { country?: { isoCode?: string } | null } | null, cart: { deliveryGroups?: Array<{ deliveryAddress?: { countryCode?: string | null } | null }>, lines: Array<{ quantity: number, merchandise: { __typename: string, id?: string, product?: { title: string }, metafield?: { value: string } | null } }> } }} input
 * @returns {{ errors: Array<{ localizedMessage: string, target: string }> }}
 */
export function run(input) {
  const land = kundeland(input);
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
    const max = maxSingleStoreQty(metafield, land);
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
 * Største antall én enkelt butikk (location) i landet har. null = ingen lagerdata → ikke blokker.
 * @param {{ value: string } | null} metafield
 * @param {string} land
 * @returns {number | null}
 */
export function maxSingleStoreQty(metafield, land = HJEMLAND) {
  if (!metafield?.value) return null;
  let stock;
  try {
    stock = JSON.parse(metafield.value);
  } catch {
    return null;
  }
  if (!stock || typeof stock !== "object" || Array.isArray(stock)) return null;
  let max = 0;
  for (const [nokkel, v] of Object.entries(stock)) {
    // «DK:gid://…» – landet før kolon. Uten land: skrevet før 18.11.2026, norsk.
    const m = /^([A-Z]{2}):/.exec(nokkel);
    if ((m ? m[1] : HJEMLAND) !== land) continue;
    const n = Number(v);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}
