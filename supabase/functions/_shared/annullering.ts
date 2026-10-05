/**
 * Kansellert ordre → sendingen i Cargonizer skal bort, hvis den ikke er overført.
 *
 * Med etiketten i «Til pakking» finnes sendingen før pakken er sendt. Kanselleres ordren i
 * Shopify i mellomtiden, står en etikett og en sending igjen som ingen skal bruke. Er den
 * ikke overført, vet ikke PostNord om den, og den kan slettes.
 *
 * Slettingen er ikke dokumentert i Cargonizers API (se slettConsignment). Vi prøver, og leser
 * sendingen på nytt. Er den ikke borte, lagres feilen på gruppen (`consignment_void_error`),
 * og ordren står under «Trenger handling» i Garnly-admin med beskjed om å slette den for hånd.
 * Backstoppen (`annullerEtterslep`, cron hver halvtime) prøver igjen – og ser at en sending
 * som er slettet for hånd er borte, så saken lukker seg selv.
 *
 * En sending som alt er overført, røres ikke: da har PostNord den, og en sletting her ville
 * ikke stoppet noe.
 */
import { adminClient, audit } from "./db.ts";
import { notifyOps } from "./notify.ts";
import { erSlettet, hentConsignment, slettConsignment, transferBeslutning } from "./shipping/cargonizer.ts";

export interface AnnulleringUtfall {
  group: string;
  slettet: number[];
  feil: string | null;
}

/** Tak per kjøring av backstoppen. */
const BATCH = 20;

function ett<T>(v: T | T[] | null | undefined): T | null {
  return (Array.isArray(v) ? v[0] : v) ?? null;
}

/**
 * Sletter uoverførte sendinger for alle grupper på en kansellert ordre. Gjør ingenting hvis
 * ordren ikke er kansellert hos oss – en feil id skal ikke kunne slette en levende sending.
 */
export async function annullerSendinger(routingOrderId: string): Promise<AnnulleringUtfall[]> {
  const db = adminClient();
  const { data: ro } = await db.from("routing_orders")
    .select("id, status, shopify_order_name").eq("id", routingOrderId).maybeSingle();
  if (!ro || ro.status !== "cancelled") return [];
  const orderName = ro.shopify_order_name ?? "";

  const { data: grupper } = await db.from("routing_groups")
    .select("id, created_at, cargonizer_consignment_id, transferred_at, manually_shipped_at, consignment_voided_at, consignment_void_error, stores:assigned_store_id(shipping_sender_id)")
    .eq("routing_order_id", routingOrderId)
    .not("assigned_store_id", "is", null);

  const ut: AnnulleringUtfall[] = [];
  for (const g of (grupper ?? []) as Array<Record<string, any>>) {
    if (g.consignment_voided_at || g.manually_shipped_at) continue;
    const senderId = ett(g.stores as { shipping_sender_id: string | null } | null)?.shipping_sender_id;
    if (!senderId) continue;

    try {
      // Bare sendinger vi VET hører til gruppen: den lagrede, og alle Garnly har laget for den
      // (audit_log). Ikke søk på ordrenummeret: det gjentar seg (ny Shopify-butikk i september),
      // og et treff kunne vært en annen ordres sending. Den skal vi aldri slette.
      const ids = new Set<number>();
      if (g.cargonizer_consignment_id) ids.add(Number(g.cargonizer_consignment_id));
      const { data: laget } = await db.from("audit_log").select("payload")
        .eq("entity", "routing_group").eq("entity_id", g.id).eq("event", "consignment_created");
      for (const r of (laget ?? []) as Array<{ payload: { consignment_id?: unknown } | null }>) {
        const id = Number(r.payload?.consignment_id);
        if (Number.isFinite(id) && id > 0) ids.add(id);
      }
      if (!ids.size) continue;

      const slettet: number[] = [];
      const svar: string[] = [];
      const feil: string[] = [];
      for (const id of ids) {
        const c = await hentConsignment(id, senderId);
        if (erSlettet(c)) continue;
        const b = transferBeslutning(c!);
        if (b.handling === "allerede") {
          // PostNord har den. Tidspunktet lagres, så backstoppen ikke ser på den igjen.
          await db.from("routing_groups").update({ transferred_at: b.tidspunkt ?? new Date().toISOString() })
            .eq("id", g.id).is("transferred_at", null);
          await audit("routing_group", g.id, "consignment_not_deleted", { consignment_id: id, grunn: "alt overført", order: orderName });
          continue;
        }
        if (b.handling === "ukjent") {
          feil.push(`Sending ${id} har ukjent tilstand «${b.state}» – slett den i Cargonizer hvis den ikke er overført.`);
          continue;
        }
        const r = await slettConsignment(id, senderId);
        if (r.slettet) {
          slettet.push(id);
          svar.push(`${id}: ${r.melding}`);
        } else feil.push(r.melding);
      }

      if (feil.length) {
        const tekst = feil.join(" | ").slice(0, 900);
        await db.from("routing_groups").update({ consignment_void_error: tekst }).eq("id", g.id);
        await audit("routing_group", g.id, "consignment_delete_failed", { order: orderName, feil, slettet });
        // Varsle én gang – ikke hver halvtime backstoppen prøver igjen.
        if (!g.consignment_void_error) {
          await notifyOps(
            `Kansellert ${orderName}: sending må slettes i Cargonizer`,
            `Ordren er kansellert i Shopify, men sendingen kunne ikke slettes automatisk:\n${feil.join("\n")}\n\n` +
              `Slett den i Cargonizer. Saken står under «Trenger handling» til den er borte.`,
          );
        }
        ut.push({ group: g.id, slettet, feil: tekst });
      } else {
        await db.from("routing_groups")
          .update({ consignment_voided_at: new Date().toISOString(), consignment_void_error: null }).eq("id", g.id);
        // Svaret lagres: slettingen er udokumentert, og loggen viser hva Cargonizer faktisk sa.
        await audit("routing_group", g.id, "consignment_deleted", { order: orderName, slettet, svar });
        ut.push({ group: g.id, slettet, feil: null });
      }
    } catch (e) {
      // Nettfeil mot Cargonizer: ingen feilmelding på gruppen, backstoppen prøver igjen.
      console.error("[annullering]", g.id, e instanceof Error ? e.message : e);
      ut.push({ group: g.id, slettet: [], feil: `nettfeil: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  return ut;
}

/** Backstop: kansellerte ordrer med en sending som verken er slettet eller overført. */
export async function annullerEtterslep(): Promise<{ ordrer: number; utfall: AnnulleringUtfall[] }> {
  const { data } = await adminClient().from("routing_groups")
    .select("routing_order_id, routing_orders!inner(status)")
    .eq("routing_orders.status", "cancelled")
    .not("cargonizer_consignment_id", "is", null)
    .is("consignment_voided_at", null)
    .is("transferred_at", null)
    .is("manually_shipped_at", null)
    .limit(BATCH);
  const ordrer = [...new Set((data ?? []).map((r: { routing_order_id: string }) => r.routing_order_id))];
  const utfall: AnnulleringUtfall[] = [];
  for (const id of ordrer) utfall.push(...await annullerSendinger(id));
  return { ordrer: ordrer.length, utfall };
}
