/**
 * ops-digest: daglig e-post kl. 08 hvis noe står og venter på Garnly.
 *
 * Eskalering sender e-post i det den skjer (escalateGroup → notifyOps). Den e-posten kan bli
 * lest og glemt, eller komme midt på natta. Denne er nettet under: står det fortsatt noe i
 * «Trenger handling» om morgenen, får ops en påminnelse med hva det er.
 *
 * Sender ingenting når lista er tom. En daglig «alt er fint»-e-post blir filtrert bort etter
 * en uke, og da forsvinner også den som betyr noe.
 *
 * **Klokkeslettet sjekkes her, ikke i cron.** pg_cron går i UTC, og 08:00 i Norge er 06:00
 * UTC om sommeren og 07:00 om vinteren. Jobben fyrer derfor på begge, og denne slipper bare
 * gjennom den som faktisk er kl. 08 lokalt. Alternativet – én fast UTC-time – ville sendt
 * e-posten kl. 07 halve året.
 */
import { adminClient, json, requireInternalSecret } from "../_shared/db.ts";
import { notifyOps } from "../_shared/notify.ts";

/** Lokal time e-posten skal gå ut. Se forklaringen i filhodet. */
const SENDETIME = 8;

Deno.serve(async (req) => {
  const unauthorized = requireInternalSecret(req);
  if (unauthorized) return unauthorized;
  const body = await req.json().catch(() => ({}));
  const db = adminClient();

  const lokalTime = Number(new Intl.DateTimeFormat("nb-NO", { timeZone: "Europe/Oslo", hour: "numeric", hour12: false }).format(new Date()));
  if (lokalTime !== SENDETIME && body.force !== true) {
    return json({ sendt: false, hoppet_over: `kl. ${lokalTime} lokalt, sender bare kl. ${SENDETIME}` });
  }

  // Viewene filtrerer på is_garnly_admin(), som er usann for service role. Her spørres
  // tabellene direkte, med samme regler.
  const { data: eskalert } = await db
    .from("routing_groups")
    .select("id, created_at, line_items, routing_orders!inner(shopify_order_name, is_test)")
    .eq("status", "escalated");

  const na = new Date().toISOString();
  const { data: utlopt } = await db
    .from("offers")
    .select("id, deadline_at, stores:store_id(name), routing_groups!inner(status, routing_orders!inner(shopify_order_name, is_test))")
    .eq("status", "offered")
    .lt("deadline_at", na);

  type Rad = Record<string, any>;
  const ett = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] : v) ?? null;

  // Testordrer teller ikke: de rutes som ekte, men skal ikke vekke noen.
  const esk = ((eskalert ?? []) as Rad[]).filter((g) => !ett<Rad>(g.routing_orders)?.is_test);
  const utl = ((utlopt ?? []) as Rad[]).filter((o) => {
    const g = ett<Rad>(o.routing_groups);
    return g?.status === "routing" && !ett<Rad>(g?.routing_orders)?.is_test;
  });

  if (!esk.length && !utl.length) return json({ sendt: false, eskalert: 0, utlopt: 0 });

  const timer = (fra: string) => Math.round((Date.now() - new Date(fra).getTime()) / 36e5);
  const linjer: string[] = [];
  if (esk.length) {
    linjer.push(`${esk.length} ordre(r) ingen butikk kunne ta:`);
    for (const g of esk) {
      const varer = (g.line_items ?? []).map((l: Rad) => `${l.qty} × ${l.title}`).join(", ");
      linjer.push(`  • ${ett<Rad>(g.routing_orders)?.shopify_order_name ?? g.id} – ${varer} (venter ${timer(g.created_at)} t)`);
    }
    linjer.push("");
  }
  if (utl.length) {
    linjer.push(`${utl.length} tilbud der fristen har gått ut:`);
    for (const o of utl) {
      const g = ett<Rad>(o.routing_groups);
      linjer.push(`  • ${ett<Rad>(g?.routing_orders)?.shopify_order_name ?? o.id} hos ${ett<Rad>(o.stores)?.name ?? "ukjent"} (frist gikk ut for ${timer(o.deadline_at)} t siden)`);
    }
    linjer.push("");
  }
  linjer.push("Åpne butikkpanelet og gå til fanen «Garnly» for å gi ordren til en butikk eller rute den på nytt.");

  await notifyOps(`${esk.length + utl.length} ordre(r) venter på Garnly`, linjer.join("\n"));
  return json({ sendt: true, eskalert: esk.length, utlopt: utl.length });
});
