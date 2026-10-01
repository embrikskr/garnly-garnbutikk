/**
 * Overfører Cargonizer-sendinger til transportøren.
 *
 * CargonizerConnect lager sendingen og fulfiller ordren i Shopify, men overfører den ikke:
 * appen har bare automatisk overføring på «Home Small main shipment», ikke på pakkeboks.
 * En sending som ikke er overført står som «Usendt» hos Logistra, transportøren får aldri
 * EDI-en, og sporingsnummeret kunden fikk i Shopify er dødt. Funnet 30.09.2026 på #1004.
 *
 * Kalles fra to steder, med samme kodevei:
 *   - `fulfillment_sync` i det en gruppe får `fulfilled_at` (umiddelbart)
 *   - `timeout-sweeper` som backstop, for de som feilet eller ble hoppet over
 *
 * Tre ting som styrer utformingen:
 *
 * 1. **Vi stoler ikke på svaret fra overføringen.** Cargonizer dokumenterer 302 som et
 *    gyldig svar, og gir 302 til en HTML-404 ved feil på den udokumenterte stien. Derfor
 *    leser vi sendingen på nytt etterpå og godtar først når tilstanden faktisk har endret
 *    seg. Ellers ville en feilet overføring blitt bokført som vellykket, og pakken stått
 *    usendt uten at noen visste det.
 * 2. **Testordrer overføres aldri.** En testsending som blir meldt inn til PostNord er en
 *    ekte transportbestilling.
 * 3. **Ett forsøk om gangen.** Webhooken og sveipet kan treffe samme gruppe samtidig.
 *    Forsøket «tas» med en betinget oppdatering på `transfer_attempts`, så bare én av dem
 *    kommer videre.
 */
import { adminClient, audit } from "./db.ts";
import {
  erPostNord,
  finnConsignment,
  hentConsignment,
  overfoerConsignments,
  SOKEVINDU_DAGER,
  transferBeslutning,
} from "./shipping/cargonizer.ts";

/** Etter så mange mislykkede forsøk varsles drift – én gang. */
export const VARSLE_ETTER_FORSOK = 3;
/** Hvor ofte backstoppen prøver samme gruppe på nytt. */
export const TRANSFER_RECHECK_MIN = 15;
/** Tak per sveip, så et etterslep ikke sprenger API-budsjettet. */
const TRANSFER_BATCH = 20;

export type TransferUtfall =
  | { status: "overfort"; consignmentId: number }
  | { status: "allerede"; consignmentId: number }
  | { status: "manuelt"; grunn: string }
  | { status: "hoppet_over"; grunn: string }
  | { status: "feilet"; grunn: string };

interface GruppeRad {
  id: string;
  created_at: string;
  transferred_at: string | null;
  transfer_attempts: number;
  transfer_alerted_at: string | null;
  cargonizer_consignment_id: number | null;
  carrier: string | null;
  manually_shipped_at: string | null;
  assigned_store_id: string | null;
  routing_orders: { shopify_order_name: string | null; is_test: boolean } | null;
  stores: { name: string | null; shipping_sender_id: string | null } | null;
}

/** PostgREST gir mange-til-én som objekt, men typen sier liste. Vi tåler begge. */
function ett<T>(v: T | T[] | null | undefined): T | null {
  return (Array.isArray(v) ? v[0] : v) ?? null;
}

/**
 * Overfører sendingen for én gruppe. Trygg å kalle om igjen: den sjekker tilstanden hos
 * Cargonizer før den melder inn noe.
 */
