import { assertEquals } from "jsr:@std/assert@1";
import { pendingForGroup, sellableQty } from "./inventory.ts";

Deno.test("sellableQty: trekker fra både buffer og ventende kassauttrekk", () => {
  assertEquals(sellableQty(20, 0, 0), 20);
  assertEquals(sellableQty(20, 2, 0), 18);
  assertEquals(sellableQty(20, 0, 10), 10);
  assertEquals(sellableQty(20, 2, 10), 8);
});

Deno.test("sellableQty: går aldri under null", () => {
  // Butikken slo ut ordren i kassa, men glemte knappen: kassa har falt OG vi trekker fra.
  // Da viser vi 0, ikke et negativt tall Shopify ville avvist.
  assertEquals(sellableQty(10, 0, 10), 0);
  assertEquals(sellableQty(5, 0, 10), 0);
  assertEquals(sellableQty(0, 3, 0), 0);
});

Deno.test("sellableQty: scenarioet fra spesifikasjonen", () => {
  // 20 i kassa, Garnly-ordre på 10 sendt uten at knappen er trykket: kassa står fortsatt 20.
  // Shopify har alt trukket ned on_hand ved fulfillment, så vi må skrive 10 – ikke 20.
  assertEquals(sellableQty(20, 0, 10), 10);
  // Knappen trykkes og kassa faller til 10. Ingenting venter lenger, og svaret er det samme.
  assertEquals(sellableQty(10, 0, 0), 10);
});

Deno.test("pendingForGroup: sendt først, så slått ut i kassa", () => {
  // Den vanligste rekkefølgen i butikk: pakk → lag sending → slå ut i kassa.
  // Feilen 30.09 (#1004) var at knappen ikke virket i mellomtilstanden.
  assertEquals(pendingForGroup(3, false, false), 0, "tildelt, ikke sendt: kassa teller dem, de står i butikken");
  assertEquals(pendingForGroup(3, true, false), 3, "sendt, ikke slått ut: kassa teller varer som er borte");
  assertEquals(pendingForGroup(3, true, true), 0, "sendt og slått ut: begge har trukket");
});

Deno.test("pendingForGroup: slått ut før sending legges tilbake", () => {
  // Butikken slår ofte ut ved plukk. Da har kassa trukket mens Shopify fortsatt holder
  // varene som committed – uten pluss-leddet ville de blitt trukket to ganger.
  assertEquals(pendingForGroup(3, false, true), -3);
});
