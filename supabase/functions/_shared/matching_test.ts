import { assertEquals } from "jsr:@std/assert@1";
import { codeKey, colorCodeOf, foldKey, matchLines, splitYarnColor } from "./matching.ts";
import type { ProductRow, StockLine } from "./types.ts";

const P = (o: Partial<ProductRow>): ProductRow => ({
  id: o.id ?? "p", ean: null, sku: null, name: o.name ?? "x", brand: null, yarn_name: null, color_code: null, color_name: null,
  shopify_product_id: null, shopify_variant_id: null, shopify_inventory_item_id: null, active: true, exclude_from_sync: false, ...o,
});
const L = (o: Partial<StockLine>): StockLine => ({ ean: null, sku: null, name: null, qty: 1, ...o });

/** Hvilket produkt hver linje havnet på, og hvordan. «-» = umatchet. */
function utfall(lines: StockLine[], products: ProductRow[]) {
  const { matched } = matchLines(lines, products);
  return lines.map((l) => {
    const m = matched.find((x) => x.line === l);
    return m ? `${m.product.id}:${m.via}` : "-";
  });
}

Deno.test("garn+kode: Mystore-linje med garn og farge hver for seg, uten EAN", () => {
  // Strikkefryd: «Saga» har ingen EAN i Mystore, fargen ligger i opsjonen.
  const products = [
    P({ id: "saga111", name: "Saga – 111 Pumpkin", brand: "Filcolana", yarn_name: "Saga", color_code: "111" }),
    P({ id: "saga101", name: "Saga – 101 Natural White", brand: "Filcolana", yarn_name: "Saga", color_code: "101" }),
  ];
  const lines = [
    L({ name: "Saga 111 Gresskar", yarn: "Saga", color: "111 Gresskar", brand: "Farger Filcolana", external_id: "v:116301" }),
    L({ name: "Saga", yarn: "Saga", color: null, external_id: "v:9" }), // ingen farge: ingenting å koble på
  ];
  assertEquals(utfall(lines, products), ["saga111:garn+kode", "-"]);
});

Deno.test("garn+kode: Duell-navn med og uten bindestrek, salgsmerker og ledende nuller", () => {
  const products = [
    P({ id: "friz4", brand: "Lana Grossa", yarn_name: "Frizzante", color_code: "04" }),
    P({ id: "atlas", brand: "Sandnes Garn", yarn_name: "Atlas", color_code: "4246" }),
    P({ id: "smart", brand: "Sandnes Garn", yarn_name: "Smart", color_code: "9825" }),
    P({ id: "tline", brand: "Sandnes Garn", yarn_name: "Tynn Line", color_code: "9523" }),
    P({ id: "petit", brand: "Viking of Norway", yarn_name: "Trend Merino Petit", color_code: "371" }),
    P({ id: "silk", brand: "Isager", yarn_name: "Silk Mohair", color_code: "E0" }),
  ];
  const lines = [
    L({ name: "Frizzante - 4 Mokka", ean: "4033493000001" }),
    L({ name: "Atlas 4246 Cabernet", ean: "7020000000002" }),
    L({ name: "(Ut) Smart - 9825 (Utgått) 30%" }),
    L({ name: "Tynn Line - (Ut) 9523" }),
    L({ name: "Trend Merino Petit- 371" }),
    L({ name: "Isager Silk Mohair E0" }), // merket står foran garnnavnet i kassa
    L({ name: "Cashmere Classic 501" }), // Garnkilden: bare slutten av merket («Cardiff Cashmere»)
  ];
  products.push(P({ id: "cc501", brand: "Cardiff Cashmere", yarn_name: "Classic", color_code: "501" }));
  assertEquals(utfall(lines, products), [
    "friz4:garn+kode", "atlas:garn+kode", "smart:garn+kode", "tline:garn+kode", "petit:garn+kode", "silk:garn+kode", "cc501:garn+kode",
  ]);
});

Deno.test("garn+kode: aksenter og Rauma-koder i garnnavnet", () => {
  const products = [
    P({ id: "lett51", brand: "Ístex", yarn_name: "Léttlopi", color_code: "0051" }),
    P({ id: "finull", brand: "Rauma Garn", yarn_name: "Finull", color_code: "4124" }),
    P({ id: "pt5", brand: "Rauma Garn", yarn_name: "PT5", color_code: "501" }),
    P({ id: "lamull", brand: "Rauma Garn", yarn_name: "Lamull", color_code: "105" }),
  ];
  const lines = [
    L({ name: "Lettlopi 0051 White", yarn: "Lettlopi", color: "0051 White", brand: "Farger Istex" }),
    L({ name: "Finull PT2 4124 Lys grå", yarn: "Finull PT2", color: "4124 Lys grå", brand: "Farger Rauma" }),
    L({ name: "PT5 - 501" }), // «PT5» er garnets navn og skal ikke strippes
    L({ name: "Lamullgarn 105 Lavendel", yarn: "Lamullgarn", color: "105 Lavendel" }),
  ];
  assertEquals(utfall(lines, products), ["lett51:garn+kode", "finull:garn+kode", "pt5:garn+kode", "lamull:garn+kode"]);
});

