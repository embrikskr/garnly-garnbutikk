/**
 * timeout-sweeper: pg_cron hvert minutt. Finner tilbud med utløpt frist,
 * markerer expired, øker timeout_streak for butikken, og sender neste tilbud.
 * Purrer også på ordrer butikken ikke har slått ut i egen kasse.
 */
import { adminClient, audit, json, requireInternalSecret } from "../_shared/db.ts";
import { makeNextOffer } from "../_shared/offers.ts";
import { reconcileFulfilledAt } from "../_shared/fulfillment_sync.ts";
import { overfoerEtterslep } from "../_shared/transfer_sync.ts";

/** Hvor lenge en sendt ordre får stå uten at kassauttrekket er bekreftet. */
const KASSA_PURRE_TIMER = 24;

/** Backstop: hvor gammel en utildelt fulfillment må være før vi spør Shopify selv. */
const FULFILLMENT_BACKSTOP_MIN = 60;
/** Hvor ofte samme gruppe spørres på nytt. */
const FULFILLMENT_RECHECK_MIN = 15;
/** Tak på antall grupper per sveip, så et etterslep ikke sprenger API-budsjettet. */
const FULFILLMENT_BACKSTOP_BATCH = 20;

Deno.serve(async (req) => {
  const unauthorized = requireInternalSecret(req);
  if (unauthorized) return unauthorized;
  const db = adminClient();
  const now = new Date().toISOString();
  const { data: expired } = await db.from("offers").select("id, store_id, routing_group_id").eq("status", "offered").lt("deadline_at", now).limit(200);

  const touchedGroups = new Set<string>();
  for (const o of expired ?? []) {
    // Betinget oppdatering så vi ikke kolliderer med et svar som kom akkurat nå
    const { data: upd } = await db.from("offers").update({ status: "expired", responded_at: now }).eq("id", o.id).eq("status", "offered").select("id");
    if (!upd?.length) continue;
    await db.rpc("mark_store_timeout", { p_store_id: o.store_id });
    await audit("offer", o.id, "expired", { store_id: o.store_id });
    touchedGroups.add(o.routing_group_id);
  }
  for (const g of touchedGroups) await makeNextOffer(g);
  const merket = await etterslepFulfillment(db);
  // Sendinger CargonizerConnect laget, men ikke meldte inn til transportøren. Webhooken tar
  // de fleste med en gang; dette er for de som feilet eller kom inn før koden fantes.
  const overfort = await overfoerEtterslep(db);
  const purret = await purrKassauttrekk(db, now);
  return json({ expired: touchedGroups.size, fulfilled_merket: merket, overfort, kassa_purret: purret });
});

/**
 * Backstop for tapte `fulfillments/create`-webhooks.
 *
 * Fulfillment-tidspunktet er det som får sync-store til å holde igjen varer kassa ennå ikke
 * har trukket fra. Går webhooken tapt, står tidspunktet tomt, og da selger vi garn som
 * allerede er sendt. En webhook er ikke en garanti, så vi spør Shopify selv også.
 *
 * Bare ordrer eldre enn en time, og hver gruppe spørres høyst hvert kvarter
 * (`fulfillment_checked_at`). Ellers ville dette sveipet, som går hvert minutt, spurt Shopify
 * om de samme ordrene 1440 ganger i døgnet.
 */
async function etterslepFulfillment(db: ReturnType<typeof adminClient>): Promise<number> {
  const eldreEnn = new Date(Date.now() - FULFILLMENT_BACKSTOP_MIN * 60 * 1000).toISOString();
  const sjekketFør = new Date(Date.now() - FULFILLMENT_RECHECK_MIN * 60 * 1000).toISOString();

  const { data: kandidater } = await db
    .from("routing_groups")
    .select("routing_order_id")
    .eq("status", "assigned")
    .is("fulfilled_at", null)
    .lt("assigned_at", eldreEnn)
    .or(`fulfillment_checked_at.is.null,fulfillment_checked_at.lt.${sjekketFør}`)
    .limit(FULFILLMENT_BACKSTOP_BATCH);

  const ordrer = [...new Set((kandidater ?? []).map((g: { routing_order_id: string }) => g.routing_order_id))];
  let merket = 0;
  for (const id of ordrer) {
    try {
      merket += await reconcileFulfilledAt(id);
    } catch (e) {
      // En ordre som feiler skal ikke stoppe resten av sveipet.
      console.error("[fulfillment-backstop]", id, e instanceof Error ? e.message : e);
    }
  }
  return merket;
}

/**
 * Purring på kassauttrekk.
 *
 * Til butikken bekrefter at en sendt ordre er slått ut i egen kasse, holder vi igjen de
 * varene på lageret (se _shared/inventory.ts). Glemmes knappen, står garnet unødig utilgjengelig
 * for salg. Purringen sendes én gang per ordre – `pos_reminder_sent_at` hindrer at sveipet,
 * som går hvert minutt, sender den 1440 ganger i døgnet.
 */
async function purrKassauttrekk(db: ReturnType<typeof adminClient>, now: string): Promise<number> {
  const frist = new Date(Date.now() - KASSA_PURRE_TIMER * 3600 * 1000).toISOString();
  const { data: forfalt } = await db
    .from("routing_groups")
    .select("id, assigned_store_id, line_items, fulfilled_at, routing_orders(shopify_order_name), stores:assigned_store_id(name, contact_email)")
    .in("status", ["assigned", "fulfilled"])
    .is("pos_deducted_at", null)
    .is("pos_reminder_sent_at", null)
    .not("fulfilled_at", "is", null)
    .lt("fulfilled_at", frist)
    .limit(50);

  let sendt = 0;
  for (const g of (forfalt ?? []) as any[]) {
    // Betinget: en knapp trykket i samme sekund skal vinne over purringen.
    const { data: upd } = await db.from("routing_groups").update({ pos_reminder_sent_at: now })
      .eq("id", g.id).is("pos_deducted_at", null).is("pos_reminder_sent_at", null).select("id");
    if (!upd?.length) continue;

    const ordre = g.routing_orders?.shopify_order_name ?? "ordren";
    const butikk = g.stores?.name ?? "butikken";
    const varer = (g.line_items ?? []).map((i: { qty: number; title?: string }) => `${i.qty} × ${i.title ?? ""}`).join(", ");
    const tekst = `${ordre} ble sendt for over ${KASSA_PURRE_TIMER} timer siden, men er ikke merket som slått ut i kassa.\n\n` +
      `Varer: ${varer}\n\n` +
      `Til dette er gjort holder Garnly igjen de varene på lageret, så de vises ikke for salg. ` +
      `Trykk «Slått ut i kassa» på ordren i butikkpanelet.`;

    const { notifyOps, sendEmail } = await import("../_shared/notify.ts");
    if (g.stores?.contact_email) {
      await sendEmail(g.stores.contact_email, `Husk å slå ut ${ordre} i kassa`, `<pre>${tekst}</pre>`, tekst);
    } else {
      await notifyOps(`Kassauttrekk mangler for ${ordre}`, `Butikk: ${butikk}\n\n${tekst}`);
    }
    await audit("routing_group", g.id, "pos_deduction_reminder", { store_id: g.assigned_store_id });
    sendt++;
  }
  return sendt;
}
