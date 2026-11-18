import assert from "node:assert/strict";
import { test } from "node:test";
import { kundeland, maxSingleStoreQty, run } from "../src/run.js";

const LOC_A = "gid://shopify/Location/1";
const LOC_B = "gid://shopify/Location/2";

function line(qty, stock, id = "gid://shopify/ProductVariant/1", title = "Lun Merino – Hvit") {
  return {
    quantity: qty,
    merchandise: {
      __typename: "ProductVariant",
      id,
      product: { title },
      metafield: stock === null ? null : { value: JSON.stringify(stock) },
    },
  };
}

test("én butikk har hele antallet → ingen feil", () => {
  const out = run({ cart: { lines: [line(5, { [LOC_A]: 5, [LOC_B]: 2 })] } });
  assert.equal(out.errors.length, 0);
});

test("summen dekker, men ingen enkelt butikk → blokker med forslag", () => {
  const out = run({ cart: { lines: [line(7, { [LOC_A]: 4, [LOC_B]: 3 })] } });
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0].localizedMessage, /7 stk/);
  assert.match(out.errors[0].localizedMessage, /Prøv 4 eller færre/);
  assert.equal(out.errors[0].target, "$.cart");
});

test("ingen butikk har varen → blokker uten antallsforslag", () => {
  const out = run({ cart: { lines: [line(2, { [LOC_A]: 0 })] } });
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0].localizedMessage, /Velg en annen farge/);
});

test("uten metafelt (ingen lagerdata) → ikke blokker", () => {
  const out = run({ cart: { lines: [line(9, null)] } });
  assert.equal(out.errors.length, 0);
});

test("ugyldig JSON i metafeltet → ikke blokker", () => {
  const out = run({
    cart: { lines: [{ quantity: 3, merchandise: { __typename: "ProductVariant", id: "gid://shopify/ProductVariant/9", product: { title: "X" }, metafield: { value: "{oops" } } }] },
  });
  assert.equal(out.errors.length, 0);
});

test("samme variant på to linjer summeres før sjekk", () => {
  const stock = { [LOC_A]: 4 };
  const out = run({ cart: { lines: [line(3, stock), line(2, stock)] } });
  assert.equal(out.errors.length, 1);
});

test("gavekort og andre ikke-varianter ignoreres", () => {
  const out = run({ cart: { lines: [{ quantity: 1, merchandise: { __typename: "CustomProduct" } }] } });
  assert.equal(out.errors.length, 0);
});

// Aldri over tollgrensen: bare lokasjoner i kundens land teller (18.11.2026).
const NO_A = "NO:gid://shopify/Location/1";
const DK_K = "DK:gid://shopify/Location/9";
const iLand = (land, lines) => ({ cart: { deliveryGroups: [{ deliveryAddress: { countryCode: land } }], lines } });

test("norsk kunde: dansk lager teller ikke", () => {
  const out = run(iLand("NO", [line(10, { [NO_A]: 4, [DK_K]: 30 })]));
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0].localizedMessage, /Prøv 4 eller færre/);
});

test("dansk kunde: bare danske butikker teller", () => {
  assert.equal(run(iLand("DK", [line(10, { [NO_A]: 4, [DK_K]: 30 })])).errors.length, 0);
  assert.equal(run(iLand("DK", [line(3, { [NO_A]: 40 })])).errors.length, 1);
});

test("nøkler uten land er norske (metafelt skrevet før 18.11.2026)", () => {
  assert.equal(maxSingleStoreQty({ value: JSON.stringify({ [LOC_A]: 5, [DK_K]: 30 }) }, "NO"), 5);
  assert.equal(maxSingleStoreQty({ value: JSON.stringify({ [LOC_A]: 5, [DK_K]: 30 }) }, "DK"), 30);
});

test("kundeland: leveringsadressen, ellers markedet, ellers Norge", () => {
  assert.equal(kundeland({ cart: { deliveryGroups: [{ deliveryAddress: { countryCode: "DK" } }] }, localization: { country: { isoCode: "NO" } } }), "DK");
  assert.equal(kundeland({ cart: { deliveryGroups: [{ deliveryAddress: null }] }, localization: { country: { isoCode: "DK" } } }), "DK");
  assert.equal(kundeland({ cart: {} }), "NO");
});
