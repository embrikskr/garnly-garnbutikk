/**
 * Ren logikk for NÅR en butikk skal synkes. Ingen I/O, så den kan testes.
 *
 * Cron fyrer hvert 5. minutt og spør hvilke butikker som er «due». To ting avgjøres her:
 *
 * 1. **Nattintervall.** Butikkene er stengt om natten og kassene står stille, så mellom
 *    22 og 08 lokal tid synkes det sjeldnere (standard hver time i stedet for hvert 15. min).
 *    `nightIntervalMin: 0` slår av nattsynken helt.
 *
 * 2. **Grace.** `last_sync_at` settes når synken *starter*, men aldri presis på cron-tikket:
 *    pg_net-utsending og oppstart tar noen sekunder, og butikkene synkes sekvensielt i samme
 *    kall, så butikk nummer to får stempelet sitt etter at butikk nummer én er ferdig.
 *
 *    Uten slakk havner 15-minutters-merket dermed *etter* tikket, butikken må vente på det
 *    neste, og 15 minutter blir 20 i praksis. Verifisert 27.09.2026: målt 20,0 min med
 *    `SYNC_INTERVAL_MIN = 15`.
 *
 *    Vi trekker derfor `graceMin` fra terskelen. Butikken blir due litt før merket og fanges
 *    av tikket som ligger på det. Minste faktiske avstand blir `interval - graceMin`, altså
 *    13 min for et intervall på 15. Slakken må være romsligere enn forsinkelsen på stempelet;
 *    2 min dekker en treg butikk foran i køen (Strikkefryd bruker ~130 s).
 *
 * Tidssone er Europe/Oslo, ikke UTC: «22 til 08» er veggklokka i butikken, og sommertid
 * flytter det en time to ganger i året. pg_cron kjører i UTC og kan ikke uttrykke det, så
 * vinduet avgjøres her og ikke i cron-uttrykket.
 */

export interface SyncSchedule {
  /** Minutter mellom synker på dagtid. */
  dayIntervalMin: number;
  /** Minutter mellom synker om natten. 0 = ikke synk om natten. */
  nightIntervalMin: number;
  /** Natten starter denne lokale timen (22 = 22:00). */
  nightFromHour: number;
  /** Natten slutter denne lokale timen (8 = 08:00). */
  nightToHour: number;
  /** Slakk i minutter, se punkt 2 over. */
  graceMin: number;
}

export const DEFAULT_SYNC_SCHEDULE: SyncSchedule = {
  dayIntervalMin: 15,
  nightIntervalMin: 60,
  nightFromHour: 22,
  nightToHour: 8,
  graceMin: 2,
};

/** Er tidspunktet innenfor nattvinduet? Håndterer vinduer som krysser midnatt (22 → 08). */
export function isNight(now: Date, s: SyncSchedule = DEFAULT_SYNC_SCHEDULE, tz = "Europe/Oslo"): boolean {
  const h = localHour(now, tz);
  return s.nightFromHour > s.nightToHour
    ? h >= s.nightFromHour || h < s.nightToHour
    : h >= s.nightFromHour && h < s.nightToHour;
}

/** Intervallet som gjelder nå, i minutter. 0 = ingen synk. */
export function intervalMinutesAt(now: Date, s: SyncSchedule = DEFAULT_SYNC_SCHEDULE, tz = "Europe/Oslo"): number {
  return isNight(now, s, tz) ? s.nightIntervalMin : s.dayIntervalMin;
}

/**
 * Butikker med `last_sync_at` eldre enn dette skal synkes nå.
 * `null` betyr at det ikke skal synkes i det hele tatt på dette tidspunktet.
 */
export function dueCutoff(now: Date, s: SyncSchedule = DEFAULT_SYNC_SCHEDULE, tz = "Europe/Oslo"): Date | null {
  const interval = intervalMinutesAt(now, s, tz);
  if (interval <= 0) return null;
  return new Date(now.getTime() - Math.max(0, interval - s.graceMin) * 60_000);
}

/** Er butikken due? `lastSyncAt` null = aldri synket, altså alltid due (når det synkes). */
export function isDue(lastSyncAt: string | Date | null, cutoff: Date): boolean {
  if (!lastSyncAt) return true;
  const t = lastSyncAt instanceof Date ? lastSyncAt : new Date(lastSyncAt);
  return t.getTime() < cutoff.getTime();
}

/** Lokal time (0–23) i en tidssone. Intl håndterer sommertid. */
function localHour(d: Date, tz: string): number {
  const v = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, hour: "2-digit" }).format(d);
  return Number(v) % 24;
}

/** Planen fra Edge Function-secrets, med standardverdiene som reserve. */
export function scheduleFromEnv(): SyncSchedule {
  const num = (key: string, fallback: number) => {
    const raw = Deno.env.get(key);
    if (raw === undefined || raw.trim() === "") return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    dayIntervalMin: num("SYNC_INTERVAL_MIN", DEFAULT_SYNC_SCHEDULE.dayIntervalMin),
    nightIntervalMin: num("NIGHT_SYNC_INTERVAL_MIN", DEFAULT_SYNC_SCHEDULE.nightIntervalMin),
    nightFromHour: num("SYNC_NIGHT_FROM_HOUR", DEFAULT_SYNC_SCHEDULE.nightFromHour),
    nightToHour: num("SYNC_NIGHT_TO_HOUR", DEFAULT_SYNC_SCHEDULE.nightToHour),
    graceMin: num("SYNC_GRACE_MIN", DEFAULT_SYNC_SCHEDULE.graceMin),
  };
}
