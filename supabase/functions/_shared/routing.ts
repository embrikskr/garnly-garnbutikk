/**
 * Ren rutinglogikk uten I/O, så den kan testes.
 * Regler (Byggeplan §8.2):
 *   1. Ufravikelig: hele antallet av én varelinje fra samme butikk.
 *   2. Foretrukket: hele ordren fra én butikk.
 *   3. Reserve: del linjene i færrest mulig grupper (grådig).
 */
import type { LineItem } from "./types.ts";

export interface Coverage {
  store_id: string;
  product_id: string;
}

export interface Group {
  line_items: LineItem[];
  /** Butikker som kan levere hele gruppen, i prioritert rekkefølge (fra qualified-sortering) */
  candidates: string[];
}

/**
 * @param lines      varelinjene i ordren
 * @param coverage   (store, product)-par der butikken har >= qty av produktet
 * @param storeOrder alle aktive butikker i fordelingsrekkefølge (eldst last_assigned_at først)
 */
export function planGroups(lines: LineItem[], coverage: Coverage[], storeOrder: string[]): { groups: Group[]; uncovered: LineItem[] } {
  const byStore = new Map<string, Set<string>>();
  for (const c of coverage) {
    if (!byStore.has(c.store_id)) byStore.set(c.store_id, new Set());
    byStore.get(c.store_id)!.add(c.product_id);
  }
  const rank = new Map(storeOrder.map((s, i) => [s, i]));
  const sortStores = (ids: string[]) => [...ids].sort((a, b) => (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9));

  const storesCovering = (items: LineItem[]) =>
    sortStores([...byStore.entries()].filter(([, set]) => items.every((li) => set.has(li.product_id))).map(([id]) => id));

  // Trinn 1: én butikk har alt
  const full = storesCovering(lines);
  if (full.length > 0) return { groups: [{ line_items: lines, candidates: full }], uncovered: [] };

  // Trinn 2: grådig – velg butikken som dekker flest gjenværende linjer, gjenta
  let remaining = [...lines];
  const groups: Group[] = [];
  while (remaining.length > 0) {
    let best: { store: string; items: LineItem[] } | null = null;
    for (const store of sortStores([...byStore.keys()])) {
      const set = byStore.get(store)!;
      const items = remaining.filter((li) => set.has(li.product_id));
      if (items.length > 0 && (!best || items.length > best.items.length)) best = { store, items };
    }
    if (!best) break; // ingen dekker noe av resten
    const candidates = storesCovering(best.items);
    groups.push({ line_items: best.items, candidates });
    const taken = new Set(best.items.map((i) => i.line_item_id));
    remaining = remaining.filter((li) => !taken.has(li.line_item_id));
  }
  return { groups, uncovered: remaining };
}

/**
 * Frist i åpningstid. business_hours: {"mon":["10:00","17:00"], "sun":null}
 * Tidssone: Europe/Oslo. Returnerer tidspunktet fristen utløper.
 */
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export function deadlineWithinBusinessHours(
  from: Date,
  ttlHours: number,
  hours: Record<string, [string, string] | null>,
  tz = "Europe/Oslo",
): Date {
  let remainingMs = ttlHours * 3600 * 1000;
  let t = new Date(from);
  for (let guard = 0; guard < 14 * 24 * 4 && remainingMs > 0; guard++) {
    const local = toLocal(t, tz);
    const spec = hours[DAYS[local.weekday]];
    if (!spec) { t = nextDayStart(t, tz); continue; }
    const [open, close] = spec.map(parseHm);
    const nowMin = local.hour * 60 + local.minute;
    if (nowMin < open) { t = atLocalTime(t, open, tz); continue; }
    if (nowMin >= close) { t = nextDayStart(t, tz); continue; }
    const untilCloseMs = (close - nowMin) * 60 * 1000 - local.second * 1000;
    if (remainingMs <= untilCloseMs) return new Date(t.getTime() + remainingMs);
    remainingMs -= untilCloseMs;
    t = nextDayStart(t, tz);
  }
  return new Date(t.getTime() + Math.max(0, remainingMs));
}

function parseHm(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + (m || 0);
}

function toLocal(d: Date, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false, weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { weekday: wd, hour: Number(get("hour")) % 24, minute: Number(get("minute")), second: Number(get("second")), y: Number(get("year")), m: Number(get("month")), d: Number(get("day")) };
}

/** Samme lokale dato, gitt klokkeslett (minutter fra midnatt) */
function atLocalTime(d: Date, minutes: number, tz: string): Date {
  const l = toLocal(d, tz);
  return localToUtc(l.y, l.m, l.d, Math.floor(minutes / 60), minutes % 60, tz);
}

function nextDayStart(d: Date, tz: string): Date {
  const l = toLocal(d, tz);
  const next = new Date(Date.UTC(l.y, l.m - 1, l.d + 1, 0, 0, 0));
  return localToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, tz);
}

/** Konverterer lokal veggklokke i tz til UTC (iterativ korreksjon for offset). */
function localToUtc(y: number, m: number, d: number, h: number, min: number, tz: string): Date {
  let guess = new Date(Date.UTC(y, m - 1, d, h, min, 0));
  for (let i = 0; i < 3; i++) {
    const l = toLocal(guess, tz);
    const diffMin = (l.y - y) * 525600 + (l.m - m) * 43800 + (l.d - d) * 1440 + (l.hour - h) * 60 + (l.minute - min);
    if (diffMin === 0) break;
    guess = new Date(guess.getTime() - diffMin * 60000);
  }
  return guess;
}
