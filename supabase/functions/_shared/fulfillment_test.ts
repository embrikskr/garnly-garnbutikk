import { assertEquals } from "jsr:@std/assert@1";
import { type FulfillmentForMatch, type GroupForMatch, matchFulfillments } from "./fulfillment.ts";

const g = (id: string, loc: string | null, varianter: string[]): GroupForMatch => ({ id, location_id: loc, variant_ids: varianter });
const f = (id: string, createdAt: string, loc: string | null, varianter: string[]): FulfillmentForMatch => ({ id, createdAt, locationId: loc, variantIds: varianter });

const STRIKKEFRYD = "gid://shopify/Location/94717476924";
const GARNKILDEN = "gid://shopify/Location/94717509692";

Deno.test("én gruppe, én sending", () => {
  const r = matchFulfillments([g("G1", GARNKILDEN, ["v1"])], [f("F1", "2026-09-29T10:00:00Z", GARNKILDEN, ["v1"])]);
  assertEquals(r.get("G1"), "2026-09-29T10:00:00Z");
});

Deno.test("splittet ordre: hver butikk får sin egen sending, matchet på location", () => {
  const grupper = [g("G1", GARNKILDEN, ["v1"]), g("G2", STRIKKEFRYD, ["v2"])];
  const sendinger = [
    f("F2", "2026-09-29T12:00:00Z", STRIKKEFRYD, ["v2"]),
    f("F1", "2026-09-29T10:00:00Z", GARNKILDEN, ["v1"]),
  ];
  const r = matchFulfillments(grupper, sendinger);
  assertEquals(r.get("G1"), "2026-09-29T10:00:00Z");
  assertEquals(r.get("G2"), "2026-09-29T12:00:00Z");
});

Deno.test("to grupper hos samme butikk skilles på varianter", () => {
  const grupper = [g("G1", GARNKILDEN, ["v1"]), g("G2", GARNKILDEN, ["v2"])];
  const sendinger = [f("F1", "2026-09-29T10:00:00Z", GARNKILDEN, ["v2"])];
  const r = matchFulfillments(grupper, sendinger);
  assertEquals(r.has("G1"), false);
  assertEquals(r.get("G2"), "2026-09-29T10:00:00Z");
});

Deno.test("sending uten location faller tilbake på varianter", () => {
  const grupper = [g("G1", GARNKILDEN, ["v1"]), g("G2", STRIKKEFRYD, ["v2"])];
  const r = matchFulfillments(grupper, [f("F1", "2026-09-29T10:00:00Z", null, ["v2"])]);
  assertEquals(r.get("G2"), "2026-09-29T10:00:00Z");
  assertEquals(r.has("G1"), false);
});

Deno.test("ingenting å gå etter: gruppen står heller umerket enn feil merket", () => {
  // En feilmerket gruppe trekker fra lager for varer som ikke er sendt. Da er det bedre å
  // la backstoppen prøve igjen senere.
  const grupper = [g("G1", GARNKILDEN, ["v1"]), g("G2", GARNKILDEN, ["v2"])];
  const r = matchFulfillments(grupper, [f("F1", "2026-09-29T10:00:00Z", GARNKILDEN, ["v9"])]);
  assertEquals(r.size, 0);
});

Deno.test("én sending brukes bare på én gruppe", () => {
  const grupper = [g("G1", GARNKILDEN, ["v1"]), g("G2", GARNKILDEN, ["v1"])];
  const r = matchFulfillments(grupper, [f("F1", "2026-09-29T10:00:00Z", GARNKILDEN, ["v1"])]);
  assertEquals(r.size, 1);
});

Deno.test("eldste sending vinner når begge passer", () => {
  const r = matchFulfillments(
    [g("G1", GARNKILDEN, ["v1"])],
    [f("F2", "2026-09-29T15:00:00Z", GARNKILDEN, ["v1"]), f("F1", "2026-09-29T09:00:00Z", GARNKILDEN, ["v1"])],
  );
  assertEquals(r.get("G1"), "2026-09-29T09:00:00Z");
});
