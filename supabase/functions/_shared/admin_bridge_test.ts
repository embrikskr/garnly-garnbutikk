import { assertEquals } from "jsr:@std/assert@1";
import { bridgeActor, constantTimeEqual } from "./admin_bridge.ts";

Deno.test("constantTimeEqual: like og ulike strenger", () => {
  assertEquals(constantTimeEqual("abc", "abc"), true);
  assertEquals(constantTimeEqual("abc", "abd"), false);
  assertEquals(constantTimeEqual("abc", "abcd"), false);
  assertEquals(constantTimeEqual("", ""), true);
});

Deno.test("bridgeActor: en vanlig bruker-JWT er ikke broen", () => {
  assertEquals(bridgeActor("eyJbruker", "eyJservice", "embrik@x.no"), { kind: "not_bridge" });
});

Deno.test("bridgeActor: uten nøkkel i miljøet slipper ingen gjennom", () => {
  assertEquals(bridgeActor("eyJservice", undefined, "embrik@x.no"), { kind: "not_bridge" });
  assertEquals(bridgeActor("", "", "embrik@x.no"), { kind: "not_bridge" });
});

Deno.test("bridgeActor: riktig nøkkel uten navn nektes", () => {
  assertEquals(bridgeActor("eyJservice", "eyJservice", null), { kind: "missing_actor" });
  assertEquals(bridgeActor("eyJservice", "eyJservice", "   "), { kind: "missing_actor" });
});

Deno.test("bridgeActor: riktig nøkkel med navn gir navnet merket med admin.garnly.no", () => {
  assertEquals(bridgeActor("eyJservice", "eyJservice", " embrik@x.no "), {
    kind: "ok",
    actor: "embrik@x.no (admin.garnly.no)",
  });
});
