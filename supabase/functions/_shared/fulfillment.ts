/**
 * Når ble en gruppe sendt?
 *
 * Garnly oppretter aldri fulfillments selv. Butikken lager sendingen i CargonizerConnect
 * (Logistra), og den appen fulfiller ordren i Shopify med sporingsnummer. Vi må derfor lese
 * fulfillment-tidspunktet ut av Shopify i stedet for å sette det når vi selv gjør noe.
 *
 * Hvorfor tidspunktet betyr noe: i det Shopify oppretter en fulfillment, faller `committed`
 * bort og Shopify trekker selv ned `on_hand`. Butikkens kasse teller fortsatt varene, så fra
 * det øyeblikket – og til butikken bekrefter uttrekket – må vi trekke dem fra selv.
 * Se `inventory.ts`.
 */

export interface GroupForMatch {
  id: string;
  /** Butikkens shopify_location_id. */
  location_id: string | null;
  /** Variantene i gruppens linjer. */
  variant_ids: string[];
}

export interface FulfillmentForMatch {
  id: string;
  createdAt: string;
  locationId: string | null;
  variantIds: string[];
}

/**
 * Kobler Shopify-fulfillments til våre grupper, og svarer med tidspunktet hver gruppe ble sendt.
 *
 * Vi matcher på location først: én ordre deles bare mellom butikker, og hver butikk har sin
 * egen location, så en fulfillment opprettet på en location tilhører gruppen som er tildelt
 * butikken der. Faller det sammen – to grupper hos samme butikk etter en ny oppdeling – skiller
 * vi dem på hvilke varianter fulfillmenten faktisk inneholder.
 *
 * En fulfillment brukes bare én gang, og en gruppe får det tidligste tidspunktet som passer.
 */
export function matchFulfillments(
  groups: GroupForMatch[],
  fulfillments: FulfillmentForMatch[],
): Map<string, string> {
  const resultat = new Map<string, string>();
  const brukt = new Set<string>();

  // Eldste først, så en gruppe får tidspunktet for den første sendingen som dekker den.
  const sortert = [...fulfillments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  for (const f of sortert) {
    if (brukt.has(f.id)) continue;
    const kandidater = groups.filter((g) => !resultat.has(g.id));
    if (!kandidater.length) break;

    const påLocation = f.locationId ? kandidater.filter((g) => g.location_id === f.locationId) : [];
    const utvalg = påLocation.length ? påLocation : kandidater;

    let valgt: GroupForMatch | undefined;
    if (utvalg.length === 1) {
      valgt = utvalg[0];
    } else {
      // Flere mulige: ta den med flest varianter til felles med sendingen.
      let best = 0;
      for (const g of utvalg) {
        const overlapp = g.variant_ids.filter((v) => f.variantIds.includes(v)).length;
        if (overlapp > best) { best = overlapp; valgt = g; }
      }
      // Ingen overlapp i det hele tatt: da vet vi ikke hvilken gruppe det er, og lar den stå.
      if (!valgt) continue;
    }

    resultat.set(valgt.id, f.createdAt);
    brukt.add(f.id);
  }
  return resultat;
}
