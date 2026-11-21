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
  /** Shopifys FulfillmentStatus: SUCCESS, PENDING, OPEN, CANCELLED, ERROR, FAILURE. */
  status?: string | null;
  locationId: string | null;
  variantIds: string[];
}

/**
 * Teller denne sendingen som sendt?
 *
 * En kansellert sending legger lageret tilbake i Shopify. Fester vi `fulfilled_at` til den,
 * holder vi igjen varer Shopify allerede har lagt tilbake – og varen blir stående utilgjengelig
 * for salg. Sett 29.09: #1002 hadde både en kansellert og en vellykket sending.
 * Uten status regnes den som gyldig, så eldre kall ikke stilner.
 */
function teller(f: FulfillmentForMatch): boolean {
  const st = (f.status ?? "").toUpperCase();
  return st !== "CANCELLED" && st !== "ERROR" && st !== "FAILURE";
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
  // Kansellerte og feilede sendinger holdes utenfor: de har lagt lageret tilbake i Shopify.
  const sortert = fulfillments.filter(teller).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  for (const f of sortert) {
    if (brukt.has(f.id)) continue;
    const kandidater = groups.filter((g) => !resultat.has(g.id));
    if (!kandidater.length) break;

    // En sending fra én location tilhører aldri en gruppe hos en annen butikk. Før falt vi
    // tilbake på alle grupper når ingen lå på sendingens location, og da fikk Strikkefryds
    // del av #1057 og #1058 Garnkildens sending (21.11.2026): kortene forsvant fra «Til pakking»
    // før noe var pakket. Grupper uten location (ikke tildelt ennå) kan fortsatt matche.
    const utvalg = f.locationId
      ? kandidater.filter((g) => g.location_id === f.locationId || g.location_id === null)
      : kandidater;
    if (!utvalg.length) continue;

    let valgt: GroupForMatch | undefined;
    // Én kandidat holder bare når sendingen ikke sier hvilke varer den har, eller har minst én
    // av gruppens varer. En sending helt uten felles varer er en annen del av ordren.
    if (utvalg.length === 1 && (!f.variantIds.length || utvalg[0].variant_ids.some((v) => f.variantIds.includes(v)))) {
      valgt = utvalg[0];
    } else if (utvalg.length > 1) {
      // Flere mulige: ta den med flest varianter til felles med sendingen.
      let best = 0;
      for (const g of utvalg) {
        const overlapp = g.variant_ids.filter((v) => f.variantIds.includes(v)).length;
        if (overlapp > best) { best = overlapp; valgt = g; }
      }
      // Ingen overlapp i det hele tatt: da vet vi ikke hvilken gruppe det er, og lar den stå.
    }
    if (!valgt) continue;

    resultat.set(valgt.id, f.createdAt);
    brukt.add(f.id);
  }
  return resultat;
}
