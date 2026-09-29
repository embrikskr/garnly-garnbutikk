import { assertEquals } from "jsr:@std/assert@1";
import { erTestordre } from "./testorder.ts";

Deno.test("tag TEST kjennes igjen uansett skrivemåte", () => {
  assertEquals(erTestordre(["TEST"]), true);
  assertEquals(erTestordre(["test"]), true);
  assertEquals(erTestordre([" Test "]), true);
  assertEquals(erTestordre(["garnly-test"]), true);
  assertEquals(erTestordre(["kampanje", "TEST"]), true);
});

Deno.test("Shopifys eget test-flagg holder alene", () => {
  // Fanger testbetalinger ingen husket å merke med tag.
  assertEquals(erTestordre([], true), true);
  assertEquals(erTestordre(null, true), true);
});

Deno.test("ekte ordrer telles som salg", () => {
  assertEquals(erTestordre([]), false);
  assertEquals(erTestordre(null), false);
  assertEquals(erTestordre(undefined), false);
  assertEquals(erTestordre(["julegave", "gave"]), false);
  assertEquals(erTestordre(["kampanje"], false), false);
});

Deno.test("tag som bare inneholder ordet test er ikke en testordre", () => {
  // «testgarn» og «Bestilt til testing» er produktinformasjon, ikke et testmerke.
  // Ville vi matchet på delstreng, ville ekte salg falt ut av oppgjøret.
  assertEquals(erTestordre(["testgarn"]), false);
  assertEquals(erTestordre(["protest"]), false);
  assertEquals(erTestordre(["Bestilt til testing"]), false);
});