Deno.test("garn+kode: et synonym brukes aldri når det eksakte garnnavnet finnes", () => {
  // «Babygarn» finnes. At koden mangler der, skal ikke sende linja videre til «Baby».
  const products = [
    P({ id: "babygarn1", yarn_name: "Babygarn", color_code: "1" }),
    P({ id: "baby2", yarn_name: "Baby", color_code: "2" }),
  ];
  assertEquals(utfall([L({ name: "Babygarn - 1" }), L({ name: "Babygarn - 2" })], products), ["babygarn1:garn+kode", "-"]);
});

Deno.test("garn+kode: to varianter med samme garn og kode → ingen kobling", () => {
  // Alva finnes hos både Filcolana og Solberg. Uten merke vet vi ikke hvilken.
  const products = [
    P({ id: "fil", brand: "Filcolana", yarn_name: "Alva", color_code: "2201" }),
    P({ id: "sol", brand: "Solberg Spinderi", yarn_name: "Alva", color_code: "2201" }),
  ];
  assertEquals(utfall([L({ name: "Alva - 2201" })], products), ["-"]);
});

Deno.test("garn+kode: merket fra kassa velger riktig produsent, og stopper feil", () => {
  const products = [
    P({ id: "fil", brand: "Filcolana", yarn_name: "Alva", color_code: "2201" }),
    P({ id: "sol", brand: "Solberg Spinderi", yarn_name: "Alva", color_code: "2201" }),
    P({ id: "fil9", brand: "Filcolana", yarn_name: "Alva", color_code: "9" }),
  ];
  const lines = [
    L({ yarn: "Alva", color: "2201 Lys", brand: "Farger Solberg Spinderi" }),
    // Solberg-farge 9 finnes bare som Filcolana: merket sier nei, selv om garn og kode passer.
    L({ yarn: "Alva", color: "9 Sort", brand: "Farger Solberg Spinderi" }),
    // Ukjent merke (leverandøren, ikke produsenten) ignoreres.
    L({ name: "Alva - 9", brand: "Villy Jensen" }),
  ];
  assertEquals(utfall(lines, products), ["sol:garn+kode", "-", "fil9:garn+kode"]);
});

Deno.test("garn+kode: ulik EAN hos butikk og Shopify → ingen kobling; EAN bare hos butikken → kobles", () => {
  const products = [
    P({ id: "a", ean: "7020000000101", yarn_name: "Peer Gynt", color_code: "3509" }),
    P({ id: "b", ean: null, yarn_name: "Peer Gynt", color_code: "4213" }),
  ];
  const lines = [
    L({ name: "Peer Gynt - 3509", ean: "7020000000999" }),
    L({ name: "Peer Gynt - 4213", ean: "7020000000888" }),
  ];
  assertEquals(utfall(lines, products), ["-", "b:garn+kode"]);
});

Deno.test("garn+kode: farge uten kode kobles ikke på fargenavn", () => {
  const products = [P({ id: "a3", brand: "Isager", yarn_name: "Alpaca 3", color_code: null, color_name: "Sky" })];
  assertEquals(utfall([L({ name: "Alpaca 3 - Sky" })], products), ["-"]);
});

Deno.test("garn+kode kommer sist: EAN, SKU og navn vinner", () => {
  const products = [
    P({ id: "e", ean: "7020000000019", yarn_name: "Sunday", color_code: "1001" }),
    P({ id: "k", yarn_name: "Sunday", color_code: "1002" }),
    P({ id: "n", name: "Sunday – 1003 Kitt", yarn_name: "Sunday", color_code: "1004" }),
  ];
  const lines = [
    L({ ean: "7020000000019", name: "Sunday - 1002" }),
    L({ name: "Sunday 1003 Kitt" }),
    L({ name: "Sunday - 1002" }),
  ];
  assertEquals(utfall(lines, products), ["e:ean", "n:navn", "k:garn+kode"]);
});

Deno.test("hjelpere: foldKey, codeKey, splitYarnColor, colorCodeOf", () => {
  assertEquals(foldKey("Léttlopi"), foldKey("Lettlopi"));
  assertEquals(foldKey("Børstet Alpakka"), "børstetalpakka");
  assertEquals(codeKey("0488"), "488");
  assertEquals(codeKey("000"), "0");
  assertEquals(codeKey("E0"), "e0");
  assertEquals(splitYarnColor({ name: "3-tråds Strikkegarn - 149 Mørk blå" }), { yarn: "3-tråds Strikkegarn", color: "149 Mørk blå" });
  assertEquals(splitYarnColor({ name: "Alpakka (Utgått)  40% - 4008" }), { yarn: "Alpakka", color: "4008" });
  assertEquals(splitYarnColor({ name: "Tvinni 50g - 0" }), { yarn: "Tvinni", color: "0" });
  assertEquals(splitYarnColor({ name: "Saga" }), null);
  assertEquals(colorCodeOf("Blue 5812"), "5812");
  assertEquals(colorCodeOf("3818 (Rabatt  40%"), "3818");
  assertEquals(colorCodeOf("Sky"), null);
});
