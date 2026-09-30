import { assertEquals } from "jsr:@std/assert@1";
import { type CargonizerConsignment, parseConsignments, referanseVarianter, sokeord, velgConsignment } from "./cargonizer.ts";

const c = (id: number, ref: string, state = "open"): CargonizerConsignment => ({
  id,
  consignorReference: ref,
  state,
  trackingUrl: null,
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
