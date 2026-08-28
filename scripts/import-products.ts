/**
 * import-products: bygger Garnly-sortimentet fra butikkenes kassesystemer (Duell/Mystore).
 * Dagens Shopify-produkter skal IKKE brukes; katalogen hentes fra butikkene, kureres, og
 * opprettes i Shopify med EAN og lagersporing på plass fra start.
 *
 * Modus 1 – hent og slå sammen (standard):
 *   deno task import-products
 *   Henter produktlister fra Duell og/eller Mystore (styrt av hvilke env som er satt),
 *   slår sammen på EAN (samme strekkode = samme vare) og skriver kurerings-CSV:
 *     behold;ean;navn;pris;merke;duell_antall;mystore_antall;sku
 *   Sett x i behold og fyll pris (og gjerne merke) for varene Garnly skal selge.
 *
 * Modus 2 – opprett i Shopify:
 *   deno task import-products -- --create kurert.csv
 *   Oppretter radene med behold=x som DRAFT-produkter i Shopify med barcode (EAN) og
 *   inventoryItem.tracked=true. Varer som allerede finnes (samme strekkode) hoppes over.
 *   Publisering (DRAFT → ACTIVE) gjøres i Shopify admin etter en siste sjekk.
 *   Mutasjonen productSet er validert mot Admin API 2025-07-skjemaet.
 *
 * Env modus 1 (den/de som er satt hentes):
 *   DUELL_CLIENT_NUMBER, DUELL_CLIENT_TOKEN, DUELL_DEPARTMENT
 *   MYSTORE_SHOP, MYSTORE_TOKEN
 * Env modus 2: SHOPIFY_SHOP, SHOPIFY_ADMIN_TOKEN
 * Valgfritt: --out <fil> for CSV-navn (standard produktimport.csv)
 */
import { duellAdapter } from "../supabase/functions/_shared/adapters/duell.ts";
import { mystoreAdapter } from "../supabase/functions/_shared/adapters/mystore.ts";
import { normalizeEan } from "../supabase/functions/_shared/adapters/types.ts";
import { gql, iterateVariants } from "../supabase/functions/_shared/shopify.ts";
import type { StockLine, StoreRow } from "../supabase/functions/_shared/types.ts";

const createPath = argAfter("--create");
if (createPath) await createInShopify(createPath);
else await fetchAndMerge(argAfter("--out") ?? "produktimport.csv");

function argAfter(flag: string): string | null {
  const i = Deno.args.indexOf(flag);
  return i >= 0 && Deno.args[i + 1] ? Deno.args[i + 1] : null;
}

// ---------------------------------------------------------------------------
// Modus 1: hent fra kassesystemene og slå sammen på EAN
// ---------------------------------------------------------------------------
interface MergedRow {
  ean: string;
  name: string | null;
  sku: string | null;
  qty: Record<string, number>;
}

/** Adapterne bruker bare name og pos_config; resten av StoreRow er irrelevant for et engangs-uttrekk. */
function stubStore(name: string, posConfig: Record<string, unknown>): StoreRow {
  return { name, pos_config: posConfig } as unknown as StoreRow;
}

async function fetchAndMerge(outPath: string) {
  const sources: Array<{ key: string; lines: StockLine[] }> = [];

  if (Deno.env.get("DUELL_CLIENT_NUMBER")) {
    console.log("Henter fra Duell …");
    const lines = await duellAdapter.fetchStock(
      stubStore("Duell", { department: Deno.env.get("DUELL_DEPARTMENT") ?? "" }),
      { client_number: Deno.env.get("DUELL_CLIENT_NUMBER")!, client_token: Deno.env.get("DUELL_CLIENT_TOKEN") ?? "" },
    );
    sources.push({ key: "duell", lines });
    console.log(`  ${lines.length} rader`);
  }
  if (Deno.env.get("MYSTORE_SHOP")) {
    console.log("Henter fra Mystore …");
    const lines = await mystoreAdapter.fetchStock(
      stubStore("Mystore", { shop: Deno.env.get("MYSTORE_SHOP") }),
      { token: Deno.env.get("MYSTORE_TOKEN") ?? "" },
    );
    sources.push({ key: "mystore", lines });
    console.log(`  ${lines.length} rader`);
  }
  if (sources.length === 0) {
    console.error("Ingen kilder: sett DUELL_CLIENT_NUMBER/DUELL_CLIENT_TOKEN/DUELL_DEPARTMENT og/eller MYSTORE_SHOP/MYSTORE_TOKEN");
    Deno.exit(1);
  }

  const byEan = new Map<string, MergedRow>();
  let withoutEan = 0;
  for (const { key, lines } of sources) {
    for (const line of lines) {
      if (!line.ean) {
        withoutEan++;
        continue;
      }
      const row = byEan.get(line.ean) ?? { ean: line.ean, name: null, sku: null, qty: {} };
      row.name ??= line.name;
      row.sku ??= line.sku;
      row.qty[key] = (row.qty[key] ?? 0) + line.qty;
      byEan.set(line.ean, row);
    }
  }

  const rows = [...byEan.values()].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", "no"));
  const inBoth = rows.filter((r) => Object.keys(r.qty).length > 1).length;
  const header = ["behold", "ean", "navn", "pris", "merke", "duell_antall", "mystore_antall", "sku"];
  const csv = [header.join(";")];
  for (const r of rows) {
    csv.push(["", r.ean, esc(r.name ?? ""), "", "", r.qty.duell ?? "", r.qty.mystore ?? "", esc(r.sku ?? "")].join(";"));
  }
  await Deno.writeTextFile(outPath, csv.join("\n") + "\n");

  console.log(`\nSkrev ${rows.length} unike varer til ${outPath} (${inBoth} finnes i begge butikker, ${withoutEan} rader uten EAN hoppet over).`);
  console.log("Neste: åpne filen i Excel/Numbers, sett x i behold-kolonnen og fyll pris for varene Garnly skal selge,");
  console.log("og kjør deretter:  deno task import-products -- --create " + outPath);
}

