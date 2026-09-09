/**
 * Pakker butikkpanelet (panel/) inn i en Edge Function.
 *
 * Supabase Storage serverer HTML som text/plain av sikkerhetsgrunner, så panelet kan ikke
 * ligge der. Funksjonen serverer filene med riktig content-type fra samme domene som API-et,
 * som også gjør CORS mot offer-respond triviell.
 *
 * Kjør `deno task build-panel` etter endringer i panel/, og deploy funksjonen på nytt.
 */
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const FILES = ["index.html", "app.js", "config.js", "style.css", "manifest.json"];
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/manifest+json",
};

const entries: string[] = [];
for (const name of FILES) {
  const bytes = await Deno.readFile(`panel/${name}`);
  const ext = name.slice(name.lastIndexOf("."));
  entries.push(`  ${JSON.stringify(name)}: { type: ${JSON.stringify(TYPES[ext])}, b64: ${JSON.stringify(encodeBase64(bytes))} },`);
  console.log(`${name.padEnd(14)} ${String(bytes.length).padStart(6)} B`);
}

const out = `// GENERERT AV scripts/build-panel.ts – IKKE REDIGER FOR HÅND.
// Kilden er panel/. Kjør \`deno task build-panel\` og deploy panel-funksjonen på nytt.
export const ASSETS: Record<string, { type: string; b64: string }> = {
${entries.join("\n")}
};
`;
await Deno.writeTextFile("supabase/functions/panel/assets.ts", out);
console.log(`\nSkrevet supabase/functions/panel/assets.ts (${FILES.length} filer)`);
