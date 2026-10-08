# Garnly garnbutikk – instruksjoner til Claude Code

Dette repoet er backend for Garnlys felles nettbutikk for lokale garnbutikker. Les `docs/Garnly_Garnbutikk_Byggeplan_v1.md` før du gjør noe større. Den er sannheten for arkitektur og beslutninger; avvik skal først inn i planen, deretter i koden.

## Hva systemet gjør

1. **Lagersynk**: leser lager fra partnerbutikkenes kassesystemer (Duell, Mystore, CSV) hvert 15. minutt på dagtid og hver time mellom 22 og 08 (lokal tid, `_shared/schedule.ts`), matcher mot Garnlys produkter på EAN → alias (`product_aliases`) → SKU → navn → garnnavn + fargekode, og skriver antall til butikkens *location* i Garnlys Shopify (`fhxr10-gu.myshopify.com`).
2. **Ordreruting**: når en kunde betaler i Shopify, settes ordren på hold, og den tilbys én butikk om gangen (round-robin på `last_assigned_at`). Butikken svarer i **butikkpanelet** (`panel/`, garnly-butikkpanel.vercel.app) innen en frist: 5 timer åpningstid (`stores.offer_ttl_hours`, `business_hours`). Ved aksept flyttes fulfillment order til butikkens location.
3. **Sending**: butikken kan skrive ut etiketten mens ordren ligger i «Til pakking» (ikonet på kortet, `shipping-label` → `_shared/etikett.ts`): finnes ingen sending i Cargonizer, lages den der og da, **alltid med `transfer=false`**, og kortet viser «Etikett skrevet ut». Så trykker butikken **«Slått ut og klar til sending»**, og `ship-order` gjør resten (`_shared/ship.ts`): kassauttrekk → sendingen (den fra etiketten, ellers en ny – `_shared/sending.ts`: pakkeboks, eller vanlig hentested når det ikke finnes pakkeboks i nærheten eller pakken er over 10 kg; over 35 kg stopper den; vekt, SMS-varsling) → lagring av sporing → `fulfillmentCreate` i Shopify med sporing → **overføring til PostNord** (`transfer_sync.ts`, ikke for testordrer) → etikett til DirectPrint-skriver hvis Garnly har satt en opp for butikken (`stores.directprint_printer_id`) og den ikke alt er skrevet ut, ellers ingenting. Én sending per ordre: opprettelsen er låst per gruppe, og et kall som møter låsen venter og bruker samme sending. Kanselleres ordren før overføring, slettes den uoverførte sendingen i Cargonizer (`_shared/annullering.ts`, verifisert 04.10.2026); går ikke det, står den under «Trenger handling». Kortet forsvinner fra pakkelista med én gang, og ordren ligger under «Tidligere ordrer». Hvert steg tåler å kjøres på nytt. Kortet har etikett-ikonet og den ene knappen; feiler sendingen, sier kortet «Kontakt Garnly» og ordren havner i admin under «Trenger handling». **Butikkene har ikke Shopify-tilgang**, og CargonizerConnect overførte aldri sendingen til PostNord – derfor gjør Garnly begge deler selv. Testordrer overføres aldri. `transfer_sync.ts` er også backstop for sendinger som ikke ble overført; er ordren fulfillet med et annet fraktselskap enn PostNord, eller finnes det ingen Cargonizer-sending, merkes den «sendt manuelt» (`manually_shipped_at`) uten forsøk eller driftsvarsel.
4. **Butikkpanel**: en side butikken har oppe på nettbrettet. Sanntid via Supabase Realtime på `offers`, innlogging med Supabase Auth, tilgang styrt av `store_users` + RLS. E-post per tilbud er AV som standard (`stores.notify_offers`); det skalerer ikke når en butikk får titalls ordrer om dagen. Butikken styrer selv **automatisk godkjenning** (`stores.auto_accept`) via `store-settings`; endringene havner i `audit_log`. Butikkene ser ingenting om etikettskrivere.
5. **Oppgjør**: butikken får varebeløpet minus `commission_pct`; frakt er Garnlys og aldri med; testordrer telles aldri. Refusjoner fra Shopify (`refunds/create` → `order-refunded`, nattlig backstop) blir trekk i `settlement_adjustments` (minus refundert varebeløp × (100 − provisjon) / 100), i refusjonsmåneden eller neste ubetalte. Alt leses fra én regnebok, `settlement_ledger`, gjennom `settlement_lines` / `settlement_summary` / `settlement_months`. **Panelet har ingen oppgjørsfane** (fjernet 08.10.2026, kan hentes fra 3372359): oppgjøret leses med SQL rett fra `settlement_ledger`, og utbetalinger står i `settlement_payouts` (`mark_settlement_paid` krever innlogget admin). «Refundert» står fortsatt på ordren i Tidligere ordrer.
6. **Garnly-admin**: egen fane «Garnly» i panelet, bare for brukere i `garnly_admins` (egen tabell – en admin er ikke en butikk og har ingen rad i `store_users`). Viser «Trenger handling» (eskalerte grupper, tilbud med utløpt frist, og sendinger som stoppet hos butikken – med hvem som avslo og hvorfor, eller feilmeldingen), alle ordrer på tvers av butikker med filter, nøkkeltall og synkstatus per butikk. Handlinger via `admin-actions`: gi ordren til en butikk **uten lagersjekk** (butikken kan ha bestilt inn), eller prøv ruting på nytt mot dagens lager. Kansellering er bare en lenke til Shopify – refusjon gjøres av et menneske. Alle `v_admin_*`-view filtrerer på `is_garnly_admin()` og gir butikkbrukere null rader.
7. **Regler som aldri brytes**: hele antallet av én varelinje kommer fra samme butikk (garnparti). Hele ordren fra én butikk foretrekkes; kan splittes per varelinje hvis ingen har alt. Aktivt avslag straffes ikke; timeout gir 24 t nedvekting (maks 3).

