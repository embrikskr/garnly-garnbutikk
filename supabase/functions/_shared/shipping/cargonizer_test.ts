import { assertEquals } from "jsr:@std/assert@1";
import {
  type CargonizerConsignment,
  erPostNord,
  erSlettet,
  parseConsignments,
  parseErrors,
  parsePrintere,
  parseServicePartners,
  referanseVarianter,
  sokeord,
  sokFra,
  transferBeslutning,
  velgAlleConsignments,
  velgConsignment,
} from "./cargonizer.ts";

const c = (id: number, ref: string, state = "open"): CargonizerConsignment => ({
  id,
  consignorReference: ref,
  state,
  trackingUrl: null,
  transferAt: null,
  numberWithChecksum: null,
});

Deno.test("delstreng-treff forkastes – ellers går etiketten til feil kunde", () => {
  // Cargonizers søk treffer delstreng: text=1002 svarer også med 10021 og 21002.
  const svar = [c(1, "10021"), c(2, "21002"), c(3, "1002"), c(4, "TEST-1002")];
  assertEquals(velgConsignment(svar, "1002")?.id, 3);
});

Deno.test("ingen eksakt treff gir null, ikke en tilfeldig nabo", () => {
  assertEquals(velgConsignment([c(1, "10021"), c(2, "21002")], "1002"), null);
  assertEquals(velgConsignment([], "1002"), null);
});

Deno.test("mellomrom rundt referansen skal ikke avgjøre", () => {
  assertEquals(velgConsignment([c(7, " 1002 ")], "1002")?.id, 7);
  assertEquals(velgConsignment([c(7, "1002")], " 1002 ")?.id, 7);
});

Deno.test("tom referanse treffer ingenting", () => {
  // Uten denne ville en gruppe uten ordrenummer matchet en sending med tom referanse.
  assertEquals(velgConsignment([c(1, "")], ""), null);
  assertEquals(velgConsignment([c(1, "")], "   "), null);
});

Deno.test("laget om igjen: nyeste sending vinner", () => {
  const svar = [c(100, "1002"), c(205, "1002"), c(150, "1002")];
  assertEquals(velgConsignment(svar, "1002")?.id, 205);
});

