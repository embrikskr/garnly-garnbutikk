import { assertEquals } from "jsr:@std/assert@1";
import { assignEans, staleEanHolders } from "./ean.ts";

const v = (id: string, ean: string | null, active = true) => ({ shopify_variant_id: id, ean, active });

Deno.test("assignEans: unike EAN-er står urørt", () => {
  const rows = [v("a", "1"), v("b", "2"), v("c", null)];
  const r = assignEans(rows);
  assertEquals(r.rows, rows);
  assertEquals(r.duplicates, []);
});

Deno.test("assignEans: aktiv variant vinner over utkastet (Finull (2) → Finull)", () => {
  const r = assignEans([v("finull2-459", "7045840004507", false), v("finull-459", "7045840004507", true)]);
  assertEquals(r.rows.map((x) => x.ean), [null, "7045840004507"]);
  assertEquals(r.duplicates, [{ ean: "7045840004507", kept: "finull-459", dropped: ["finull2-459"] }]);
});

Deno.test("assignEans: like aktive – den første beholder EAN-en", () => {
  const r = assignEans([v("a", "1"), v("b", "1"), v("c", "1", false)]);
  assertEquals(r.rows.map((x) => x.ean), ["1", null, null]);
  assertEquals(r.duplicates, [{ ean: "1", kept: "a", dropped: ["b", "c"] }]);
});

Deno.test("staleEanHolders: raden som har EAN-en fra før mister den når en annen variant eier den nå", () => {
  const existing = [
    { id: "p1", ean: "1", shopify_variant_id: "gammel" },
    { id: "p2", ean: "2", shopify_variant_id: "b" },
    { id: "p3", ean: "9", shopify_variant_id: "borte" },
    { id: "p4", ean: null, shopify_variant_id: "c" },
  ];
  assertEquals(staleEanHolders(existing, [v("ny", "1"), v("b", "2"), v("c", null)]), ["p1"]);
});

Deno.test("staleEanHolders: to varianter som bytter EAN frigjør begge", () => {
  const existing = [{ id: "p1", ean: "1", shopify_variant_id: "a" }, { id: "p2", ean: "2", shopify_variant_id: "b" }];
  assertEquals(staleEanHolders(existing, [v("a", "2"), v("b", "1")]), ["p1", "p2"]);
});