## Stack

- Supabase (eget prosjekt `zesaeleooiptrpjzqhxe`, adskilt fra Garnly-appens prosjekt): Postgres + Edge Functions (Deno/TypeScript) + pg_cron.
- Shopify Admin GraphQL API 2025-07. Alle mutasjoner i `_shared/shopify.ts` er validert mot skjemaet.
- Ingen n8n. Ingen Airtable. Ingen regneark som kilde.

## Struktur

```
supabase/migrations/      001 schema, 002 cron, 003 exclude_from_sync, 004 inventory_activated,
                          005 pos_catalog, 006 cron pos-catalog, 007 product_aliases, 008 store_panel,
                          009 group_resplit, 010 oppgjor, 011 rls, 012 cron sync-products,
                          013 pos_deduction, 014 fulfillment fra Shopify,
                          015 group_fulfilled, 016 lager-avstemming, 017 cron reconcile,
                          018 testordrer, 019 cargonizer-etikett,
                          020 mark_pos_deducted fulfilled, 021 panel-historikk,
                          022 cargonizer-overføring, 023 panelsending,
                          024 kort forsvinner ved sending, 025 garnly-admin,
                          026 cron ops-digest, 027 directprint bare Garnly,
                          028 feilet sending til admin, 029 hentested + manuell sending,
                          030 view- og funksjonstilgang (anon ut),
                          031 oppgjør: refusjoner, utbetalinger, regnebok,
                          032 etikett i «Til pakking» + sletting ved kansellering,
                          033 svarfrist 5 timer
supabase/seed/            product_aliases.sql (varer uten brukbar EAN, kjøres etter første sync-products)
panel/                    butikkpanelet (statisk side, Vercel med rot `panel/`).
                          garnly-butikkpanel.vercel.app – deployes av git push
supabase/functions/
  _shared/adapters/       PosAdapter-grensesnitt + duell.ts, mystore.ts, csv.ts
  _shared/shopify.ts      GraphQL-klient (inventory, fulfillment orders, webhooks)
  _shared/routing.ts      REN logikk: planGroups (splitt), deadlineWithinBusinessHours
  _shared/matching.ts     REN logikk: matchLines (EAN → alias → SKU → navn → garnnavn + fargekode)
  _shared/schedule.ts     REN logikk: når en butikk er due (nattintervall + grace)
  _shared/inventory.ts    REN logikk: salgbart antall (buffer + ventende kassauttrekk)
  _shared/fulfillment.ts  REN logikk: kobler Shopify-sendinger til grupper
  _shared/testorder.ts    REN logikk: er ordren en testordre (tag TEST / order.test)
  _shared/fulfillment_sync.ts  henter fulfilled_at fra Shopify (webhook + backstop)
  _shared/transfer_sync.ts     overfører Cargonizer-sendingen til transportøren (webhook + backstop), eller merker «sendt manuelt»
  _shared/ship.ts              «Slått ut og klar til sending»: uttrekk → sending → fulfillment → overføring → etikett
  _shared/sending.ts           sendingen i Cargonizer for én gruppe: finn eller lag (alltid transfer=false), låst per gruppe
  _shared/etikett.ts           etikett-ikonet: lager sendingen i «Til pakking», skriver ut eller gir PDF
  _shared/annullering.ts       kansellert ordre → slett uoverført sending, ellers «Trenger handling» (+ backstop)
  _shared/shipping/consignment.ts  REN logikk: consignment-XML, vekt, sporingsnummer, mobilnummer
  _shared/lines.ts        REN logikk: varelinja butikken plukker fra (variant, EAN, SKU, garnpakkeinnhold)
  _shared/settlement.ts   REN logikk: hvor mye refundert varebeløp som trekkes fra hvilken gruppe/butikk
  _shared/refund_sync.ts  refusjon fra Shopify → settlement_adjustments (webhook + backstop), registrerer webhooken
  _shared/offers.ts       makeNextOffer, escalateGroup, refreshOrderStatus
  _shared/shipping/       cargonizer.ts (finn sending + hent etikett-PDF), bookShipment, shipmondo.ts
  sync-store/             cron: kassesystem → inventory → Shopify (+ metafelt garnly.stock_by_store)
  sync-products/          Shopify-varianter → products-tabellen (+ slår på inventory tracking)
  order-intake/           webhook orders/paid → hold → planGroups → offers
  offer-respond/          svar fra panelet (POST + bruker-JWT), engangslenke (GET) og internt kall
  timeout-sweeper/        cron hvert minutt
  order-cancelled/        webhook orders/cancelled; sletter uoverført sending (+ backstop-cron)
  order-refunded/         webhook refunds/create → trekk i oppgjøret; nattlig backstop (cron 04:50 UTC)
  fulfillment-webhook/    webhook fulfillments/create → fulfilled_at (CargonizerConnect fulfiller)
  pos-webhook/            Mystore products/update → trigger synk
  pos-catalog/            daglig cron: Duells product/list → pos_catalog (strekkoder)
  reconcile-inventory/    nattlig cron: leser on_hand fra Shopify og retter avvik
  shipping-label/         etikett-ikonet: lager sendingen i «Til pakking», PDF eller DirectPrint (bruker-JWT)
  ship-order/             panelknappen «Slått ut og klar til sending» (bruker-JWT)
  store-settings/         butikkens egen innstilling: auto-godkjenning (bruker-JWT)
  backfill-lines/         vedlikehold: etterfyller varelinjer med felt som kom til senere
  admin-actions/          Garnly-admin: gi ordren til en butikk, prøv ruting på nytt (admin-JWT)
  ops-digest/             daglig cron kl. 08: e-post hvis noe står i «Trenger handling» (også feilede sendinger)
scripts/                  set-barcodes.ts, import-products.ts, backfill-store-inventory.ts, enable-tracking.ts
dashboard/                Next.js admin-dashboard (Vercel): oversikt, ordrer, umatchet, lager, synk
shopify-app/              Shopify Function: kassevalidering «ett parti fra én butikk» (§7)
```

