export const dynamic = "force-dynamic";

import Link from "next/link";
import { Badge } from "@/components/badge";
import { db } from "@/lib/db";
import { fmtTime } from "@/lib/format";

interface GroupRow {
  id: string;
  group_no: number;
  status: string;
  stores: { name: string } | null;
}

export default async function Orders() {
  const { data: orders } = await db()
    .from("routing_orders")
    .select("id, shopify_order_name, status, created_at, routing_groups(id, group_no, status, stores(name))")
    .order("created_at", { ascending: false })
    .limit(100);

  return (
    <>
      <h1>Ordrer</h1>
      <table>
        <thead>
          <tr>
            <th>Ordre</th>
            <th>Status</th>
            <th>Grupper</th>
            <th>Mottatt</th>
          </tr>
        </thead>
        <tbody>
          {(orders ?? []).map((o) => (
            <tr key={o.id}>
              <td>
                <Link href={`/ordrer/${o.id}`}>{o.shopify_order_name ?? o.id}</Link>
              </td>
              <td>
                <Badge status={o.status} />
              </td>
              <td>
                {((o.routing_groups ?? []) as unknown as GroupRow[]).map((g) => (
                  <div key={g.id}>
                    <Badge status={g.status} /> {g.stores?.name ?? <span className="muted">ikke tildelt</span>}
                  </div>
                ))}
              </td>
              <td>{fmtTime(o.created_at)}</td>
            </tr>
          ))}
          {(orders ?? []).length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                Ingen ordrer ennå.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