Deno.test("parser leser id fra sendingen, ikke fra kolliene", () => {
  // Kolliene under <pieces> har egne id-er. En regex over hele svaret ville plukket feil tall.
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<consignments>
  <consignment>
    <id type="integer">76295361</id>
    <consignor-reference>TEST-1002</consignor-reference>
    <state>open</state>
    <transfer-at nil="true"/>
    <number-with-checksum>70727320392974462</number-with-checksum>
    <tracking-url>https://sporing.bring.no/sporing/LC879531631NO</tracking-url>
    <pieces>
      <piece>
        <id type="integer">99999999</id>
        <number-with-checksum>LC879531631NO</number-with-checksum>
      </piece>
    </pieces>
  </consignment>
</consignments>`;
  const r = parseConsignments(xml);
  assertEquals(r.length, 1);
  assertEquals(r[0].id, 76295361);
  assertEquals(r[0].consignorReference, "TEST-1002");
  assertEquals(r[0].state, "open");
  assertEquals(r[0].trackingUrl, "https://sporing.bring.no/sporing/LC879531631NO");
});

Deno.test("parser tåler flere sendinger og tomt svar", () => {
  const to = `<consignments>
    <consignment><id>1</id><consignor-reference>A</consignor-reference><state>open</state></consignment>
    <consignment><id>2</id><consignor-reference>B</consignor-reference><state>transferred</state></consignment>
  </consignments>`;
  assertEquals(parseConsignments(to).map((x) => x.id), [1, 2]);
  assertEquals(parseConsignments("<consignments/>"), []);
  assertEquals(parseConsignments("<consignments></consignments>"), []);
});

Deno.test("godtar både «#1002» og «1002» som avsenders referanse", () => {
  // Ikke bekreftet hva CargonizerConnect skriver. Begge godtas – fortsatt eksakt likhet.
  assertEquals(velgConsignment([c(1, "#1002")], referanseVarianter("#1002"))?.id, 1);
  assertEquals(velgConsignment([c(2, "1002")], referanseVarianter("#1002"))?.id, 2);
  // Men naboen slipper fortsatt ikke gjennom.
  assertEquals(velgConsignment([c(3, "21002")], referanseVarianter("#1002")), null);
});

Deno.test("søkeordet sendes uten firkant", () => {
  assertEquals(sokeord("#1002"), "1002");
  assertEquals(sokeord("1002"), "1002");
});

// ---------------------------------------------------------------- overføring

Deno.test("open skal overføres, transferred og closed skal ikke", () => {
  assertEquals(transferBeslutning({ state: "open", transferAt: null }).handling, "overfor");
  assertEquals(transferBeslutning({ state: "transferred", transferAt: null }).handling, "allerede");
  assertEquals(transferBeslutning({ state: "closed", transferAt: null }).handling, "allerede");
  // Store bokstaver og mellomrom skal ikke avgjøre om en pakke meldes inn to ganger.
  assertEquals(transferBeslutning({ state: " Transferred ", transferAt: null }).handling, "allerede");
});

Deno.test("transfer-at slår state: er tidspunktet satt, er sendingen meldt inn", () => {
  // Sett tidspunktet står, er EDI-en sendt uansett hva tilstanden heter. Overførte vi igjen,
  // ville transportøren fått samme pakke to ganger.
  const b = transferBeslutning({ state: "open", transferAt: "2026-09-30T19:10:00Z" });
  assertEquals(b.handling, "allerede");
  assertEquals(b.handling === "allerede" ? b.tidspunkt : null, "2026-09-30T19:10:00Z");
});

Deno.test("ukjent tilstand overføres ikke – vi gjetter ikke på Cargonizers vokabular", () => {
  // Tilstandene er ikke dokumentert. En vi aldri har sett kan like gjerne bety «under
  // overføring» som «avvist»; da er det bedre at et menneske ser på den.
  assertEquals(transferBeslutning({ state: "hva_nå", transferAt: null }).handling, "ukjent");
  assertEquals(transferBeslutning({ state: null, transferAt: null }).handling, "ukjent");
  assertEquals(transferBeslutning({ state: "", transferAt: null }).handling, "ukjent");
});

Deno.test("tomt transfer-at fra Cargonizer er ingen verdi", () => {
  // <transfer-at type="dateTime" nil="true"/> kommer ut av parseren som tom streng.
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
  <consignments><consignment>
    <id type="integer">76296163</id>
    <consignor-reference>#1004</consignor-reference>
    <state>open</state>
    <transfer-at type="dateTime" nil="true"/>
    <tracking-url nil="true"/>
  </consignment></consignments>`;
  const r = parseConsignments(xml);
  assertEquals(r[0].transferAt, null);
  assertEquals(r[0].trackingUrl, null);
  assertEquals(transferBeslutning(r[0]).handling, "overfor");
});

Deno.test("parseConsignments leser et satt transfer-at", () => {
  const xml = `<consignments><consignment><id>5</id><consignor-reference>#1004</consignor-reference>
    <state>transferred</state><transfer-at type="dateTime">2026-09-30T19:10:00Z</transfer-at></consignment></consignments>`;
  assertEquals(parseConsignments(xml)[0].transferAt, "2026-09-30T19:10:00Z");
});

