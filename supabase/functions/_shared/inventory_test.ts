import { assertEquals } from "jsr:@std/assert@1";
import { sellableQty } from "./inventory.ts";

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
