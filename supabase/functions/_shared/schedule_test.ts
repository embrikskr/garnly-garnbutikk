import { assertEquals } from "jsr:@std/assert@1";
import { DEFAULT_SYNC_SCHEDULE, dueCutoff, intervalMinutesAt, isDue, isNight, type SyncSchedule } from "./schedule.ts";

/**
 * Kjører cron-tikkene og returnerer avstanden i minutter mellom hver faktiske synk.
 *
 * `claimForsinkelseSek` er tiden fra cron-tikket til `last_sync_at` faktisk settes.
 * Den er aldri null: pg_net-utsending og oppstart tar noen sekunder, og butikkene synkes
 * sekvensielt, så butikk nummer to venter på at butikk nummer én blir ferdig.
 * Målt 27.09.2026: ~6 s for Garnkilden (først i køen), ~45 s for Strikkefryd (bak den).
 */
function simulerIntervaller(
  overstyr: Partial<SyncSchedule>,
  fraUtc: string,
  opts: { tikk?: number; claimForsinkelseSek?: number } = {},
): number[] {
  const { tikk = 40, claimForsinkelseSek = 0 } = opts;
  const s = { ...DEFAULT_SYNC_SCHEDULE, ...overstyr };
  const start = new Date(fraUtc);
  let sist = new Date(start.getTime() - 60 * 60_000); // en time siden: due med en gang
  const kjoringer: Date[] = [];
  for (let i = 0; i < tikk; i++) {
    const tikkTid = new Date(start.getTime() + i * 5 * 60_000); // cron: hvert 5. minutt
    const cutoff = dueCutoff(tikkTid, s);
    if (cutoff && isDue(sist, cutoff)) {
      sist = new Date(tikkTid.getTime() + claimForsinkelseSek * 1000);
      kjoringer.push(sist);
    }
  }
  return kjoringer.slice(1).map((d, i) => (d.getTime() - kjoringer[i].getTime()) / 60_000);
}

// 10:00Z = 12:00 i Oslo, altså dagtid hele simuleringen.
const DAGTID = "2026-09-27T10:00:00Z";

Deno.test("grace: uten slakk blir 15 minutter 20 i praksis", () => {
  assertEquals([...new Set(simulerIntervaller({ graceMin: 0 }, DAGTID))], [20]);
});

Deno.test("grace: standardslakken holder 15 min også for butikken bak i køen", () => {
  // Garnkilden, først i køen: stempelet settes få sekunder etter tikket.
  assertEquals([...new Set(simulerIntervaller({}, DAGTID, { claimForsinkelseSek: 6 }))], [15]);
  // Strikkefryd, bak Garnkilden: stempelet settes ~45 s etter tikket.
  assertEquals([...new Set(simulerIntervaller({}, DAGTID, { claimForsinkelseSek: 45 }))], [15]);
});

Deno.test("grace må være større enn forsinkelsen på stempelet, ellers drifter det til 20", () => {
  // Grensen er reell: blir claim-forsinkelsen større enn slakken, er vi tilbake til 20 min.
  // Derfor settes last_sync_at når synken STARTER og ikke når den er ferdig – en kjøring på
  // 130 s ville ellers dratt forsinkelsen langt over enhver fornuftig slakk.
  assertEquals([...new Set(simulerIntervaller({ graceMin: 2 }, DAGTID, { claimForsinkelseSek: 150 }))], [20]);
  assertEquals([...new Set(simulerIntervaller({ graceMin: 3 }, DAGTID, { claimForsinkelseSek: 150 }))], [15]);
});

Deno.test("nattvindu krysser midnatt: 22–08 er natt, 08–22 er dag", () => {
  const natt = (utc: string) => isNight(new Date(utc));
  // Sommertid (CEST, UTC+2)
  assertEquals(natt("2026-07-01T20:30:00Z"), true); // 22:30 Oslo
  assertEquals(natt("2026-07-01T22:30:00Z"), true); // 00:30 Oslo
  assertEquals(natt("2026-07-01T04:30:00Z"), true); // 06:30 Oslo
  assertEquals(natt("2026-07-01T06:30:00Z"), false); // 08:30 Oslo
  assertEquals(natt("2026-07-01T12:00:00Z"), false); // 14:00 Oslo
  // Grensene: 22:00 er natt, 08:00 er dag
  assertEquals(natt("2026-07-01T20:00:00Z"), true); // 22:00 Oslo
  assertEquals(natt("2026-07-01T06:00:00Z"), false); // 08:00 Oslo
});

Deno.test("sommertid: samme UTC-tid er natt om vinteren og dag om sommeren", () => {
  // 06:30Z er 08:30 i Oslo om sommeren (dag) og 07:30 om vinteren (natt).
  // Derfor kan ikke vinduet uttrykkes i cron, som kjører i UTC.
  assertEquals(isNight(new Date("2026-07-01T06:30:00Z")), false);
  assertEquals(isNight(new Date("2026-01-01T06:30:00Z")), true);
});

Deno.test("nattintervall: sjeldnere om natten, og 0 slår det av helt", () => {
  const natt = new Date("2026-09-27T23:00:00Z"); // 01:00 Oslo
  const dag = new Date("2026-09-27T10:00:00Z"); // 12:00 Oslo
  assertEquals(intervalMinutesAt(dag), 15);
  assertEquals(intervalMinutesAt(natt), 60);

  const av = { ...DEFAULT_SYNC_SCHEDULE, nightIntervalMin: 0 };
  assertEquals(dueCutoff(natt, av), null); // ingen synk om natten
  assertEquals(dueCutoff(dag, av) !== null, true); // men dagen er urørt

  // Med nattintervall på 60 blir faktisk avstand 60 minutter, ikke 15.
  assertEquals([...new Set(simulerIntervaller({}, "2026-09-27T22:00:00Z", { tikk: 60 }))], [60]);
});

Deno.test("butikk som aldri er synket er alltid due", () => {
  const cutoff = dueCutoff(new Date("2026-09-27T10:00:00Z"))!;
  assertEquals(isDue(null, cutoff), true);
  assertEquals(isDue("2026-09-27T09:00:00Z", cutoff), true);
  assertEquals(isDue("2026-09-27T09:59:00Z", cutoff), false);
});
