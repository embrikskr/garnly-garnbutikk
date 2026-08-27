export const dynamic = "force-dynamic";

import Link from "next/link";
import { Badge } from "@/components/badge";
import { db } from "@/lib/db";
import { fmtTime } from "@/lib/format";

interface StoreOverview {
  id: string;
  name: string;
  pos_system: string;
  active: boolean;
  last_sync_at: string | null;
  last_sync_status: string | null;
  consecutive_sync_failures: number;
  assigned_count: number;
  timeout_streak: number;
  last_assigned_at: string | null;
  products_in_stock: number;
  unmatched_count: number;
}

export default async function Home() {
  const s = db();
  const [storesRes, escalatedRes, offeredRes, unmatchedRes] = await Promise.all([
    s.from("v_store_overview").select("*").order("name"),
    s.from("routing_groups").select("id", { count: "exact", head: true }).eq("status", "escalated"),
    s.from("offers").select("id", { count: "exact", head: true }).eq("status", "offered"),
    s.from("unmatched_items").select("id", { count: "exact", head: true }).is("resolved_product_id", null).eq("ignored", false),
  ]);
  const stores = (storesRes.data ?? []) as StoreOverview[];
  const escalated = escalatedRes.count ?? 0;
  const offered = offeredRes.count ?? 0;
  const unmatched = unmatchedRes.count ?? 0;
  const syncErrors = stores.filter((st) => st.active && st.last_sync_status && st.last_sync_status !== "ok").length;

  return (
    <>
      <h1>Oversikt</h1>
      {escalated > 0 && (
        <p className="alert">
          {escalated} ordregruppe{escalated === 1 ? "" : "r"} trenger manuell håndtering — <Link href="/ordrer">se ordrer</Link>
        </p>
      )}
      <div className="cards">
        <div className="card">
          <div className="num">{stores.filter((st) => st.active).length}</div>
          <div className="lbl">Aktive butikker</div>
        </div>
        <div className="card">
          <div className="num">{offered}</div>
          <div className="lbl">Åpne tilbud</div>
        </div>
        <div className="card">
          <div className="num">{escalated}</div>
          <div className="lbl">Eskalerte grupper</div>
        </div>
        <div className="card">
          <div className="num">{unmatched}</div>
          <div className="lbl">Umatchede varer</div>
        </div>
        <div className="card">
          <div className="num">{syncErrors}</div>
          <div className="lbl">Butikker med synkfeil</div>
        </div>
      </div>

      <h2>Butikker</h2>
      <table>
        <thead>
          <tr>
            <th>Butikk</th>
            <th>Kasse</th>
            <th>Siste synk</th>
            <th>Synkstatus</th>
            <th className="num">Varer på lager</th>
            <th className="num">Umatchet</th>
            <th className="num">Tildelte ordrer</th>
            <th className="num">Timeout-streak</th>
          </tr>
        </thead>
        <tbody>
          {stores.map((st) => (
            <tr key={st.id}>
              <td>
                {st.name} {!st.active && <span className="badge muted">Inaktiv</span>}
              </td>
              <td>{st.pos_system}</td>
              <td>{fmtTime(st.last_sync_at)}</td>
              <td>
                <Badge status={st.last_sync_status ?? undefined} />
                {st.consecutive_sync_failures > 0 && <span className="muted"> ({st.consecutive_sync_failures} på rad)</span>}
              </td>
              <td className="num">{st.products_in_stock}</td>
              <td className="num">{st.unmatched_count}</td>
              <td className="num">{st.assigned_count}</td>
              <td className="num">{st.timeout_streak}</td>
            </tr>
          ))}
          {stores.length === 0 && (
            <tr>
              <td colSpan={8} className="muted">
                Ingen butikker registrert ennå. Legg inn rader i stores-tabellen (se README).
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
