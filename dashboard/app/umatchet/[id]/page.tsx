export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound } from "next/navigation";
import { resolveUnmatched } from "@/lib/actions";
import { db } from "@/lib/db";

export default async function LinkUnmatched({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const { id } = await params;
  const { q } = await searchParams;
  const s = db();
  const { data: row } = await s.from("unmatched_items").select("*, stores(name)").eq("id", id).maybeSingle();
  if (!row) notFound();

  const query = (q ?? row.name ?? row.sku ?? row.ean ?? "").trim();
  let candidates: Array<{ id: string; name: string; ean: string | null; sku: string | null; brand: string | null }> = [];
  if (query) {
    // Søk på navn (ilike) eller eksakt EAN/SKU. Kommaer fjernes fordi de er skilletegn i or()-uttrykket.
    const safe = query.replace(/[,()]/g, " ").trim();
    const { data } = await s
      .from("products")
      .select("id, name, ean, sku, brand")
      .eq("active", true)
      .or(`name.ilike.%${safe}%,ean.eq.${safe},sku.eq.${safe}`)
      .limit(30);
    candidates = data ?? [];
  }

  return (
    <>
      <p>
        <Link href="/umatchet">← Umatchede varer</Link>
      </p>
      <h1>Koble vare</h1>
      <table>
        <tbody>
          <tr>
            <th>Butikk</th>
            <td>{(row.stores as { name: string } | null)?.name ?? "–"}</td>
          </tr>
          <tr>
            <th>EAN</th>
            <td className="mono">{row.ean ?? "–"}</td>
          </tr>
          <tr>
            <th>SKU</th>
            <td className="mono">{row.sku ?? "–"}</td>
          </tr>
          <tr>
            <th>Navn</th>
            <td>{row.name ?? "–"}</td>
          </tr>
        </tbody>
      </table>

      <h2>Finn Garnly-produkt</h2>
      <form className="filters" method="get">
        <input type="text" name="q" defaultValue={query} placeholder="Søk på navn, EAN eller SKU" size={40} />
        <button type="submit">Søk</button>
      </form>
      <table>
        <thead>
          <tr>
            <th>Produkt</th>
            <th>Merke</th>
            <th>EAN</th>
            <th>SKU</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {candidates.map((p) => (
            <tr key={p.id}>
              <td>{p.name}</td>
              <td>{p.brand ?? "–"}</td>
              <td className="mono">{p.ean ?? "–"}</td>
              <td className="mono">{p.sku ?? "–"}</td>
              <td>
                <form className="inline" action={resolveUnmatched}>
                  <input type="hidden" name="id" value={row.id} />
                  <input type="hidden" name="product_id" value={p.id} />
                  <button type="submit">Koble til denne</button>
                </form>
              </td>
            </tr>
          ))}
          {candidates.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                Ingen treff{query ? ` på «${query}»` : ""}. Finnes produktet i Shopify? Kjør sync-products etter endringer.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
