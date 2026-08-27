export const dynamic = "force-dynamic";

import Link from "next/link";
import { ignoreUnmatched } from "@/lib/actions";
import { db } from "@/lib/db";
import { fmtTime } from "@/lib/format";

export default async function Unmatched() {
  const { data: rows } = await db()
    .from("unmatched_items")
    .select("*, stores(name)")
    .is("resolved_product_id", null)
    .eq("ignored", false)
    .order("last_seen", { ascending: false })
    .limit(500);

  return (
    <>
      <h1>Umatchede varer</h1>
      <p className="muted">
        Rader fra kassesystemene som ikke kunne kobles til et Garnly-produkt. Koble dem til riktig produkt (EAN/SKU læres
        automatisk), eller ignorer varer Garnly ikke selger.
      </p>
      <table>
        <thead>
          <tr>
            <th>Butikk</th>
            <th>EAN</th>
            <th>SKU</th>
            <th>Navn</th>
            <th className="num">Antall</th>
            <th>Sist sett</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {(rows ?? []).map((r) => (
            <tr key={r.id}>
              <td>{(r.stores as { name: string } | null)?.name ?? "–"}</td>
              <td className="mono">{r.ean ?? "–"}</td>
              <td className="mono">{r.sku ?? "–"}</td>
              <td>{r.name ?? "–"}</td>
              <td className="num">{r.qty ?? "–"}</td>
              <td>{fmtTime(r.last_seen)}</td>
              <td>
                <Link href={`/umatchet/${r.id}`}>Koble</Link>{" "}
                <form className="inline" action={ignoreUnmatched}>
                  <input type="hidden" name="id" value={r.id} />
                  <button className="ghost" type="submit">
                    Ignorer
                  </button>
                </form>
              </td>
            </tr>
          ))}
          {(rows ?? []).length === 0 && (
            <tr>
              <td colSpan={7} className="muted">
                Ingen umatchede varer. 🎉
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
