import { assertEquals } from "jsr:@std/assert@1";
import { borProveIgjen } from "./types.ts";

Deno.test("nytt forsøk bare der det kan hjelpe", () => {
  // Mystore svarte 504 på første produktside 30.09 og 01.10. Neste kjøring gikk fint –
  // det er deres server som bruker for lang tid, ikke noe hos oss.
  assertEquals(borProveIgjen(504), true);
  assertEquals(borProveIgjen(500), true);
  assertEquals(borProveIgjen(502), true);
  assertEquals(borProveIgjen(429), true);
  // 4xx blir ikke bedre av å spørre igjen: 401 er feil nøkkel, 400 er feil spørring.
  assertEquals(borProveIgjen(400), false);
  assertEquals(borProveIgjen(401), false);
  assertEquals(borProveIgjen(404), false);
  assertEquals(borProveIgjen(200), false);
});
