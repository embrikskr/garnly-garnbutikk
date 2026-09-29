/**
 * Ren logikk for hvor mange av en vare Garnly kan selge fra en butikk.
 *
 * Kassetallet er ikke det samme som det vi kan selge. To ting trekkes fra:
 *
 * 1. **safety_stock** – butikkens egen buffer, så nettbutikken ikke tømmer hylla.
 *
 * 2. **Ventende kassauttrekk.** Et Garnly-salg trekkes ikke automatisk i butikkens kasse;
 *    butikken slår det ut manuelt, av og til dager etter at ordren er sendt. Fram til det
 *    rapporterer kassa varer som fysisk er ute av butikken.
 *
 *    Shopifys `committed` løser bare halve problemet: den holder varen av veien fram til
 *    fulfillment, og i det fulfillment opprettes trekker Shopify selv ned `on_hand`. Men da
 *    kommer neste synk og skriver kassetallet rett over igjen, og varen blir salgbar på nytt
 *    uten å finnes. Derfor trekker vi fra de fulfillede linjene butikken ennå ikke har
 *    bekreftet at er slått ut (`routing_groups.pos_deducted_at`).
 *
 *    Bare FULLFØRTE linjer trekkes fra. En tildelt, men usendt ordre står fortsatt som
 *    `committed` i Shopify, og trekkes fra `available` der – trakk vi den fra her også,
 *    ville vi trukket dobbelt.
 *
 * Retningen på feilen er med vilje: glemmer butikken knappen, viser vi for lite på lager.
 * Det taper et salg. Motsatt vei selger vi garn som ikke finnes, og det koster en kunde.
 */
export function sellableQty(posQty: number, safetyStock: number, pendingDeduction = 0): number {
  return Math.max(0, posQty - safetyStock - pendingDeduction);
}
