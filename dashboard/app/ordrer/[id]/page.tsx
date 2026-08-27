export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/badge";
import { db } from "@/lib/db";
import { fmtTime } from "@/lib/format";

interface Line {
  qty: number;
  title: string;
}

export default async function OrderDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = db();
  const { data: order } = await s.from("routing_orders").select("*").eq("id", id).maybeSingle();
  if (!order) notFound();
  const { data: groups } = await s
    .from("routing_groups")
    .select("*, stores(name)")
    .eq("routing_order_id", id)
    .order("group_no");
  const groupIds = (groups ?? []).map((g) => g.id);
  const { data: offers } = groupIds.length
    ? await s.from("offers").select("*, stores(name)").in("routing_group_id", groupIds).order("sequence_no")
    : { data: [] };

  const customer = (order.customer ?? {}) as Record<string, string | null>;

  return (
    <>
      <p>
        <Link href="/ordrer">← Ordrer</Link>
      </p>
      <h1>
        Ordre {order.shopify_order_name ?? order.id} <Badge status={order.status} />
      </h1>
      <p className="muted">
        Mottatt {fmtTime(order.created_at)}
        {customer.name ? ` · ${customer.name}` : ""}
        {customer.city ? `, ${customer.zip ?? ""} ${customer.city}` : ""}
        {customer.email ? ` · ${customer.email}` : ""}
      </p>

      {(groups ?? []).map((g) => {
        const groupOffers = (offers ?? []).filter((o) => o.routing_group_id === g.id);
        return (
          <section key={g.id}>
            <h2>
              Gruppe {g.group_no} <Badge status={g.status} />
              {g.stores && <> · {(g.stores as { name: string }).name}</>}
            </h2>
            <ul className="lines">
              {((g.line_items ?? []) as Line[]).map((l, i) => (
                <li key={i}>
                  {l.qty} × {l.title}
                </li>
              ))}
            </ul>
            {g.tracking_number && (
              <p>
                Sporing:{" "}
                {g.tracking_url ? (
                  <a href={g.tracking_url}>{g.tracking_number}</a>
                ) : (
                  <span className="mono">{g.tracking_number}</span>
                )}
              </p>
            )}
            <table>
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th>Butikk</th>
                  <th>Status</th>
                  <th>Tilbudt</th>
                  <th>Frist</th>
                  <th>Svart</th>
                  <th>Merknad</th>
                </tr>
              </thead>
              <tbody>
                {groupOffers.map((o) => (
                  <tr key={o.id}>
                    <td className="num">{o.sequence_no}</td>
                    <td>{(o.stores as { name: string } | null)?.name ?? o.store_id}</td>
                    <td>
                      <Badge status={o.status} />
                    </td>
                    <td>{fmtTime(o.offered_at)}</td>
                    <td>{fmtTime(o.deadline_at)}</td>
                    <td>{fmtTime(o.responded_at)}</td>
                    <td>{o.response_note ?? ""}</td>
                  </tr>
                ))}
                {groupOffers.length === 0 && (
                  <tr>
                    <td colSpan={7} className="muted">
                      Ingen tilbud for denne gruppen.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>
        );
      })}
    </>
  );
}