function esc(v: string): string {
  return /[;"\n]/.test(v) ? '"' + v.replaceAll('"', '""') + '"' : v;
}

// ---------------------------------------------------------------------------
// Modus 2: opprett kurerte varer i Shopify (DRAFT, med barcode + sporing)
// ---------------------------------------------------------------------------
const CREATE = `mutation CreateProduct($input: ProductSetInput!) {
  productSet(input: $input, synchronous: true) { product { id } userErrors { field message } } }`;

async function createInShopify(path: string) {
  const lines = (await Deno.readTextFile(path)).split(/\r?\n/).filter((l) => l.trim());
  const header = lines[0].split(";").map((h) => h.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name);
  const iKeep = idx("behold"), iEan = idx("ean"), iName = idx("navn"), iPrice = idx("pris"), iBrand = idx("merke"), iSku = idx("sku");
  if (iKeep < 0 || iEan < 0 || iName < 0 || iPrice < 0) {
    console.error("CSV-en mangler kolonnene behold/ean/navn/pris (bruk filen fra modus 1)");
    Deno.exit(1);
  }

  const wanted: Array<{ ean: string; name: string; price: string; brand: string; sku: string }> = [];
  for (const line of lines.slice(1)) {
    const c = splitCsvLine(line);
    if (!c[iKeep]?.trim()) continue;
    const ean = normalizeEan(c[iEan]);
    const name = c[iName]?.trim();
    const price = c[iPrice]?.trim().replace(",", ".");
    if (!ean || !name) { console.warn(`Hopper over rad uten gyldig EAN/navn: ${line.slice(0, 80)}`); continue; }
    if (!price || !Number.isFinite(Number(price))) { console.warn(`Mangler pris for «${name}» – hopper over`); continue; }
    wanted.push({ ean, name, price, brand: c[iBrand]?.trim() ?? "", sku: c[iSku]?.trim() ?? "" });
  }
  console.log(`${wanted.length} varer med behold=x og gyldig pris.`);
  if (wanted.length === 0) Deno.exit(0);

  console.log("Sjekker hvilke strekkoder som allerede finnes i Shopify …");
  const existing = new Set<string>();
  for await (const v of iterateVariants()) {
    const e = normalizeEan(v.barcode);
    if (e) existing.add(e);
  }

  let created = 0, skipped = 0, failed = 0;
  for (const w of wanted) {
    if (existing.has(w.ean)) { skipped++; continue; }
    const res = await gql(CREATE, {
      input: {
        title: w.name,
        vendor: w.brand || undefined,
        status: "DRAFT",
        productOptions: [{ name: "Title", values: [{ name: "Default Title" }] }],
        variants: [{
          optionValues: [{ optionName: "Title", name: "Default Title" }],
          barcode: w.ean,
          price: w.price,
          sku: w.sku || undefined,
          inventoryItem: { tracked: true },
        }],
      },
    });
    const errs = res.productSet?.userErrors ?? [];
    if (errs.length) {
      failed++;
      console.error(`FEIL «${w.name}»: ` + errs.map((e: { message: string }) => e.message).join("; "));
    } else {
      created++;
      if (created % 25 === 0) console.log(`  ${created} opprettet …`);
    }
  }
  console.log(`\nFerdig: ${created} opprettet som DRAFT, ${skipped} fantes fra før (samme strekkode), ${failed} feilet.`);
  console.log("Gå gjennom utkastene i Shopify admin (bilder, beskrivelser), sett dem ACTIVE, og kjør sync-products.");
}

/** Enkel CSV-splitt med støtte for "..."-siterte felter (samme dialekt som esc() skriver). */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ";") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
