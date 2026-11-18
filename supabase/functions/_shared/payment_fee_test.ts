import { assertEquals } from "jsr:@std/assert@1";
import { type FeeTransaction, gebyrFraTransaksjoner } from "./payment_fee.ts";

const sp = (kind: string, status: string, fees: string[] | null, valuta = "NOK"): FeeTransaction => ({
  kind,
  status,
  gateway: "shopify_payments",
  fees: fees === null ? null : fees.map((a) => ({ amount: { amount: a, currencyCode: valuta } })),
});

Deno.test("gebyr: #1019 – én betaling, 21,99 kr", () => {
  assertEquals(gebyrFraTransaksjoner([sp("SALE", "SUCCESS", ["21.99"])]), { kind: "kjent", ore: 2199 });
});

Deno.test("gebyr: #1033 – refusjonen etterpå endrer ikke gebyret", () => {
  const t = [sp("SALE", "SUCCESS", ["35.45"]), sp("REFUND", "SUCCESS", [])];
  assertEquals(gebyrFraTransaksjoner(t), { kind: "kjent", ore: 3545 });
});

Deno.test("gebyr: «27.0» fra Shopify er 27,00 kr", () => {
  assertEquals(gebyrFraTransaksjoner([sp("SALE", "SUCCESS", ["27.0"])]), { kind: "kjent", ore: 2700 });
});

Deno.test("gebyr: flere gebyrlinjer og flere betalinger summeres", () => {
  const t = [sp("CAPTURE", "SUCCESS", ["10.10", "0.25"]), sp("SALE", "SUCCESS", ["5.05"])];
  assertEquals(gebyrFraTransaksjoner(t), { kind: "kjent", ore: 1540 });
});

Deno.test("gebyr: reservasjon uten trekk er ikke betalt", () => {
  assertEquals(gebyrFraTransaksjoner([sp("AUTHORIZATION", "SUCCESS", [])]).kind, "vent");
});

Deno.test("gebyr: mislykket betaling teller ikke", () => {
  const t = [sp("SALE", "FAILURE", ["9.99"]), sp("SALE", "SUCCESS", ["13.48"])];
  assertEquals(gebyrFraTransaksjoner(t), { kind: "kjent", ore: 1348 });
});

Deno.test("gebyr: betalt, men gebyret er ikke ført ennå – vent", () => {
  assertEquals(gebyrFraTransaksjoner([sp("SALE", "SUCCESS", [])]).kind, "vent");
  assertEquals(gebyrFraTransaksjoner([sp("SALE", "SUCCESS", null)]).kind, "vent");
});

Deno.test("gebyr: ingen transaksjoner – vent", () => {
  assertEquals(gebyrFraTransaksjoner([]).kind, "vent");
});

Deno.test("gebyr: gavekort har ikke gebyr", () => {
  const gavekort: FeeTransaction = { kind: "SALE", status: "SUCCESS", gateway: "gift_card", fees: [] };
  assertEquals(gebyrFraTransaksjoner([gavekort]), { kind: "kjent", ore: 0 });
  assertEquals(gebyrFraTransaksjoner([gavekort, sp("SALE", "SUCCESS", ["8.40"])]), { kind: "kjent", ore: 840 });
});

Deno.test("gebyr: annen betalingsmåte må legges inn for hånd", () => {
  const annen: FeeTransaction = { kind: "SALE", status: "SUCCESS", gateway: "manual", fees: [] };
  assertEquals(gebyrFraTransaksjoner([annen]).kind, "manuelt");
});

Deno.test("gebyr: annen valuta enn ordrens må legges inn for hånd", () => {
  assertEquals(gebyrFraTransaksjoner([sp("SALE", "SUCCESS", ["3.10"], "EUR")]).kind, "manuelt");
});