## Regler for arbeid i repoet

- **Ren logikk skal være testbar uten I/O.** Rutingsregler i `routing.ts`, matching i `matching.ts`. Ikke legg forretningslogikk i `index.ts`-filene.
- **Kjør `deno task check` og `deno task test` før hver commit.** CI kjører det samme.
- **Ny adapter** = én ny fil i `_shared/adapters/`, registrert i `index.ts`. Ingenting annet skal endres.
- **Hemmeligheter** ligger i `store_secrets`-tabellen (per butikk) eller i Edge Function secrets. Aldri i kode, aldri i `pos_config`.
- **Shopify-mutasjoner**: valider nye operasjoner mot skjemaet (Shopify MCP `validate_graphql_codeblocks` eller Shopify GraphiQL) før bruk.
- **Destruktive operasjoner mot Shopify** (arkivere produkter, slette locations, nullstille lager for alle) krever eksplisitt bekreftelse fra Embrik i samme melding.
- **Språk**: kode og identifikatorer på engelsk, kommentarer, meldinger til butikker og dokumentasjon på norsk.
- **Panelet skal aldri gjøre forretningslogikk.** Godta/avslå går via `offer-respond`, sending via `ship-order`. Serveren eier lagersjekk, Shopify-flytting, fraktbestilling og fulfillment. Panelet leser, viser og trykker.
- **Admin-tilgang sjekkes to steder.** Viewene filtrerer på `is_garnly_admin()`, men et endepunkt som *endrer* noe (`admin-actions`) må sjekke `garnly_admins` eksplisitt – et view som gir null rader skjuler data, men stopper ingen POST.
- **Butikkens innstillinger lagres via `store-settings`**, aldri rett på tabellen: panelet har ikke skriverett på `stores`, og endringer som auto-godkjenning skal i revisjonsloggen.
- **Fraktoppsett ligger i `stores`**, ikke i koden: `shipping_sender_id`, `shipping_transport_agreement`, `shipping_product`, `shipping_product_fallback`, `directprint_printer_id`. Skriveren settes bare av Garnly, aldri av butikken. Avtale-id-ene er ulike per butikk, og et transportørbytte skal ikke kreve ny utrulling.
- **Varelinjene skal kunne plukkes uten oppslag.** `line_items` lagrer variant, SKU, strekkode og garnpakkeinnhold ved ordremottak (`_shared/lines.ts`). Produktbilde ble prøvd og tatt bort igjen: butikken plukker på navn, farge og strekkode. Nye felt der krever en kjøring av `backfill-lines` for ordrer som alt ligger i panelet.
- **Nye view og funksjoner i `public` er åpne for `anon` til du sier noe annet.** Supabase gir anon og authenticated tilgang til alt nytt der, og anon-nøkkelen står i `panel/config.js`. Et view er enten `security_invoker = true`, eller kjører som eier og filtrerer selv på `current_store_ids()` / `is_garnly_admin()` – og får `revoke all ... from anon` uansett. En funksjon får `revoke execute ... from public, anon` (og `authenticated` hvis bare Edge Functions/cron kaller den) og `set search_path = public`. Se 030. Linteren flagger de ni panel/admin-viewene som «security definer» – det er bevisst.
- **Oppgjøret regnes i databasen, ett sted.** Provisjon og øreavrunding for både salg og refusjon står i `settlement_ledger` og triggeren på `settlement_adjustments` – ikke i TypeScript, ikke i panelet. Får panelet en oppgjørsvisning igjen, viser den tallene derfra; det summerer ingenting som noen betaler etter. En utbetaling angres ved å annullere raden (`annullert_at`), ikke ved å slette den.
- **Supabase-koblingen (MCP) stopper SQL med DROP eller DELETE** til noen bekrefter i appen, og går ut på tid etter 60 s hvis ingen gjør det. Skriv migrasjoner uten dem når det går, eller be Embrik kjøre dem.
- **Ikke legg kundedata i panel-viewene** utover det butikken trenger for å pakke og sende. `routing_orders.raw_order` skal aldri eksponeres.
- **Ikke gjett på kassesystem-API-er.** Begge adaptere er verifisert mot ekte data (sept. 2026, Mystore-fargen 09.10.2026); feltnavn står i filhodene. Ved avvik: logg en rå eksempelrad og juster.
- **Sortimentet styres i Shopify.** Aldri opprett produkter i Shopify fra butikkdata. Nye produkter legges inn av Embrik/Halvor; `sync-products` plukker dem opp.

## Status og åpne punkter

Se `docs/STATUS.md`. Oppdater den når noe blir avklart eller bygget.
**Skal du deploye eller ta over arbeidet: les `docs/OPPDRAG_CLAUDE_CODE.md` først.**
Den sier hvor vi står, hva som er endret, og i hvilken rekkefølge ting må gjøres.