export async function overfoerGruppe(groupId: string): Promise<TransferUtfall> {
  const db = adminClient();

  const { data } = await db
    .from("routing_groups")
    .select(
      "id, created_at, transferred_at, transfer_attempts, transfer_alerted_at, cargonizer_consignment_id, assigned_store_id, " +
        "carrier, manually_shipped_at, " +
        "routing_orders(shopify_order_name, is_test), stores:assigned_store_id(name, shipping_sender_id)",
    )
    .eq("id", groupId)
    .maybeSingle();

  const rå = data as unknown as (Omit<GruppeRad, "routing_orders" | "stores"> & {
    routing_orders: GruppeRad["routing_orders"] | GruppeRad["routing_orders"][];
    stores: GruppeRad["stores"] | GruppeRad["stores"][];
  }) | null;
  if (!rå) return { status: "hoppet_over", grunn: "fant ikke gruppen" };

  const g: GruppeRad = { ...rå, routing_orders: ett(rå.routing_orders), stores: ett(rå.stores) };

  if (g.transferred_at) return { status: "allerede", consignmentId: g.cargonizer_consignment_id ?? 0 };
  if (g.manually_shipped_at) return { status: "manuelt", grunn: "alt merket som sendt manuelt" };
  if (g.routing_orders?.is_test) return { status: "hoppet_over", grunn: "testordre" };

  const orderName = g.routing_orders?.shopify_order_name ?? "";

  // Sendt med et annet fraktselskap: det finnes ingen PostNord-sending å melde inn, og en
  // Cargonizer-sending med samme ordrenummer er i så fall IKKE den som ble brukt. Å overføre
  // den ville bestilt en PostNord-henting av en pakke som allerede er på vei med noen andre.
  // Ingen oppslag, intet forsøk, intet varsel.
  if (erPostNord(g.carrier) === false) {
    return await merkManuelt(g, orderName, `sendt med ${g.carrier}`);
  }

  // Ta forsøket FØR noe kan feile. Slår den feil, holder noen andre på med samme gruppe nå.
  // Alt som kan gå galt må ligge etter denne: en feil som ikke er bokført som et forsøk
  // setter verken teller eller tidsstempel, og da prøver sveipet på nytt hvert minutt i all
  // evighet uten noen gang å nå varselgrensen.
  const { data: tatt } = await db
    .from("routing_groups")
    .update({ transfer_attempts: g.transfer_attempts + 1, transfer_checked_at: new Date().toISOString() })
    .eq("id", g.id)
    .eq("transfer_attempts", g.transfer_attempts)
    .is("transferred_at", null)
    .select("id");
  if (!tatt?.length) return { status: "hoppet_over", grunn: "et annet forsøk pågår" };
  g.transfer_attempts += 1;

  const senderId = g.stores?.shipping_sender_id ?? null;
  if (!senderId) return await bokførFeil(g, orderName, "butikken mangler Cargonizer-avsender (stores.shipping_sender_id)");

  try {
    const sending = await finnSending(g, orderName, senderId);
    if (!sending) {
      // Oppslaget gikk gjennom, men det finnes ingen sending: pakken er sendt utenom Cargonizer.
      // Før ble dette bokført som feil, prøvd hvert kvarter og varslet etter tre forsøk – om en
      // pakke som var sendt helt fint. En feil i selve oppslaget (nett, 5xx) kaster i stedet,
      // og havner i catch under som et vanlig forsøk.
      return await merkManuelt(g, orderName, "ingen Cargonizer-sending");
    }

    const beslutning = transferBeslutning(sending);
    if (beslutning.handling === "allerede") {
      await bokførOverfort(g.id, beslutning.tidspunkt ?? new Date().toISOString(), sending.id, orderName, true);
      return { status: "allerede", consignmentId: sending.id };
    }
    if (beslutning.handling === "ukjent") {
      // Vi gjetter ikke på en tilstand vi aldri har sett: å melde inn samme pakke to ganger
      // er verre enn å la et menneske se på den.
      return await bokførFeil(g, orderName, `ukjent tilstand «${beslutning.state}» på sending ${sending.id}`);
    }

    await overfoerConsignments([sending.id], senderId);

    // Les den på nytt. Svaret fra overføringen er ikke godt nok bevis – se filhodet.
    const etter = await hentConsignment(sending.id, senderId);
    const nå = transferBeslutning(etter ?? { state: null, transferAt: null });
    if (nå.handling !== "allerede") {
      return await bokførFeil(
        g,
        orderName,
        `overføringen ble ikke registrert – sending ${sending.id} står fortsatt som «${etter?.state ?? "ukjent"}»`,
      );
    }

    await bokførOverfort(g.id, nå.tidspunkt ?? new Date().toISOString(), sending.id, orderName, false);
    return { status: "overfort", consignmentId: sending.id };
  } catch (e) {
    return await bokførFeil(g, orderName, e instanceof Error ? e.message : String(e));
  }
}

/** Sendings-id-en, fra det vi har lagret eller fra et søk på ordrenummeret. */
async function finnSending(g: GruppeRad, orderName: string, senderId: string) {
  if (g.cargonizer_consignment_id) {
    const kjent = await hentConsignment(g.cargonizer_consignment_id, senderId);
    if (kjent) return kjent;
    // Lagret id som ikke finnes lenger: sendingen er slettet og laget om igjen. Søk på nytt.
  }
  const fra = new Date(new Date(g.created_at).getTime() - SOKEVINDU_DAGER * 86400_000);
  const funnet = await finnConsignment(orderName, senderId, fra);
  if (funnet) {
    await adminClient().from("routing_groups").update({ cargonizer_consignment_id: funnet.id }).eq("id", g.id);
  }
  return funnet;
}

/**
 * Sendt utenom Garnlys Cargonizer-flyt. Ingenting å overføre, og ingen grunn til å varsle.
 * Backstoppen lar gruppen være fra nå av.
 */
