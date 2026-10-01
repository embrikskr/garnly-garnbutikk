import { assertEquals } from "jsr:@std/assert@1";
import { fordelRefusjon, type OppgjorsGruppe, type Refusjon, tilOre } from "./settlement.ts";

const MERINO = "gid://shopify/ProductVariant/50557497933884";
const ALPAKKA = "gid://shopify/ProductVariant/50557445668924";

const gruppe = (id: string, varianter: string[], over: Partial<OppgjorsGruppe> = {}): OppgjorsGruppe => ({
  id,
  status: "fulfilled",
  storeId: "strikkefryd",
  varianter,
  ...over,
});

const refusjon = (over: Partial<Refusjon> = {}): Refusjon => ({
  taxesIncluded: true,
  totalOre: 16400,
  linjer: [{ variantId: MERINO, antall: 1, subtotalOre: 8500, mvaOre: 0 }],
  frakt: [{ subtotalOre: 7900, mvaOre: 0 }],
  ...over,
});

Deno.test("Shopify-beløp til øre uten flyttallsstøy", () => {
  assertEquals(tilOre("85.0"), 8500);
  assertEquals(tilOre("99.95"), 9995);
  assertEquals(tilOre("0.1"), 10);
  assertEquals(tilOre(null), 0);
  assertEquals(tilOre("tull"), 0);
});

Deno.test("#1004 slik Shopify har den: varene trekkes, frakten ikke", () => {
  // Ekte refusjon 01.10.2026: 1 × 85 kr + 79 kr frakt, 164 kr tilbake.
  const f = fordelRefusjon(refusjon(), [gruppe("g1004", [MERINO])]);
  assertEquals(f.trekk, [{ groupId: "g1004", storeId: "strikkefryd", varebelopOre: 8500 }]);
  assertEquals(f.fraktOre, 7900);
  assertEquals(f.ikkeTrukket, []);
});

Deno.test("bare frakt refundert: ingenting trekkes fra butikken", () => {
  const f = fordelRefusjon(refusjon({ totalOre: 7900, linjer: [] }), [gruppe("g", [MERINO])]);
  assertEquals(f.trekk, []);
  assertEquals(f.ikkeTrukket, []);
});

Deno.test("delvis refusjon: bare de refunderte nøstene", () => {
  const f = fordelRefusjon(
    refusjon({ totalOre: 17000, linjer: [{ variantId: MERINO, antall: 2, subtotalOre: 17000, mvaOre: 0 }], frakt: [] }),
    [gruppe("g", [MERINO])],
  );
  assertEquals(f.trekk[0].varebelopOre, 17000);
});

Deno.test("beløpet satt ned ved refusjonen: butikken trekkes for det kunden fikk, ikke listeprisen", () => {
  // Varer 85 + frakt 79 = 164, men bare 100 betalt tilbake. Frakten regnes først (Garnlys),
  // så varene står igjen med 21 kr.
  const f = fordelRefusjon(refusjon({ totalOre: 10000 }), [gruppe("g", [MERINO])]);
  assertEquals(f.trekk[0].varebelopOre, 2100);
});

Deno.test("refunderte varer fordeles på hver sin butikk når ordren var splittet", () => {
  const f = fordelRefusjon(
    refusjon({
      totalOre: 8500 + 12900,
      linjer: [
        { variantId: MERINO, antall: 1, subtotalOre: 8500, mvaOre: 0 },
        { variantId: ALPAKKA, antall: 1, subtotalOre: 12900, mvaOre: 0 },
      ],
      frakt: [],
    }),
    [gruppe("gA", [MERINO]), gruppe("gB", [ALPAKKA], { storeId: "garnkilden", status: "assigned" })],
  );
  assertEquals(f.trekk, [
    { groupId: "gA", storeId: "strikkefryd", varebelopOre: 8500 },
    { groupId: "gB", storeId: "garnkilden", varebelopOre: 12900 },
  ]);
});

Deno.test("refundert før noen butikk fikk ordren: ingen å trekke, og ikke noe å varsle om", () => {
  for (const status of ["routing", "escalated", "cancelled"]) {
    const f = fordelRefusjon(refusjon(), [gruppe("g", [MERINO], { status, storeId: null })]);
    assertEquals(f.trekk, [], status);
    assertEquals(f.forTildelingOre, 8500, status);
    assertEquals(f.ikkeTrukket, [], status);
  }
});

Deno.test("en erstattet splitt teller ikke: varianten finnes bare i den gjeldende gruppa", () => {
  const f = fordelRefusjon(refusjon(), [
    gruppe("gammel", [MERINO], { status: "resplit", storeId: null }),
    gruppe("ny", [MERINO]),
  ]);
  assertEquals(f.trekk.map((t) => t.groupId), ["ny"]);
});

Deno.test("ukjent variant eller to mulige grupper: ikke gjett, si fra", () => {
  const ukjent = fordelRefusjon(refusjon(), [gruppe("g", [ALPAKKA])]);
  assertEquals(ukjent.trekk, []);
  assertEquals(ukjent.ikkeTrukket.map((x) => x.belopOre), [8500]);

  const tvetydig = fordelRefusjon(refusjon(), [
    gruppe("gA", [MERINO]),
    gruppe("gB", [MERINO], { storeId: "garnkilden" }),
  ]);
  assertEquals(tvetydig.trekk, []);
  assertEquals(tvetydig.ikkeTrukket[0].grunn.startsWith("varianten ligger i 2 grupper"), true);
});

Deno.test("refusjon uten varelinjer (godvilje) trekkes ikke automatisk", () => {
  const f = fordelRefusjon(refusjon({ totalOre: 5000, linjer: [], frakt: [] }), [gruppe("g", [MERINO])]);
  assertEquals(f.trekk, []);
  assertEquals(f.ikkeTrukket, [{ belopOre: 5000, grunn: "refusjon uten varelinjer" }]);
});

Deno.test("priser uten mva: mva legges på subtotal, så varebeløpet er inkl. mva som salget", () => {
  const f = fordelRefusjon(
    refusjon({ taxesIncluded: false, totalOre: 8500, linjer: [{ variantId: MERINO, antall: 1, subtotalOre: 6800, mvaOre: 1700 }], frakt: [] }),
    [gruppe("g", [MERINO])],
  );
  assertEquals(f.trekk[0].varebelopOre, 8500);
});
