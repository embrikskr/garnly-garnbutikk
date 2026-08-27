/**
 * Felles tilbudslogikk brukt av order-intake, offer-respond og timeout-sweeper.
 */
import { adminClient, audit } from "./db.ts";
import { deadlineWithinBusinessHours } from "./routing.ts";
import { hashToken, newToken, offerLinks } from "./tokens.ts";
import { notifyOps, notifyStoreOffer } from "./notify.ts";
import type { LineItem, RoutingGroupRow, StoreRow } from "./types.ts";

/**
 * Sender tilbud til neste kandidat for en gruppe. Re-sorterer gjenværende
 * pending-kandidater på gjeldende verdier (Ordrefordeling_Logikk §3).
 * Returnerer true hvis et tilbud ble sendt, false hvis køen var tom (→ eskalert).
 */
export async function makeNextOffer(groupId: string): Promise<boolean> {
  const db = adminClient();
  const { data: group } = await db.from("routing_groups").select("*, routing_orders!inner(shopify_order_name, status)").eq("id", groupId).single();
  if (!group || group.status !== "routing") return false;

  // Aktiv (offered) finnes allerede? Da gjør vi ingenting.
  const { data: open } = await db.from("offers").select("id").eq("routing_group_id", groupId).eq("status", "offered").limit(1);
  if (open?.length) return true;

  // Kandidater: pending-tilbud, re-sortert etter fordelingsregelen NÅ, og med lager re-sjekket fra siste synk
  const { data: qualifiedNow } = await db.rpc("qualified_stores", { p_line_items: group.line_items });
  const qualifiedIds: string[] = (qualifiedNow ?? []).map((r: { store_id: string }) => r.store_id);
  const { data: pending } = await db.from("offers").select("*").eq("routing_group_id", groupId).eq("status", "pending");
  const pendingByStore = new Map((pending ?? []).map((o: any) => [o.store_id, o]));

  const nextStoreId = qualifiedIds.find((id) => pendingByStore.has(id));
  if (!nextStoreId) {
    // Kandidater som ikke lenger kvalifiserer (lager endret) markeres, så eskaler
    for (const o of pending ?? []) await db.from("offers").update({ status: "declined_stock", responded_at: new Date().toISOString(), response_note: "ikke lenger på lager ved re-sortering" }).eq("id", o.id);
    await escalateGroup(group, "Ingen kvalifiserte butikker igjen i køen");
    return false;
  }

  const offer = pendingByStore.get(nextStoreId)!;
  const { data: store } = await db.from("stores").select("*").eq("id", nextStoreId).single();
  if (!store) return false;

  const token = newToken();
  const now = new Date();
  const deadline = deadlineWithinBusinessHours(now, Number(store.offer_ttl_hours), store.business_hours);
  const { count } = await db.from("offers").select("id", { count: "exact", head: true }).eq("routing_group_id", groupId).neq("status", "pending");
  await db.from("offers").update({
    status: "offered",
    token_hash: await hashToken(token),
    offered_at: now.toISOString(),
    deadline_at: deadline.toISOString(),
    sequence_no: (count ?? 0) + 1,
  }).eq("id", offer.id);

  await notifyStoreOffer(store as StoreRow, group.routing_orders.shopify_order_name ?? "", group.line_items as LineItem[], deadline, offerLinks(token));
  await audit("offer", offer.id, "offered", { store_id: store.id, deadline_at: deadline.toISOString(), group_id: groupId });

  if (store.auto_accept) {
    // Auto-godta: kall offer-respond internt med token
    const { callFunction } = await import("./db.ts");
    await callFunction("offer-respond", { token, action: "accept", auto: true });
  }
  return true;
}

export async function escalateGroup(group: RoutingGroupRow & { routing_orders?: { shopify_order_name?: string } }, reason: string) {
  const db = adminClient();
  await db.from("routing_groups").update({ status: "escalated" }).eq("id", group.id);
  await refreshOrderStatus(group.routing_order_id);
  await audit("routing_group", group.id, "escalated", { reason });
  const name = group.routing_orders?.shopify_order_name ?? group.routing_order_id;
  await notifyOps(`Ordre ${name} trenger manuell håndtering`, `${reason}\n\nVarelinjer:\n${(group.line_items as LineItem[]).map((l) => `  ${l.qty} × ${l.title}`).join("\n")}\n\nOrdren står på hold i Shopify.`);
}

/** Oppdaterer routing_orders.status ut fra gruppene. */
export async function refreshOrderStatus(orderId: string) {
  const db = adminClient();
  const { data: groups } = await db.from("routing_groups").select("status").eq("routing_order_id", orderId);
  const st = (groups ?? []).map((g: { status: string }) => g.status);
  let status: string;
  if (st.every((s) => s === "cancelled")) status = "cancelled";
  else if (st.every((s) => s === "assigned")) status = "assigned";
  else if (st.some((s) => s === "escalated")) status = "escalated";
  else if (st.some((s) => s === "assigned")) status = "partially_assigned";
  else status = "routing";
  await db.from("routing_orders").update({ status }).eq("id", orderId);
}