Deno.test("feilmeldinger plukkes ut av <errors>", () => {
  // Ekte svar fra POST /consignments/transfer.xml med ukjent id (30.09.2026).
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
  <errors>
    <info><request-id>98862ddf</request-id></info>
    <error>Denne handlingen kunne ikke utføres på de markerte sendingene</error>
  </errors>`;
  assertEquals(parseErrors(xml), ["Denne handlingen kunne ikke utføres på de markerte sendingene"]);
});

Deno.test("flere feil, og svar uten feil", () => {
  assertEquals(parseErrors("<errors><error>A</error><error>B</error></errors>"), ["A", "B"]);
  assertEquals(parseErrors("<consignments/>"), []);
  assertEquals(parseErrors(""), []);
});

// ---------------------------------------------------------------- pakkebokser

Deno.test("pakkebokser leses i rekkefølge, nærmeste først", () => {
  // Ekte svar fra API-et 30.09.2026 for postnummer 7040.
  const xml = `<results>
    <errors></errors>
    <location><country>NO</country><postcode>7040</postcode><city>Trondheim</city></location>
    <service-partners>
      <service-partner>
        <number>6428833</number><customer-number/><name>Pakkeautomat Ladetorget</name>
        <address1>Østmarkveien 2</address1><address2/><postcode>7040</postcode>
        <city>TRONDHEIM</city><country>NO</country><distance unit="m">221</distance>
      </service-partner>
      <service-partner>
        <number>6423511</number><name>Pakkeautomat Kiwi Lilleby</name>
        <address1>Stjørdalsveien 2</address1><postcode>7066</postcode>
        <city>TRONDHEIM</city><country>NO</country><distance unit="m">1020</distance>
      </service-partner>
    </service-partners>
  </results>`;
  const r = parseServicePartners(xml);
  assertEquals(r.length, 2);
  assertEquals(r[0].number, "6428833");
  assertEquals(r[0].name, "Pakkeautomat Ladetorget");
  assertEquals(r[0].address1, "Østmarkveien 2");
  assertEquals(r[0].distanceM, 221);
  assertEquals(r[1].number, "6423511");
});

Deno.test("ingen pakkebokser gir tom liste, ikke krasj", () => {
  assertEquals(parseServicePartners("<results><service-partners/></results>"), []);
  assertEquals(parseServicePartners("<results/>"), []);
});

Deno.test("skriverlista tåler at kontoen ikke har noen", () => {
  // Ekte svar 30.09.2026 når det ikke finnes DirectPrint på kontoen.
  assertEquals(parsePrintere('<?xml version="1.0" encoding="UTF-8"?><nil-classes type="array"/>'), []);
  assertEquals(
    parsePrintere('<printers type="array"><printer><id>123</id><name>Zebra pakkebord</name></printer></printers>'),
    [{ id: "123", name: "Zebra pakkebord" }],
  );
});

// ---------------------------------------------------------------- manuelt sendt

Deno.test("PostNord kjennes igjen uansett skrivemåte", () => {
  // Vår egen flyt skriver «PostNord». CargonizerConnect og et menneske i Shopify-admin kan
  // skrive noe annet.
  assertEquals(erPostNord("PostNord"), true);
  assertEquals(erPostNord("Postnord"), true);
  assertEquals(erPostNord("PostNord Norge"), true);
  assertEquals(erPostNord("Post Nord"), true);
  assertEquals(erPostNord("PostNord MyPack"), true);
});

Deno.test("annet fraktselskap er ikke PostNord", () => {
  assertEquals(erPostNord("Bring"), false);
  assertEquals(erPostNord("Helthjem"), false);
  assertEquals(erPostNord("Posten"), false);
});

Deno.test("ukjent transportør er «vet ikke», ikke «annen transportør»", () => {
  // Null skal sende saken videre til oppslaget i Cargonizer. Behandlet vi den som «annen
  // transportør», ville en PostNord-sending uten trackingInfo.company aldri blitt overført.
  assertEquals(erPostNord(null), null);
  assertEquals(erPostNord(undefined), null);
  assertEquals(erPostNord(""), null);
  assertEquals(erPostNord("   "), null);
});

Deno.test("kansellering: ALLE sendinger med eksakt referanse, ikke bare den nyeste", () => {
  // Ble sendingen laget to ganger, skal begge bort når ordren kanselleres.
  const svar = [c(10, "#1010"), c(11, "#10101"), c(12, "1010"), c(13, "#1010")];
  assertEquals(velgAlleConsignments(svar, referanseVarianter("#1010")).map((x) => x.id), [10, 12, 13]);
  // Delstreng skal fortsatt aldri telle: #10101 er en annen kundes ordre.
  assertEquals(velgAlleConsignments([c(11, "#10101")], referanseVarianter("#1010")), []);
  assertEquals(velgAlleConsignments(svar, ""), []);
  // velgConsignment er fortsatt den nyeste av de samme.
  assertEquals(velgConsignment(svar, referanseVarianter("#1010"))?.id, 13);
});

Deno.test("slettet: ikke funnet, eller en tilstand som betyr borte", () => {
  assertEquals(erSlettet(null), true);
  assertEquals(erSlettet(c(1, "x", "deleted")), true);
  assertEquals(erSlettet(c(1, "x", "Cancelled")), true);
  assertEquals(erSlettet(c(1, "x", "open")), false);
  // Overført er IKKE slettet – da står den hos PostNord.
  assertEquals(erSlettet(c(1, "x", "transferred")), false);
  assertEquals(erSlettet(c(1, "x", "")), false);
});

Deno.test("sokFra: aldri bakover i tid, bare én dag for tidssonen", () => {
  // Ordrenummer gjentar seg: #1009 fra 10.09 og #1009 fra 04.10 er to ulike ordrer. Søket for
  // den nye skal ikke nå tilbake til den gamle.
  assertEquals(sokFra("2026-10-04T18:17:26Z").toISOString().slice(0, 10), "2026-10-03");
  assertEquals(sokFra("2026-10-04T00:30:00+02:00").toISOString().slice(0, 10), "2026-10-02");
});
