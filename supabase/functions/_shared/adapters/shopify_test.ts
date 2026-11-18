import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { lagerRegel, ledigAntall, type NivaNode, tilLagerlinjer, velgLokasjon } from "./shopify.ts";

const lok = (id: string, name: string, isActive = true, fulfillsOnlineOrders = true) => ({ id, name, isActive, fulfillsOnlineOrders });

Deno.test("velgLokasjon: én aktiv nettlokasjon brukes", () => {
  assertEquals(velgLokasjon([lok("a", "Butik"), lok("b", "Lager", false)], null).id, "a");
});

Deno.test("velgLokasjon: flere aktive krever location_id, og den må finnes", () => {
  assertThrows(() => velgLokasjon([lok("a", "Butik"), lok("b", "Webshop")], null), Error, "pos_config.location_id");
  assertEquals(velgLokasjon([lok("a", "Butik"), lok("b", "Webshop")], "b").name, "Webshop");
  assertThrows(() => velgLokasjon([lok("a", "Butik")], "x"), Error, "finnes ikke");
  assertThrows(() => velgLokasjon([lok("a", "Butik", true, false)], null), Error, "ingen aktiv");
});

const node = (o: { qty?: number; tracked?: boolean; barcodes?: string[]; title?: string | null; sku?: string | null; item?: null }): NivaNode => ({
  quantities: [{ name: "available", quantity: o.qty ?? 5 }],
  item: o.item === null ? null : {
    id: "gid://shopify/InventoryItem/1",
    sku: o.sku === undefined ? " SKU1 " : o.sku,
    tracked: o.tracked ?? true,
    variants: {
      nodes: [{
        id: "gid://shopify/ProductVariant/987",
        title: o.title === undefined ? "1012 Hvid" : o.title,
        barcodes: { nodes: (o.barcodes ?? ["7039560799300"]).map((value) => ({ value })) },
        product: { title: "Ballerina Chunky Mohair", vendor: "Ballerina", status: "ACTIVE" },
      }],
    },
  },
});

Deno.test("tilLagerlinjer: strekkode, garn, farge og variant-id som alias-nøkkel", () => {
  assertEquals(tilLagerlinjer([node({})]), [{
    ean: "7039560799300",
    sku: "SKU1",
    name: "Ballerina Chunky Mohair 1012 Hvid",
    qty: 5,
    external_id: "v:987",
    yarn: "Ballerina Chunky Mohair",
    color: "1012 Hvid",
    brand: "Ballerina",
  }]);
});

Deno.test("tilLagerlinjer: første gyldige strekkode, negativt lager blir 0, uten variant ingen farge", () => {
  const [l] = tilLagerlinjer([node({ barcodes: ["abc", "07039560799300"], qty: -2, title: "Default Title", sku: null })]);
  assertEquals(l.ean, "7039560799300");
  assertEquals(l.qty, 0);
  assertEquals(l.color, null);
  assertEquals(l.name, "Ballerina Chunky Mohair");
  assertEquals(l.sku, null);
});

Deno.test("tilLagerlinjer: uten lagersporing eller uten vare hoppes over", () => {
  assertEquals(tilLagerlinjer([node({ tracked: false }), node({ item: null })]), []);
});

Deno.test("ledigAntall: CONTINUE står med fast antall, DENY følger lageret, begge med tak", () => {
  const regel = lagerRegel({ shop_domain: "x.myshopify.com", continue_selling_qty: 30, stock_cap: 30 });
  assertEquals(ledigAntall(0, "CONTINUE", regel), 30);
  assertEquals(ledigAntall(-4, "CONTINUE", regel), 30);
  assertEquals(ledigAntall(9999, "CONTINUE", regel), 30);
  assertEquals(ledigAntall(12, "DENY", regel), 12);
  assertEquals(ledigAntall(850, "DENY", regel), 30);
  assertEquals(ledigAntall(-2, "DENY", regel), 0);
});

Deno.test("ledigAntall: uten regel i pos_config brukes «available» som det er", () => {
  const regel = lagerRegel({ shop_domain: "x.myshopify.com" });
  assertEquals(regel, { fortsettAntall: null, maks: null });
  assertEquals(ledigAntall(0, "CONTINUE", regel), 0);
  assertEquals(ledigAntall(850, "DENY", regel), 850);
  assertEquals(lagerRegel({ stock_cap: "30", continue_selling_qty: -1 }), { fortsettAntall: null, maks: null });
});
