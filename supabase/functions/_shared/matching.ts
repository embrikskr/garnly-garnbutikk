import type { ProductRow, StockLine } from "./types.ts";

export type MatchVia = "ean" | "alias" | "sku" | "navn" | "garn+kode";

/**
 * Matching: 1) EAN, 2) alias (product_aliases: kassesystemets id → produkt), 3) SKU, 4) navn (normalisert),
 * 5) garnnavn + fargekode (se matchYarnCode).
 * `aliases` er external_id → product.id for butikken som synkes.
 */
export function matchLines(lines: StockLine[], products: ProductRow[], aliases: Map<string, string> = new Map()) {
  const byEan = new Map<string, ProductRow>();
  const bySku = new Map<string, ProductRow>();
  const byName = new Map<string, ProductRow>();
  const byId = new Map<string, ProductRow>();
  for (const p of products) {
    byId.set(p.id, p);
    if (p.ean) byEan.set(p.ean, p);
    if (p.sku) bySku.set(p.sku.toLowerCase(), p);
    byName.set(normName(p.name), p);
    if (p.brand && p.yarn_name && p.color_name) byName.set(normName(`${p.brand} ${p.yarn_name} ${p.color_name}`), p);
  }
  const byYarnCode = yarnCodeIndex(products);
  const brands = [...new Set(products.map((p) => p.brand ? foldKey(p.brand) : "").filter(Boolean))];
  const matched: Array<{ product: ProductRow; line: StockLine; via: MatchVia }> = [];
  const unmatched: StockLine[] = [];
  for (const line of lines) {
    const aliasId = line.external_id ? aliases.get(line.external_id) : undefined;
    let p: ProductRow | null | undefined;
    let via: MatchVia = "ean";
    if (line.ean && (p = byEan.get(line.ean))) via = "ean";
    else if (aliasId && (p = byId.get(aliasId))) via = "alias";
    else if (line.sku && (p = bySku.get(line.sku.toLowerCase()))) via = "sku";
    else if (line.name && (p = byName.get(normName(line.name)))) via = "navn";
    else if ((p = matchYarnCode(line, byYarnCode, brands))) via = "garn+kode";
    if (p) matched.push({ product: p, line, via });
    else unmatched.push(line);
  }
  return { matched, unmatched };
}

export function normName(s: string): string {
  return s.toLowerCase().replace(/[–—-]/g, " ").replace(/[^a-z0-9æøå ]/g, "").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------- garnnavn + fargekode
//
// For butikkvarer uten EAN, og for farger der Shopify mangler EAN (09.10.2026). Strikkefryd har
// hele garnlinjer uten EAN i Mystore (Saga, Tilia, Pernilla …), og Garnkildens Duell-navn er
// «Frizzante - 04 Mokka». Begge har garnnavn og fargekode, og det har varianten i Shopify også
// (yarn_name + color_code fra «Farge»-opsjonen). Fargenavnet brukes ikke: det skrives ulikt
// («Natural White» / «Naturhvit»), koden gjør ikke det.
//
// Sikkerhet foran treff: steget kobler bare når NØYAKTIG én variant har garnnavnet og koden,
// og aldri mot en variant med en annen EAN enn butikkens. Oppgir kassa et merke vi kjenner
// («Farger Solberg Spinderi»), kobles linja bare til det merket: Alva finnes både hos Filcolana
// og Solberg. Alt annet blir stående umatchet.

type YarnCodeIndex = Map<string, Map<string, ProductRow[]>>;

/** Garnnavn til sammenligning: små bokstaver, uten aksenter («Léttlopi» = «Lettlopi»), bare bokstaver og tall. */
export function foldKey(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[^a-z0-9æø]/g, "");
}

/** Fargekode til sammenligning: «0488» = «488», «E0» = «e0». */
export function codeKey(s: string): string {
  const k = s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const uten = k.replace(/^0+/, "");
  return uten === "" && k !== "" ? "0" : uten;
}

/** Fjerner salgsmerker fra kassanavn: «(Ut)», «(Utgått) 30%», «(Rabatt 20%», «50g». */
function rensKassanavn(s: string): string {
  return s.replace(/\d+\s*%/g, " ").replace(/\([^)]*\)?/g, " ").replace(/\s+\d+\s*g\b/gi, " ").replace(/\s+/g, " ").trim()
    .replace(/[\s–-]+$/, "").trim();
}

/**
 * Garnnavn og farge fra en kasselinje. Adapteren kan gi dem direkte (Mystore: produkt + fargeopsjon);
 * ellers leses de av navnet: «Garn - farge» eller «Garn 1234 Farge».
 */
