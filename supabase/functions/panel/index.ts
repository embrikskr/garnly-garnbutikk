/**
 * Serverer butikkpanelet (panel/) som statisk side.
 *
 * Panelet ligger på samme domene som API-et, så CORS mot offer-respond er triviell og
 * PANEL_ORIGIN peker hit. Filene er bakt inn av `deno task build-panel`; endrer du noe
 * i panel/, kjør den og deploy denne funksjonen på nytt.
 *
 * Ingen JWT-sjekk: dette er den offentlige innloggingssiden. All tilgang til data skjer
 * med brukerens eget token mot RLS-beskyttede views.
 */
import { ASSETS } from "./assets.ts";

// ArrayBuffer, ikke Uint8Array: gyldig BodyInit i alle lib-oppsett, og dekker binære
// filer (f.eks. en senere icon.png) like godt som tekstfilene vi har nå.
const cache = new Map<string, ArrayBuffer>();

function body(name: string): ArrayBuffer {
  const hit = cache.get(name);
  if (hit) return hit;
  const bin = Uint8Array.from(atob(ASSETS[name].b64), (c) => c.charCodeAt(0));
  const buf = bin.buffer as ArrayBuffer;
  cache.set(name, buf);
  return buf;
}

Deno.serve((req) => {
  const path = new URL(req.url).pathname.replace(/^\/panel\/?/, "");
  const name = path === "" ? "index.html" : path;
  const asset = ASSETS[name];
  if (!asset) return new Response("Ikke funnet", { status: 404 });
  return new Response(body(name), {
    headers: {
      "Content-Type": asset.type,
      // Panelet endrer seg sjelden, men skal ikke stå fast på en gammel versjon etter deploy.
      "Cache-Control": "public, max-age=300",
    },
  });
});
