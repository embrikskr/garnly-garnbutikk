# Garnly garnbutikk – instruksjoner til Claude Code

Dette repoet er backend for Garnlys felles nettbutikk for lokale garnbutikker. Les `docs/Garnly_Garnbutikk_Byggeplan_v1.md` før du gjør noe større. Den er sannheten for arkitektur og beslutninger; avvik skal først inn i planen, deretter i koden.

## Hva systemet gjør

1. **Lagersynk**: leser lager fra partnerbutikkenes kassesystemer (Duell, Mystore, CSV) hvert 15. minutt, matcher mot Garnlys produkter på EAN/SKU/navn, og skriver antall til butikkens *location* i Garnlys Shopify (`kycbgs-yy.myshopify.com`).
2. **Ordreruting**: når en kunde betaler i Shopify, settes ordren på hold, og den tilbys én butikk om gangen (round-robin på `last_assigned_at`). Butikken godtar/avslår via lenke i e-post/SMS innen en frist (i åpningstid). Ved aksept flyttes fulfillment order til butikkens location og frakt bookes.
3. **Regler som aldri brytes**: hele antallet av én varelinje kommer fra samme butikk (garnparti). Hele ordren fra én butikk foretrekkes; kan splittes per varelinje hvis ingen har alt. Aktivt avslag straffes ikke; timeout gir 24 t nedvekting (maks 3).

## Stack

- Supabase (eget prosjekt `zesaeleooiptrpjzqhxe`, adskilt fra Garnly-appens prosjekt): Postgres + Edge Functions (Deno/TypeScript) + pg_cron.
- Shopify Admin GraphQL API 2025-07. Alle mutasjoner i `_shared/shopify.ts` er validert mot skjemaet.
- Ingen n8n. Ingen Airtable. Ingen regneark som kilde.

## Struktur

```
supabase/migrations/      001_schema.sql (tabeller, RPC-er, views), 002_cron.sql
supabase/functions/
  _shared/adapters/       PosAdapter-grensesnitt + duell.ts, mystore.ts, csv.ts
  _shared/shopify.ts      GraphQL-klient (inventory, fulfillment orders, webhooks)
  _shared/routing.ts      REN logikk: planGroups (splitt), deadlineWithinBusinessHours
  _shared/matching.ts     REN logikk: matchLines (EAN → SKU → navn)
  _shared/offers.ts       makeNextOffer, escalateGroup, refreshOrderStatus
  _shared/shipping/       bookShipment + shipmondo.ts
  sync-store/             cron: kassesystem → inventory → Shopify (+ metafelt garnly.stock_by_store)
  sync-products/          Shopify-varianter → products-tabellen
  order-intake/           webhook orders/paid → hold → planGroups → offers
  offer-respond/          godta/avslå-lenker (HTML) + intern POST
  timeout-sweeper/        cron hvert minutt
  order-cancelled/        webhook orders/cancelled
  pos-webhook/            Mystore products/update → trigger synk
```

## Regler for arbeid i repoet

- **Ren logikk skal være testbar uten I/O.** Rutingsregler i `routing.ts`, matching i `matching.ts`. Ikke legg forretningslogikk i `index.ts`-filene.
- **Kjør `deno task check` og `deno task test` før hver commit.** CI kjører det samme.
- **Ny adapter** = én ny fil i `_shared/adapters/`, registrert i `index.ts`. Ingenting annet skal endres.
- **Hemmeligheter** ligger i `store_secrets`-tabellen (per butikk) eller i Edge Function secrets. Aldri i kode, aldri i `pos_config`.
- **Shopify-mutasjoner**: valider nye operasjoner mot skjemaet (Shopify MCP `validate_graphql_codeblocks` eller Shopify GraphiQL) før bruk.
- **Destruktive operasjoner mot Shopify** (arkivere produkter, slette locations, nullstille lager for alle) krever eksplisitt bekreftelse fra Embrik i samme melding.
- **Språk**: kode og identifikatorer på engelsk, kommentarer, meldinger til butikker og dokumentasjon på norsk.
- **Ikke gjett på kassesystem-API-er.** Duell-feltnavn for EAN er uverifisert (se `duell.ts` pickEan). Logg en rå eksempelrad ved første ekte synk og juster.

## Status og åpne punkter

Se `docs/STATUS.md`. Oppdater den når noe blir avklart eller bygget.
