export const dynamic = "force-dynamic";

import { db } from "@/lib/db";
import { fmtTime } from "@/lib/format";

interface InventoryRow {
  qty: number;
  qty_raw: number;
  synced_at: string;
  products: { name: string; ean: string | null; sku: string | null };
  stores: { name: string };
}

export default async function Inventory({
  searchParams,
}: {
  searchParams: Promise<{ butikk?: string; q?: string }>;
}) {
  const { butikk, q } = await searchParams;
  const s = db();
  const { data: stores } = await s.from("stores").select("id, name").order("name");

  let query = s
    .from("inventory")
    .select("qty, qty_raw, synced_at, products!inner(name, ean, sku), stores!inner(name)")
    .limit(1000);
  if (butikk) query = query.eq("store_id", butikk);
  if (q) query = query.ilike("products.name", `%${q.replace(/[,()]/g, " ")}%`);
  const { data } = await query;
  const rows = ((data ?? []) as unknown as InventoryRow[]).sort((a, b) =>
    a.products.name.localeCompare(b.products.name, "no"),
  );

  return (
    <>
      <h1>Lager</h1>
      <form className="filters" method="get">
        <select name="butikk" defaultValue={butikk ?? ""}>
          <option value="">Alle butikker</option>
          {(stores ?? []).map((st) => (
            <option key={st.id} value={st.id}>
              {st.name}
            </option>
          ))}
        </select>
        <input type="text" name="q" defaultValue={q ?? ""} placeholder="Søk på produktnavn" size={30} />
        <button type="submit">Filtrer</button>
      </form>
      <table>
        <thead>
          <tr>
            <th>Produkt</th>
            <th>EAN</th>
            <th>Butikk</th>
            <th className="num">Antall (til Shopify)</th>
            <th className="num">Rått fra kasse</th>
            <th>Synket</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>{r.products.name}</td>
              <td className="mono">{r.products.ean ?? "–"}</td>
              <td>{r.stores.name}</td>
              <td className="num">{r.qty}</td>
              <td className="num">{r.qty_raw}</td>
              <td>{fmtTime(r.synced_at)}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                Ingen lagerrader{q || butikk ? " for dette filteret" : " ennå — kjør en synk først"}.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {rows.length === 1000 && <p className="muted">Viser de første 1000 radene — bruk filteret for å snevre inn.</p>}
    </>
  );
}
