export const dynamic = "force-dynamic";

import { Badge } from "@/components/badge";
import { triggerSync } from "@/lib/actions";
import { db } from "@/lib/db";
import { fmtTime } from "@/lib/format";

export default async function Sync() {
  const s = db();
  const [{ data: stores }, { data: runs }] = await Promise.all([
    s
      .from("stores")
      .select("id, name, pos_system, active, last_sync_at, last_sync_status, last_sync_rows, consecutive_sync_failures")
      .order("name"),
    s.from("sync_runs").select("*, stores(name)").order("started_at", { ascending: false }).limit(100),
  ]);

  return (
    <>
      <h1>Lagersynk</h1>
      <table>
        <thead>
          <tr>
            <th>Butikk</th>
            <th>Kasse</th>
            <th>Siste synk</th>
            <th>Status</th>
            <th className="num">Rader</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {(stores ?? []).map((st) => (
            <tr key={st.id}>
              <td>
                {st.name} {!st.active && <span className="badge muted">Inaktiv</span>}
              </td>
              <td>{st.pos_system}</td>
              <td>{fmtTime(st.last_sync_at)}</td>
              <td>
                <Badge status={st.last_sync_status ?? undefined} />
                {st.consecutive_sync_failures > 0 && <span className="muted"> ({st.consecutive_sync_failures} feil på rad)</span>}
              </td>
              <td className="num">{st.last_sync_rows ?? "–"}</td>
              <td>
                <form className="inline" action={triggerSync}>
                  <input type="hidden" name="store_id" value={st.id} />
                  <button type="submit">Synk nå</button>
                </form>
              </td>
            </tr>
          ))}
          {(stores ?? []).length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                Ingen butikker registrert.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="muted">
        «Synk nå» venter til synken er ferdig og kan ta opptil et par minutter for store varelager. Cron synker uansett
        hvert kvarter.
      </p>

      <h2>Siste kjøringer</h2>
      <table>
        <thead>
          <tr>
            <th>Butikk</th>
            <th>Start</th>
            <th>Slutt</th>
            <th>Status</th>
            <th className="num">Lest</th>
            <th className="num">Matchet</th>
            <th className="num">Endret</th>
            <th>Feil</th>
          </tr>
        </thead>
        <tbody>
          {(runs ?? []).map((r) => (
            <tr key={r.id}>
              <td>{(r.stores as { name: string } | null)?.name ?? "–"}</td>
              <td>{fmtTime(r.started_at)}</td>
              <td>{fmtTime(r.finished_at)}</td>
              <td>
                <Badge status={r.status} />
              </td>
              <td className="num">{r.rows_read ?? "–"}</td>
              <td className="num">{r.rows_matched ?? "–"}</td>
              <td className="num">{r.rows_changed ?? "–"}</td>
              <td className="mono">{r.error ? String(r.error).slice(0, 120) : ""}</td>
            </tr>
          ))}
          {(runs ?? []).length === 0 && (
            <tr>
              <td colSpan={8} className="muted">
                Ingen synk-kjøringer ennå.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
