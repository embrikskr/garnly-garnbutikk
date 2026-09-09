# Garnly garnbutikk – instruksjoner til Claude Code

Dette repoet er backend for Garnlys felles nettbutikk for lokale garnbutikker. Les `docs/Garnly_Garnbutikk_Byggeplan_v1.md` før du gjør noe større. Den er sannheten for arkitektur og beslutninger; avvik skal først inn i planen, deretter i koden.

## Hva systemet gjør

1. **Lagersynk**: leser lager fra partnerbutikkenes kassesystemer (Duell, Mystore, CSV) hvert 15. minutt, matcher mot Garnlys produkter på EAN → alias (`product_aliases`) → SKU → navn, og skriver antall til butikkens *location* i Garnlys Shopify (`kycbgs-yy.myshopify.com`).
2. **Ordreruting**: når en kunde betaler i Shopify, settes ordren på hold, og den tilbys én butikk om gangen (round-robin på `last_assigned_at`). Butikken svarer i **butikkpanelet** (`panel/`, ligger på butikk.garnly.no) innen en frist (i åpningstid). Ved aksept flyttes fulfillment order til butikkens location og frakt bookes.
3. **Butikkpanel**: en side butikken har oppe på nettbrettet. Sanntid via Supabase Realtime på `offers`, innlogging med Supabase Auth, tilgang styrt av `store_users` + RLS. E-post per tilbud er AV som standard (`stores.notify_offers`); det skalerer ikke når en butikk får titalls ordrer om dagen.
4. **Regler som aldri brytes**: hele antallet av én varelinje kommer fra samme butikk (garnparti). Hele ordren fra én butikk foretrekkes; kan splittes per varelinje hvis ingen har alt. Aktivt avslag straffes ikke; timeout gir 24 t nedvekting (maks 3).

## Stack

- Supabase (eget prosjekt `zesaeleooiptrpjzqhxe`, adskilt fra Garnly-appens prosjekt): Postgres + Edge Functions (Deno/TypeScript) + pg_cron.
- Shopify Admin GraphQL API 2025-07. Alle mutasjoner i `_shared/shopify.ts` er validert mot skjemaet.
- Ingen n8n. Ingen Airtable. Ingen regneark som kilde.

## Struktur

```
supabase/migrations/      001 schema, 002 cron, 003 exclude_from_sync, 004 inventory_activated,
                          005 pos_catalog, 006 cron pos-catalog, 007 product_aliases, 008 store_panel
supabase/seed/            product_aliases.sql (varer uten brukbar EAN, kjøres etter første sync-products)
panel/                    butikkpanelet (statisk side, deployes til butikk.garnly.no)
supabase/functions/
  _shared/adapters/       PosAdapter-grensesnitt + duell.ts, mystore.ts, csv.ts
  _shared/shopify.ts      GraphQL-klient (inventory, fulfillment orders, webhooks)
  _shared/routing.ts      REN logikk: planGroups (splitt), deadlineWithinBusinessHours
  _shared/matching.ts     REN logikk: matchLines (EAN → alias → SKU → navn)
  _shared/offers.ts       makeNextOffer, escalateGroup, refreshOrderStatus
  _shared/shipping/       bookShipment + shipmondo.ts
  sync-store/             cron: kassesystem → inventory → Shopify (+ metafelt garnly.stock_by_store)
  sync-products/          Shopify-varianter → products-tabellen (+ slår på inventory tracking)
  order-intake/           webhook orders/paid → hold → planGroups → offers
  offer-respond/          svar fra panelet (POST + bruker-JWT), engangslenke (GET) og internt kall
  timeout-sweeper/        cron hvert minutt
  order-cancelled/        webhook orders/cancelled
  pos-webhook/            Mystore products/update → trigger synk
  pos-catalog/            daglig cron: Duells product/list → pos_catalog (strekkoder)
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
- **Panelet skal aldri gjøre forretningslogikk.** Godta/avslå går alltid via `offer-respond`, som eier lagersjekk, Shopify-flytting og frakt. Panelet leser og viser, ikke noe mer.
- **Ikke legg kundedata i panel-viewene** utover det butikken trenger for å pakke og sende. `routing_orders.raw_order` skal aldri eksponeres.
- **Ikke gjett på kassesystem-API-er.** Begge adaptere er verifisert mot ekte data (sept. 2026); feltnavn står i filhodene. Ved avvik: logg en rå eksempelrad og juster.
- **Sortimentet styres i Shopify.** Aldri opprett produkter i Shopify fra butikkdata. Nye produkter legges inn av Embrik/Halvor; `sync-products` plukker dem opp.

## Status og åpne punkter

Se `docs/STATUS.md`. Oppdater den når noe blir avklart eller bygget.
**Skal du deploye eller ta over arbeidet: les `docs/OPPDRAG_CLAUDE_CODE.md` først.**
Den sier hvor vi står, hva som er endret, og i hvilken rekkefølge ting må gjøres.