export function splitYarnColor(line: Pick<StockLine, "name" | "yarn" | "color">): { yarn: string; color: string } | null {
  if (line.yarn && line.color) return { yarn: rensKassanavn(line.yarn), color: line.color };
  const navn = line.name?.trim();
  if (!navn) return null;
  const skille = navn.match(/\s*[–-]\s+/);
  if (skille && skille.index! > 0) {
    return { yarn: rensKassanavn(navn.slice(0, skille.index)), color: navn.slice(skille.index! + skille[0].length) };
  }
  const ord = navn.split(/\s+/);
  const i = ord.findIndex((o, n) => n > 0 && /\d/.test(o));
  if (i <= 0) return null;
  return { yarn: rensKassanavn(ord.slice(0, i).join(" ")), color: ord.slice(i).join(" ") };
}

/** Første ord med et siffer i fargen: «111 Pumpkin» → «111», «Blue 5812» → «5812», «Sky» → null. */
export function colorCodeOf(color: string): string | null {
  const ord = rensKassanavn(color).split(/\s+/).find((o) => /\d/.test(o));
  return ord ? codeKey(ord) : null;
}

/**
 * Nøkler å slå opp garnet på, i rekkefølge. Bare den første som finnes blant Garnlys garn
 * brukes, så et synonym aldri overstyrer et eksakt treff.
 *  - «Finull PT2» → «Finull» (Rauma-koden etter navnet; «PT5» alene er garnets navn og står)
 *  - «Lamullgarn» → «Lamull»
 */
function yarnKeys(yarn: string): string[] {
  const keys = [foldKey(yarn)];
  const utenPt = yarn.replace(/\s+pt\s*\d+$/i, "");
  if (utenPt !== yarn) keys.push(foldKey(utenPt));
  const utenGarn = foldKey(yarn).replace(/garn$/, "");
  if (utenGarn.length >= 4 && utenGarn !== keys[0]) keys.push(utenGarn);
  return keys.filter((k) => k.length > 0);
}

function yarnCodeIndex(products: ProductRow[]): YarnCodeIndex {
  const idx: YarnCodeIndex = new Map();
  const add = (k: string, code: string, p: ProductRow) => {
    if (!k) return;
    let m = idx.get(k);
    if (!m) idx.set(k, m = new Map());
    const list = m.get(code) ?? [];
    if (!list.includes(p)) list.push(p);
    m.set(code, list);
  };
  for (const p of products) {
    if (!p.yarn_name || !p.color_code) continue;
    const code = codeKey(p.color_code);
    if (!code) continue;
    add(foldKey(p.yarn_name), code, p);
    // «Isager Tweed», «Lana Grossa Basta», «Cardiff Cashmere Classic»: merket står foran i kassa,
    // av og til bare slutten av det (Garnkilden: «Cashmere Classic 501» for Cardiff Cashmere Classic).
    const ord = (p.brand ?? "").split(/\s+/).filter(Boolean);
    for (let i = 0; i < ord.length; i++) add(foldKey(`${ord.slice(i).join(" ")} ${p.yarn_name}`), code, p);
  }
  return idx;
}

/** Er merket fra kassa det samme som produktets? «Rauma» = «Rauma Garn», «Istex» = «Ístex». */
function sammeMerke(a: string, b: string): boolean {
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/** Merket kassa oppgir, hvis det er et merke Garnly har: «Farger Filcolana» → «filcolana». Ellers null. */
export function brandHint(brand: string | null | undefined, kjente: string[]): string | null {
  if (!brand) return null;
  const k = foldKey(brand.replace(/^\s*farger?\s+/i, ""));
  return k && kjente.some((b) => sammeMerke(k, b)) ? k : null;
}

function matchYarnCode(line: StockLine, idx: YarnCodeIndex, kjenteMerker: string[]): ProductRow | null {
  const delt = splitYarnColor(line);
  if (!delt) return null;
  const code = colorCodeOf(delt.color);
  if (!code) return null;
  const merke = brandHint(line.brand, kjenteMerker);
  for (const k of yarnKeys(delt.yarn)) {
    const koder = idx.get(k);
    if (!koder) continue;
    const kandidater = (koder.get(code) ?? []).filter((p) => !merke || (p.brand && sammeMerke(merke, foldKey(p.brand))));
    if (kandidater.length !== 1) return null; // ingen, eller flere varianter med samme garn og kode
    const p = kandidater[0];
    if (line.ean && p.ean && line.ean !== p.ean) return null; // to ulike EAN: feil i dataene, ikke gjett
    return p;
  }
  return null;
}
