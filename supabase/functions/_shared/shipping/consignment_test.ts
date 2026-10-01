import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  byggConsignmentXml,
  EMBALLASJE_GRAM,
  escapeXml,
  FALLBACK_VARE_GRAM,
  gramFraShopify,
  innholdstekst,
  maksVektKg,
  mobilnummer,
  produkterForVekt,
  sporingsnummer,
  vektKg,
} from "./consignment.ts";

Deno.test("vekt: Shopifys vekt brukes når den finnes", () => {
  // 2 × 50 g + 1 × 120 g + emballasje
  const gram = 2 * 50 + 120 + EMBALLASJE_GRAM;
  assertEquals(vektKg([{ qty: 2, grams: 50 }, { qty: 1, grams: 120 }]), Math.ceil(gram / 10) / 100);
});

Deno.test("vekt: uten vekt i Shopify brukes fallback per vare", () => {
  const gram = 3 * FALLBACK_VARE_GRAM + EMBALLASJE_GRAM;
  assertEquals(vektKg([{ qty: 3, grams: null }]), Math.ceil(gram / 10) / 100);
  assertEquals(vektKg([{ qty: 3 }]), Math.ceil(gram / 10) / 100);
  // 0 gram i Shopify betyr «ikke satt», ikke at nøstet er vektløst.
  assertEquals(vektKg([{ qty: 3, grams: 0 }]), Math.ceil(gram / 10) / 100);
});

Deno.test("vekt: rundes opp, aldri ned", () => {
  // En sending som veier litt mer enn oppgitt kan bli avvist i innleveringen. Motsatt vei
  // koster ingenting.
  // 150 g emballasje + 1 g = 151 g → 0,16 kg, ikke 0,15.
  assertEquals(vektKg([{ qty: 1, grams: 1 }]), 0.16);
  // 150 + 55 = 205 g → 0,21 kg.
  assertEquals(vektKg([{ qty: 1, grams: 55 }]), 0.21);
});

Deno.test("sporingsnummer tas fra sporingslenken", () => {
  // Ekte tall fra #1004: lenken har et annet tall enn sendingsnummeret, og det er lenkens
  // tall PostNord søker på.
  assertEquals(
    sporingsnummer("https://my.postnord.no/tracking/70727320855841324", "40170727320855841324"),
    "70727320855841324",
  );
});

Deno.test("sporingsnummer faller tilbake på sendingsnummeret", () => {
  assertEquals(sporingsnummer(null, "40170727320855841324"), "40170727320855841324");
  // En lenke uten tall på slutten skal ikke gi «sporing» på et ord.
  assertEquals(sporingsnummer("https://sporing.example/no/track", "123456789"), "123456789");
  assertEquals(sporingsnummer(null, null), null);
});

Deno.test("mobilnummer: mellomrom bort, landkode beholdes", () => {
  assertEquals(mobilnummer("+47 953 31 315"), "+4795331315");
  assertEquals(mobilnummer("95331315"), "95331315");
  assertEquals(mobilnummer("953-31-315"), "95331315");
  assertEquals(mobilnummer(null), null);
  assertEquals(mobilnummer("ring meg"), null);
  assertEquals(mobilnummer(""), null);
});

Deno.test("XML escapes, ellers svarer Cargonizer 500 på «Bull & Co»", () => {
  assertEquals(escapeXml(`Bull & Co <"'>`), "Bull &amp; Co &lt;&quot;&apos;&gt;");
});

Deno.test("innholdstekst kuttes, og tåler tomme linjer", () => {
  assertEquals(innholdstekst([{ qty: 2, title: "Alpakka Ull" }]), "2 × Alpakka Ull");
  assertEquals(innholdstekst([]), "Garn");
  const lang = innholdstekst([{ qty: 1, title: "x".repeat(200) }]);
  assertEquals(lang.length, 100);
});

const grunnlag = {
  transportAgreementId: "37187",
  product: "postnord_mypack_small",
  reference: "#1004",
  consignee: {
    name: "Embrik Skrindo",
    address1: "Lade alle 42f",
    address2: null,
    postcode: "7040",
    city: "Trondheim",
    country: "NO",
    email: "kunde@example.no",
    mobile: "+4795331315",
  },
  servicePartner: {
    number: "6428833",
    name: "Pakkeautomat Ladetorget",
    address1: "Østmarkveien 2",
    postcode: "7040",
    city: "TRONDHEIM",
    country: "NO",
  },
  vektKg: 0.25,
  innhold: "1 × Alpakka Ull",
  services: ["postnord_notification_sms"],
};

