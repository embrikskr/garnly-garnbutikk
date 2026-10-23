import { assertEquals } from "jsr:@std/assert@1";
import { goneVariantRows } from "./variants.ts";

Deno.test("goneVariantRows: aktive rader uten variant i Shopify deaktiveres", () => {
  const existing = [
    { id: "a", shopify_variant_id: "v1", active: true },
    { id: "b", shopify_variant_id: "v2", active: true }, // slettet i Shopify
    { id: "c", shopify_variant_id: "v3", active: false }, // alt inaktiv
    { id: "d", shopify_variant_id: null, active: true }, // ingen variant-id: rør ikke
  ];
  assertEquals(goneVariantRows(existing, ["v1"]), ["b"]);
});

Deno.test("goneVariantRows: alt sett – ingenting å gjøre", () => {
  assertEquals(goneVariantRows([{ id: "a", shopify_variant_id: "v1", active: true }], new Set(["v1"])), []);
});
