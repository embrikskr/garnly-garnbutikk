/**
 * Felles tilbudslogikk brukt av order-intake, offer-respond og timeout-sweeper.
 */
import { adminClient, audit } from "./db.ts";
import { deadlineWithinBusinessHours, planGroups, replanIsUseful } from "./routing.ts";
import { hashToken, newToken, offerLinks } from "./tokens.ts";
import { notifyOps, notifyStoreOffer } from "./notify.ts";
import { splitHeldFulfillmentOrder } from "./shopify.ts";
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
    // Kandidater som ikke lenger kvalifiserer (lager endret) markeres
    for (const o of pending ?? []) await db.from("offers").update({ status: "declined_stock", responded_at: new Date().toISOString(), response_note: "ikke lenger på lager ved re-sortering" }).eq("id", o.id);
    // Ingen enkeltbutikk kan ta hele gruppa. Før vi sender den til et menneske:
    // prøv å dele den opp mot dagens lager. To butikker som tar hver sin del er
    // langt bedre enn en ordre som blir liggende.
    if (await replanGroup(group)) return true;
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
  // 'resplit' er historikk: gruppa er erstattet av delgrupper og skal verken telle
  // som åpen eller som eskalert.
  const st = (groups ?? []).map((g: { status: string }) => g.status).filter((s) => s !== "resplit");
  let status: string;
  if (st.every((s) => s === "cancelled")) status = "cancelled";
  else if (st.every((s) => s === "assigned")) status = "assigned";
  else if (st.some((s) => s === "escalated")) status = "escalated";
  else if (st.some((s) => s === "assigned")) status = "partially_assigned";
  else status = "routing";
  await db.from("routing_orders").update({ status }).eq("id", orderId);
}


/**
 * Deler en gruppe opp på nytt når ingen enkeltbutikk kan ta hele.
 *
 * Ved inntak bestemmes oppdelingen én gang. Avslår butikken som hadde alt, sto ordren
 * før dette igjen uten mottaker selv om to andre butikker kunne tatt hver sin del.
 * Med få butikker skjer det ofte nok til at manuell håndtering ikke er en farbar vei.
 *
 * Vi planlegger derfor på nytt mot dagens lager, splitter fulfillment orderen i Shopify
 * på samme måte som ved inntak, og tilbyr hver del for seg. Regelen om at hele antallet
 * av én varelinje kommer fra samme butikk står: planGroups deler bare per varelinje,
 * aldri inni en.
 *
 * Butikker som allerede har avslått holdes ikke utenfor. De sa nei til hele ordren, og
 * to av fem linjer er et annet spørsmål. Delgruppene er nye grupper, så det kolliderer
 * ikke med tilbudet de alt har svart på.
 *
 * Returnerer true hvis gruppa faktisk ble delt opp.
 */
async function replanGroup(group: RoutingGroupRow & { routing_orders?: { shopify_order_name?: string } }): Promise<boolean> {
  const db = adminClient();
  const lines = group.line_items as LineItem[];
  // Én varelinje kan ikke deles. Da finnes det ingenting å planlegge om.
  if (lines.length < 2) return false;

  // Butikker som allerede har sagt nei til denne ORDREN holdes utenfor. Ikke bare denne
  // gruppa: delgruppene er nye grupper, så uten dette kunne to butikker sendt de samme
  // linjene fram og tilbake mellom seg i det uendelige.
  const { data: sagtNei } = await db
    .from("offers")
    .select("store_id, routing_groups!inner(routing_order_id)")
    .eq("routing_groups.routing_order_id", group.routing_order_id)
    .in("status", ["declined", "declined_stock", "expired", "cancelled"]);
  const utelatt = new Set((sagtNei ?? []).map((o: { store_id: string }) => o.store_id));

  const { data: cov } = await db.rpc("store_coverage", { p_line_items: lines });
  const dekning = (cov ?? []).filter((c: { store_id: string }) => !utelatt.has(c.store_id));
  const { data: order_ } = await db.from("stores").select("id").eq("active", true)
    .order("last_assigned_at", { ascending: true, nullsFirst: true }).order("created_at", { ascending: true });
  const rekkefolge = (order_ ?? []).map((s: { id: string }) => s.id).filter((id: string) => !utelatt.has(id));
  const { groups: subs, uncovered } = planGroups(lines, dekning, rekkefolge);

  if (!replanIsUseful(subs, uncovered, lines.length)) return false;

  // Splitt fulfillment orderen. Som ved inntak beholder siste del den opprinnelige.
  let remainingFoId = group.shopify_fulfillment_order_id as string | null;
  const foIds: (string | null)[] = [];
  for (let i = 0; i < subs.length; i++) {
    const isLast = i === subs.length - 1 && uncovered.length === 0;
    if (isLast || !remainingFoId) { foIds.push(remainingFoId); break; }
    const { newId, remainingId } = await splitHeldFulfillmentOrder(remainingFoId, subs[i].line_items.map((l) => ({ id: l.line_item_id, quantity: l.qty })));
    foIds.push(newId);
    remainingFoId = remainingId ?? remainingFoId;
  }

  const { data: siblings } = await db.from("routing_groups").select("group_no").eq("routing_order_id", group.routing_order_id);
  let nextNo = Math.max(0, ...(siblings ?? []).map((g: { group_no: number }) => g.group_no)) + 1;

  // Den opprinnelige gruppa blir historikk. Åpne tilbud på den lukkes.
  await db.from("offers").update({ status: "cancelled", responded_at: new Date().toISOString(), response_note: "gruppa ble delt opp på nytt" })
    .eq("routing_group_id", group.id).in("status", ["pending", "offered"]);
  await db.from("routing_groups").update({ status: "resplit" }).eq("id", group.id);
  await audit("routing_group", group.id, "resplit", { deler: subs.length, udekket: uncovered.length, linjer: lines.length, utelatt: [...utelatt] });

  for (let i = 0; i < subs.length; i++) {
    const { data: row } = await db.from("routing_groups").insert({
      routing_order_id: group.routing_order_id, group_no: nextNo++, line_items: subs[i].line_items, shopify_fulfillment_order_id: foIds[i],
    }).select().single();
    await db.from("offers").insert(subs[i].candidates.map((storeId, idx) => ({ routing_group_id: row.id, store_id: storeId, sequence_no: idx + 1, status: "pending" })));
    await audit("routing_group", row.id, "planned", { candidates: subs[i].candidates, lines: subs[i].line_items.length, split: true, fra_gruppe: group.id });
    await makeNextOffer(row.id);
  }

  if (uncovered.length) {
    const { data: row } = await db.from("routing_groups").insert({
      routing_order_id: group.routing_order_id, group_no: nextNo++, line_items: uncovered, shopify_fulfillment_order_id: remainingFoId, status: "escalated",
    }).select().single();
    await escalateGroup({ ...row, routing_orders: group.routing_orders }, "Ingen butikk har hele antallet av disse linjene");
  }

  await refreshOrderStatus(group.routing_order_id);
  return true;
}