Deno.test("XML-en har det produktet krever", () => {
  const xml = byggConsignmentXml({ ...grunnlag, transfer: true });
  assertStringIncludes(xml, '<consignment transport_agreement="37187"');
  assertStringIncludes(xml, "<product>postnord_mypack_small</product>");
  assertStringIncludes(xml, "<transfer>true</transfer>");
  assertStringIncludes(xml, "<number>6428833</number>");
  assertStringIncludes(xml, "<mobile>+4795331315</mobile>");
  assertStringIncludes(xml, '<service id="postnord_notification_sms" />');
  assertStringIncludes(xml, "<consignor>#1004</consignor>");
  // Nøyaktig ett kolli: produktet tillater bare ett (max_items 1).
  assertEquals(xml.split("<item ").length - 1, 1);
  assertStringIncludes(xml, 'weight="0.25"');
});

Deno.test("testordre: transfer=false, så ingenting går til PostNord", () => {
  const xml = byggConsignmentXml({ ...grunnlag, transfer: false });
  assertStringIncludes(xml, "<transfer>false</transfer>");
  assertEquals(xml.includes("<transfer>true</transfer>"), false);
});

Deno.test("navn med & blir escapet i XML-en", () => {
  const xml = byggConsignmentXml({
    ...grunnlag,
    transfer: false,
    consignee: { ...grunnlag.consignee, name: "Bull & Co" },
  });
  assertStringIncludes(xml, "<name>Bull &amp; Co</name>");
});

Deno.test("uten pakkeboks utelates service_partner helt", () => {
  const xml = byggConsignmentXml({ ...grunnlag, transfer: false, servicePartner: null });
  assertEquals(xml.includes("service_partner"), false);
});

Deno.test("vekt fra Shopify regnes om til gram", () => {
  assertEquals(gramFraShopify(50, "GRAMS"), 50);
  assertEquals(gramFraShopify(1.2, "KILOGRAMS"), 1200);
  assertEquals(gramFraShopify(2, "POUNDS"), 907);
  assertEquals(gramFraShopify(4, "OUNCES"), 113);
  // 0 og tomt betyr «ikke satt», ikke vektløs.
  assertEquals(gramFraShopify(0, "GRAMS"), null);
  assertEquals(gramFraShopify(null, "GRAMS"), null);
  assertEquals(gramFraShopify(50, "STEIN"), null);
});

Deno.test("vektgrenser per produkt, slik Cargonizer håndhever dem", () => {
  // Funnet via /consignment_costs.xml 01.10.2026: 10,00 godtatt / 10,01 avvist for
  // pakkeboks, 35,00 godtatt / 35,01 avvist for hentested, for begge butikkenes avtaler.
  assertEquals(maksVektKg("postnord_mypack_small"), 10);
  assertEquals(maksVektKg("mypack"), 35);
  assertEquals(maksVektKg("noe_annet"), null);
});

const BEGGE = ["postnord_mypack_small", "mypack"];

Deno.test("lett pakke: pakkeboks først, hentested som reserve", () => {
  assertEquals(produkterForVekt(0.4, BEGGE), BEGGE);
  assertEquals(produkterForVekt(10, BEGGE), BEGGE);
});

Deno.test("over 10 kg: rett til hentested, selv om det finnes pakkeboks i nærheten", () => {
  // Pakkeboksen må ut av lista FØR vi leter etter pakkested. Ellers finner vi en boks som
  // ikke tar pakken, og stopper.
  assertEquals(produkterForVekt(10.01, BEGGE), ["mypack"]);
  assertEquals(produkterForVekt(15, BEGGE), ["mypack"]);
  assertEquals(produkterForVekt(35, BEGGE), ["mypack"]);
});

Deno.test("over 35 kg: ingen PostNord-produkt tar den", () => {
  assertEquals(produkterForVekt(35.01, BEGGE), []);
  assertEquals(produkterForVekt(50, BEGGE), []);
});

Deno.test("uten reserve: bare pakkeboks, og over 10 kg tar ingen den", () => {
  assertEquals(produkterForVekt(5, ["postnord_mypack_small"]), ["postnord_mypack_small"]);
  assertEquals(produkterForVekt(12, ["postnord_mypack_small"]), []);
});

Deno.test("ukjent produkt slipper gjennom – vi gjetter ikke på en grense", () => {
  assertEquals(produkterForVekt(80, ["bring2_business_parcel"]), ["bring2_business_parcel"]);
});
