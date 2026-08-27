import { assertEquals } from "jsr:@std/assert@1";
import { deadlineWithinBusinessHours, planGroups } from "./routing.ts";
import { matchLines, normName } from "./matching.ts";
import type { LineItem, ProductRow } from "./types.ts";

const li = (id: string, product: string, qty = 1): LineItem => ({ line_item_id: id, variant_id: "v" + id, product_id: product, qty, title: product });

Deno.test("én butikk har alt → én gruppe, kandidater i fordelingsrekkefølge", () => {
  const lines = [li("1", "A", 3), li("2", "B", 1)];
  const cov = [
    { store_id: "s1", product_id: "A" }, { store_id: "s1", product_id: "B" },
    { store_id: "s2", product_id: "A" }, { store_id: "s2", product_id: "B" },
    { store_id: "s3", product_id: "A" },
  ];
  const r = planGroups(lines, cov, ["s2", "s1", "s3"]);
  assertEquals(r.groups.length, 1);
  assertEquals(r.groups[0].candidates, ["s2", "s1"]);
  assertEquals(r.uncovered, []);
});

Deno.test("ingen har alt → splitt i færrest mulig grupper", () => {
  const lines = [li("1", "A"), li("2", "B"), li("3", "C")];
  const cov = [
    { store_id: "s1", product_id: "A" }, { store_id: "s1", product_id: "B" },
    { store_id: "s2", product_id: "C" },
    { store_id: "s3", product_id: "B" },
  ];
  const r = planGroups(lines, cov, ["s3", "s1", "s2"]);
  assertEquals(r.groups.length, 2);
  assertEquals(r.groups[0].line_items.map((l) => l.product_id), ["A", "B"]);
  assertEquals(r.groups[0].candidates, ["s1"]);
  assertEquals(r.groups[1].line_items.map((l) => l.product_id), ["C"]);
  assertEquals(r.groups[1].candidates, ["s2"]);
  assertEquals(r.uncovered, []);
});

Deno.test("linje ingen dekker → uncovered", () => {
  const lines = [li("1", "A"), li("2", "Z")];
  const cov = [{ store_id: "s1", product_id: "A" }];
  const r = planGroups(lines, cov, ["s1"]);
  assertEquals(r.groups.length, 1);
  assertEquals(r.uncovered.map((l) => l.product_id), ["Z"]);
});

Deno.test("grådig velger butikken med flest linjer, ikke første i rekkefølgen", () => {
  const lines = [li("1", "A"), li("2", "B"), li("3", "C")];
  const cov = [
    { store_id: "s1", product_id: "A" },
    { store_id: "s2", product_id: "A" }, { store_id: "s2", product_id: "B" }, { store_id: "s2", product_id: "C" },
  ];
  // s2 dekker alt → trinn 1
  const r = planGroups(lines, cov, ["s1", "s2"]);
  assertEquals(r.groups.length, 1);
  assertEquals(r.groups[0].candidates, ["s2"]);
});

const HOURS = { mon: ["10:00", "17:00"], tue: ["10:00", "17:00"], wed: ["10:00", "17:00"], thu: ["10:00", "17:00"], fri: ["10:00", "17:00"], sat: ["10:00", "15:00"], sun: null } as Record<string, [string, string] | null>;

Deno.test("frist innenfor samme dag", () => {
  // Torsdag 27. aug 2026 kl 11:00 Oslo (UTC+2) = 09:00Z
  const from = new Date("2026-08-27T09:00:00Z");
  const d = deadlineWithinBusinessHours(from, 3, HOURS);
  assertEquals(d.toISOString(), "2026-08-27T12:00:00.000Z"); // 14:00 Oslo
});

Deno.test("frist ruller over stengetid til neste dag", () => {
  // Torsdag 16:00 Oslo, 3 t frist: 1 t igjen i dag, 2 t fredag fra 10:00 → 12:00 Oslo = 10:00Z
  const from = new Date("2026-08-27T14:00:00Z");
  const d = deadlineWithinBusinessHours(from, 3, HOURS);
  assertEquals(d.toISOString(), "2026-08-28T10:00:00.000Z");
});

Deno.test("frist hopper over søndag", () => {
  // Lørdag 14:30 Oslo, 3 t: 0,5 t igjen lørdag, resten mandag 10:00 + 2,5 t = 12:30 Oslo = 10:30Z
  const from = new Date("2026-08-29T12:30:00Z");
  const d = deadlineWithinBusinessHours(from, 3, HOURS);
  assertEquals(d.toISOString(), "2026-08-31T10:30:00.000Z");
});

Deno.test("tilbud utenfor åpningstid starter ved åpning", () => {
  // Torsdag 22:00 Oslo → fredag 10:00 + 3 t = 13:00 Oslo = 11:00Z
  const from = new Date("2026-08-27T20:00:00Z");
  const d = deadlineWithinBusinessHours(from, 3, HOURS);
  assertEquals(d.toISOString(), "2026-08-28T11:00:00.000Z");
});

const P = (o: Partial<ProductRow>): ProductRow => ({
  id: o.id ?? "p", ean: null, sku: null, name: o.name ?? "x", brand: null, yarn_name: null, color_code: null, color_name: null,
  shopify_product_id: null, shopify_variant_id: null, shopify_inventory_item_id: null, active: true, ...o,
});

Deno.test("matching: EAN først, så SKU, så navn", () => {
  const products = [
    P({ id: "1", ean: "7020000000019", name: "Sandnes Garn Lun Merino – Hvit" }),
    P({ id: "2", sku: "SG-1001", name: "Dale Garn Alpakka – Storm Blue" }),
    P({ id: "3", name: "Filcolana Peruvian – Cream", brand: "Filcolana", yarn_name: "Peruvian", color_name: "Cream" }),
  ];
  const { matched, unmatched } = matchLines([
    { ean: "7020000000019", sku: "X", name: "noe annet", qty: 5 },
    { ean: null, sku: "sg-1001", name: null, qty: 2 },
    { ean: null, sku: null, name: "FILCOLANA  Peruvian - Cream", qty: 1 },
    { ean: "9999999999999", sku: null, name: "Ukjent", qty: 1 },
  ], products);
  assertEquals(matched.map((m) => m.product.id), ["1", "2", "3"]);
  assertEquals(unmatched.length, 1);
});

Deno.test("normName", () => {
  assertEquals(normName("Lun Merino – Hvit"), "lun merino hvit");
  assertEquals(normName("  Alpakka  Følgetråd - Storm Blue!"), "alpakka følgetråd storm blue");
});
