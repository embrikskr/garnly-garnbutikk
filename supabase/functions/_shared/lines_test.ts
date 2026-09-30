import { assertEquals } from "jsr:@std/assert@1";
import { bildeUrl, byggLinje, erGarnpakke, kitLinjer, type ShopifyLinjeNode, variantTittel } from "./lines.ts";

Deno.test("«Default Title» er en plassholder, ikke et variantnavn", () => {
  assertEquals(variantTittel("Default Title"), null);
  assertEquals(variantTittel("8581 Dyp skoggrønn"), "8581 Dyp skoggrønn");
  assertEquals(variantTittel("  XS  "), "XS");
  assertEquals(variantTittel(null), null);
  assertEquals(variantTittel(""), null);
});

Deno.test("garnpakke kjennes igjen på productType eller tag, ikke på navn", () => {
  assertEquals(erGarnpakke({ productType: "Garnpakke", tags: [] }), true);
  assertEquals(erGarnpakke({ productType: "garnpakke", tags: null }), true);
  assertEquals(erGarnpakke({ productType: "Garn", tags: ["nyhet", "GARNPAKKE"] }), true);
  assertEquals(erGarnpakke({ productType: "Garn", tags: ["garnpakke-kampanje"] }), false);
  // Navnet skal aldri avgjøre: ved butikkflyttingen fikk produktene nye navn, og et unntak
  // basert på navnemønster sluttet stilltiende å virke.
  assertEquals(erGarnpakke({ productType: "Garn", tags: [] }), false);
  assertEquals(erGarnpakke(null), false);
});

Deno.test("garnpakkeinnhold: én garnsort per linje", () => {
  const felt = "Rauma Lun Merino – Hvit: 12–16 nøster etter størrelse\r\n\nSandnes Alpakka Følgetråd – Marzipan: 3–5 nøster";
  assertEquals(kitLinjer(felt), [
    "Rauma Lun Merino – Hvit: 12–16 nøster etter størrelse",
    "Sandnes Alpakka Følgetråd – Marzipan: 3–5 nøster",
  ]);
  assertEquals(kitLinjer(null), []);
  assertEquals(kitLinjer("   "), []);
  assertEquals(kitLinjer("a\nb\nc", 2), ["a", "b"]);
});

Deno.test("variantbildet vinner over produktbildet", () => {
  assertEquals(bildeUrl({ id: "v", image: { url: "variant.jpg" }, product: { featuredImage: { url: "produkt.jpg" } } }), "variant.jpg");
  assertEquals(bildeUrl({ id: "v", image: null, product: { featuredImage: { url: "produkt.jpg" } } }), "produkt.jpg");
  assertEquals(bildeUrl({ id: "v", image: null, product: { featuredImage: null } }), null);
  assertEquals(bildeUrl(null), null);
});

const node = (variant: ShopifyLinjeNode["lineItem"]["variant"]): ShopifyLinjeNode => ({
  id: "gid://shopify/FulfillmentOrderLineItem/1",
  remainingQuantity: 2,
  lineItem: { title: "Merinoull", variant },
});

Deno.test("linja får alt butikken trenger for å plukke", () => {
  // Ekte data fra #1005.
  const l = byggLinje(
    node({
      id: "gid://shopify/ProductVariant/50557445668924",
      title: "8581 Dyp skoggrønn",
      sku: " 7039560690720 ",
      barcode: "7039560690720",
      image: { url: "https://cdn.shopify.com/noste.jpg" },
      product: { productType: "Garn", tags: [], featuredImage: { url: "https://cdn.shopify.com/produkt.jpg" }, metafield: null },
    }),
    "ae22f947-5c28-48b0-bb59-a1d321149b3f",
    85,
    0,
  );
  assertEquals(l.title, "Merinoull");
  assertEquals(l.variant_title, "8581 Dyp skoggrønn");
  assertEquals(l.sku, "7039560690720");
  assertEquals(l.barcode, "7039560690720");
  assertEquals(l.image_url, "https://cdn.shopify.com/noste.jpg");
  assertEquals(l.qty, 2);
  assertEquals(l.amount_inc_vat, 85);
  assertEquals("kit_contents" in l, false);
});

Deno.test("garnpakke får innholdet med, vanlig garn får det ikke", () => {
  const pakke = byggLinje(
    node({
      id: "gid://shopify/ProductVariant/1",
      title: "M",
      sku: null,
      barcode: null,
      image: null,
      product: {
        productType: "Garnpakke",
        tags: ["garnpakke"],
        featuredImage: { url: "pakke.jpg" },
        metafield: { value: "Regia 4-ply – Grey Purple: 1 nøste (100 g)\nRegia 4-ply – Denim Mix: 1 nøste (100 g)" },
      },
    }),
    "p1",
    0,
    0,
  );
  // Variantene er størrelser, så det finnes verken strekkode eller variantbilde.
  assertEquals(pakke.variant_title, "M");
  assertEquals(pakke.barcode, null);
  assertEquals(pakke.image_url, "pakke.jpg");
  assertEquals(pakke.kit_contents, [
    "Regia 4-ply – Grey Purple: 1 nøste (100 g)",
    "Regia 4-ply – Denim Mix: 1 nøste (100 g)",
  ]);

  // Samme metafelt på et produkt som IKKE er garnpakke skal ikke vises som pakkeinnhold.
  const garn = byggLinje(
    node({
      id: "gid://shopify/ProductVariant/2", title: "Hvit", sku: null, barcode: "123", image: null,
      product: { productType: "Garn", tags: [], featuredImage: null, metafield: { value: "noe rart" } },
    }),
    "p2", 0, 0,
  );
  assertEquals("kit_contents" in garn, false);
});

Deno.test("tomme strenger fra Shopify blir null, ikke tomme felt i panelet", () => {
  const l = byggLinje(
    node({ id: "v", title: "Default Title", sku: "  ", barcode: "", image: null, product: null }),
    "p", 0, 0,
  );
  assertEquals(l.variant_title, null);
  assertEquals(l.sku, null);
  assertEquals(l.barcode, null);
  assertEquals(l.image_url, null);
});