async function merkManuelt(g: GruppeRad, orderName: string, grunn: string): Promise<TransferUtfall> {
  const db = adminClient();
  const { data: upd } = await db
    .from("routing_groups")
    .update({ manually_shipped_at: new Date().toISOString(), transfer_error: null })
    .eq("id", g.id)
    .is("manually_shipped_at", null)
    .is("transferred_at", null)
    .select("id");
  if (upd?.length) {
    await audit("routing_group", g.id, "shipped_manually", { order: orderName, grunn, carrier: g.carrier });
  }
  return { status: "manuelt", grunn };
}

async function bokførOverfort(groupId: string, tidspunkt: string, consignmentId: number, orderName: string, alleredeOverfort: boolean) {
  const db = adminClient();
  await db
    .from("routing_groups")
    .update({ transferred_at: tidspunkt, transfer_error: null, cargonizer_consignment_id: consignmentId })
    .eq("id", groupId)
    .is("transferred_at", null);
  await audit("routing_group", groupId, "cargonizer_transferred", {
    consignment_id: consignmentId,
    order: orderName,
    at: tidspunkt,
    // Skiller «vi meldte den inn» fra «den var alt meldt inn», så loggen ikke tar æren
    // for noe CargonizerConnect eller butikken gjorde selv.
    allerede_overfort: alleredeOverfort,
  });
}

/**
 * Skriver feilen på gruppen, og varsler drift første gang forsøkene passerer grensen.
 * Backstoppen prøver videre – en sending som står usendt er ikke noe som løser seg selv.
 */
async function bokførFeil(g: GruppeRad, orderName: string, grunn: string): Promise<TransferUtfall> {
  const db = adminClient();
  console.error("[cargonizer-transfer]", orderName || g.id, grunn);
  await db.from("routing_groups").update({ transfer_error: grunn.slice(0, 500) }).eq("id", g.id);
  await audit("routing_group", g.id, "cargonizer_transfer_failed", { order: orderName, error: grunn, forsok: g.transfer_attempts });

  if (g.transfer_attempts >= VARSLE_ETTER_FORSOK && !g.transfer_alerted_at) {
    const { data: upd } = await db
      .from("routing_groups")
      .update({ transfer_alerted_at: new Date().toISOString() })
      .eq("id", g.id)
      .is("transfer_alerted_at", null)
      .select("id");
    if (upd?.length) {
      const { notifyOps } = await import("./notify.ts");
      await notifyOps(
        `Sending ikke overført til transportør: ${orderName || g.id}`,
        [
          `Butikk: ${g.stores?.name ?? "ukjent"}`,
          `Ordre: ${orderName || "(uten navn)"}`,
          `Forsøk: ${g.transfer_attempts}`,
          `Siste feil: ${grunn}`,
          "",
          "Sendingen ligger som «Usendt» i Logistra. Transportøren har ikke fått EDI, og",
          "sporingsnummeret kunden har fått virker ikke. Overfør den manuelt i Cargonizer,",
          "eller finn ut hvorfor kallet feiler. Garnly fortsetter å prøve hvert kvarter.",
        ].join("\n"),
      );
    }
  }
  return { status: "feilet", grunn };
}

/**
 * Backstop: sendte ordrer som ennå ikke er overført.
 *
 * Webhooken tar de aller fleste med en gang. Dette fanger opp de som feilet, de som kom
 * inn før denne koden fantes, og de der Cargonizer var nede akkurat da.
 */
export async function overfoerEtterslep(db: ReturnType<typeof adminClient>, grense = TRANSFER_BATCH): Promise<{ forsokt: number; overfort: number }> {
  const sjekketFør = new Date(Date.now() - TRANSFER_RECHECK_MIN * 60 * 1000).toISOString();

  const { data: kandidater } = await db
    .from("routing_groups")
    .select("id, routing_orders!inner(is_test)")
    .in("status", ["assigned", "fulfilled"])
    .not("fulfilled_at", "is", null)
    .is("transferred_at", null)
    .is("manually_shipped_at", null)
    .eq("routing_orders.is_test", false)
    .or(`transfer_checked_at.is.null,transfer_checked_at.lt.${sjekketFør}`)
    .limit(grense);

  let overfort = 0;
  for (const k of (kandidater ?? []) as Array<{ id: string }>) {
    try {
      const utfall = await overfoerGruppe(k.id);
      if (utfall.status === "overfort" || utfall.status === "allerede") overfort++;
    } catch (e) {
      // Én gruppe som feiler skal ikke stoppe resten av sveipet.
      console.error("[transfer-backstop]", k.id, e instanceof Error ? e.message : e);
    }
  }
  return { forsokt: (kandidater ?? []).length, overfort };
}
