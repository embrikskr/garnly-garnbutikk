/**
 * Er dette en testordre?
 *
 * Testordrer skal rutes og pakkes som ekte ordrer – det er hele poenget med å teste – men de
 * skal ikke telle som salg. Uten dette må hver testordre ryddes for hånd etterpå, og en som
 * blir glemt gir butikken betalt for noe som aldri ble solgt.
 *
 * To signaler, begge fra Shopify:
 *
 *   `tags`  – vi merker selv, f.eks. «TEST» eller «garnly-test». Det er det som virker når
 *             ordren betales med et ekte kort i en ekte butikk.
 *   `test`  – Shopifys eget flagg, satt når ordren gikk gjennom en testbetaling
 *             (Bogus Gateway). Den fanger testordrer ingen husket å merke.
 *
 * Taggene sammenlignes uten hensyn til store og små bokstaver og med trimmet mellomrom:
 * «TEST», «test» og « Test » er samme tag i praksis, og et mellomrom skal ikke avgjøre om en
 * ordre havner i oppgjøret.
 */
const TEST_TAGS = ["test", "garnly-test"];

export function erTestordre(tags: readonly string[] | null | undefined, testFlag?: boolean | null): boolean {
  if (testFlag) return true;
  return (tags ?? []).some((t) => TEST_TAGS.includes(t.trim().toLowerCase()));
}
