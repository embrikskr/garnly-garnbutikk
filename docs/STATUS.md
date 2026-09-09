# Status – garnly-garnbutikk

Oppdatert: 2026-09-09

## Nå (09.09.2026, kveld)

**Backenden kjører.** Cron hvert 5. minutt, 242 vellykkede synkkjøringer.
Butikkpanelet, alias-matchingen og Duell-synken er slått sammen med det som
allerede sto i drift, og migrasjonene 003–008 er kjørt.

| Butikk | Kassesystem | Rader lest | Matchet | Med lager | Status |
|---|---|---|---|---|---|
| Strikkefryd | Mystore | 5262 | 1565 | 1488 varianter i Shopify | live siden 05.09 |
| Garnkilden | Duell | 6010 | 1341 | 1167 varer, 15 437 enheter | tørrkjørt, **ikke skrevet til Shopify** |

### Garnkilden virker nå

Tre ting sto i veien, alle løst:

1. **WAF.** `api.kasseservice.no` blokkerer datasenter-IP-er. Kallene rutes nå
   gjennom en tinyproxy på en Oracle Always Free-maskin (79.76.60.202) som Duell
   har hvitelistet. `DUELL_PROXY_URL` i function-secrets. Gratis, fast IP,
   dekker alle Duell-butikker – ikke én proxy per butikk.
2. **Sideblading.** Duell kapper sider til 100 rader uansett hva `length` sier.
   Adapteren flyttet `start` med ønsket sidestørrelse (500) og hoppet dermed over
   fire av fem rader: Garnkilden ga 700 av 3345 rader. Retter man dette, leses
   alle 6010.
3. **Manglende strekkode.** `all/product/stock` gir verken strekkode eller navn,
   bare `product_id` og antall – derfor matchet 0 av 700. Strekkoden ligger i
   `product/list` (6010 produkter, 5098 med strekkode). Den er klient-omfattende
   og tar ~2 minutter å bla gjennom, så den mellomlagres i tabellen `pos_catalog`
   og friskes opp daglig av den nye `pos-catalog`-funksjonen. Lager og katalog
   kobles på `product_id`; `product_number` er ikke unikt og duger ikke som nøkkel.

De 2357 garnvarene som fortsatt ikke matcher, er garn Garnkilden fører men som
Garnly ikke har i sortimentet. Det er en sortimentsbeslutning, ikke en feil.
Knapper, pinner og oppskrifter (1900 varer) skal heller ikke matche.

### Dette må avgjøres før Garnkilden kan skrives til Shopify

`stores.active` for Garnkilden står på **false**. Skriver vi lageret til Shopify
uten å aktivere butikken, blir varene kjøpbare uten at rutingen kan tilby dem til
noen: en kunde kan kjøpe noe bare Garnkilden har, og ordren blir stående. De to
tingene må skje samtidig. Sier Embrik ja, er det én SQL-oppdatering og én
synkkjøring uten `dry_run`.

### Varsling har ingen mottaker ennå

Migrasjon 008 setter `notify_offers` til false, fordi butikkene skal svare i
panelet. Panelet er ikke deployet (krever Cloudflare Pages), og `RESEND_API_KEY`
er tom. Et tilbud ville altså ikke nådd noen. `notify_offers` er derfor satt til
**true** på begge butikker inntil panelet er ute. Ingen ordrer har kommet ennå,
så ingenting er gått tapt. Sett den tilbake til false når panelet er live.

### Kjent svakhet

21 synkkjøringer står som `running` og ble aldri avsluttet, alle Strikkefryd,
fra 06.09 og utover. Bakgrunnsjobben (`EdgeRuntime.waitUntil`) blir av og til
gjenvunnet før den er ferdig. Neste cron-kjøring tar det igjen, så lageret blir
riktig, men `sync_runs` viser feil bilde. Bør ryddes med en tidsavbrudd-markering.

---

## Deployet 04.09.2026
- Supabase `zesaeleooiptrpjzqhxe`: skjema (001) + cron (002) kjørt, 3 cron-jobber aktive.
  `functions_url`/`cron_secret` ligger i **Vault** (ALTER DATABASE ... SET er ikke tillatt på Supabase).
- Alle 7 Edge Functions deployet, 21 secrets satt. `timeout-sweeper` testet OK ende-til-ende.
- Shopify-app «Garnly ruting» på nye Dev Dashboard-plattformen (client credentials-grant, ikke fast
  token). Client ID/secret i function-secrets; backenden fornyer token selv. Webhook-API 2026-07,
  Admin API satt til 2026-07.
- Webhooks opprettet via API: ORDERS_PAID → order-intake, ORDERS_CANCELLED → order-cancelled.
- Locations finnes allerede i Shopify: «Strikkefryd (Mjøndalen)» (gid .../125074604318),
  «Garnkilden (Stavanger)» (gid .../125074637086) + Shop location.
- Dashboard live på Vercel (garnly-garnbutikk.vercel.app, HTTP Basic).
## Strikkefryd LIVE 05.09.2026
- Strikkefryd (Mystore, shop=strikkefryd) lagt inn i stores/store_secrets. Location
  «Strikkefryd (Mjøndalen)» gid .../125074604318. Kontakt = embriks e-post i pilot.
- sync-products: 3690 varianter speilet (1721 med EAN). Bare garn synkes – 23 «Yarn kit»
  ekskludert (exclude_from_sync, migrasjon 003).
- Mystore-adapter rettet mot ekte felt (name-objekt, ikke products_name; status/disabled filtreres).
- **Lager skrevet til Shopify**: 1488 garnvarianter med lager aktivert + lagersporing på +
  antall satt på Strikkefryd-location, og metafelt garnly.stock_by_store satt. Verifisert i Shopify
  (Peer Gynt 1042 = 59 stk osv.). 5262 rader lest, 1565 matchet, resten (oppskrifter/gavekort/ikke-ført) i unmatched_items.
- Videre lagerendringer håndteres av cron hvert 15. min.

## Gjort 02.09.2026 (Cowork)
- Strikkefryd (Mystore) API testet live: 2131 produkter, 4918 varianter, ~88 % med EAN, 3530 varianter med lager.
- Strikkefryds katalog matchet mot Garnly2 på garnlinje + fargekode: **1381 EAN-er skrevet inn som `barcode` på Garnly2-varianter** (av 3667 garnvarianter). Rapport: `docs/barcode_match_rapport.csv`.
- Resten uten strekkode er i hovedsak linjer Strikkefryd ikke fører (Hillesvåg, Isager, deler av Dale/Rauma) → EAN hentes fra Duell-butikken eller produsentlister senere.
- Strikkefryd-token skal inn i `store_secrets` ved deploy; be butikken lage ny token når integrasjonen er i drift (denne har vært delt i chat).
- Fortsatt i Shopify: lager ikke sporet på variantene (settes av inventoryActivate ved første synk), ingen SKU, én location, ingen webhooks.

## Gjort 03.09.2026 (Cowork)
- Duell-butikken er **Garnkilden AS** (Stavanger). API verifisert fra Embriks maskin: login, `department/list` (api_token for avdeling 1), `product/list` (6 001 produkter, 3 107 garn, 85 % med EAN) og `all/product/stock`.
- Duell-adapteren skrevet om etter ekte API: strekkode ligger i `product/list`, lager i `all/product/stock`, maks 100 rader/side, paginer på mottatte rader. `listDepartments()` for onboarding.
- Garnkilden matchet mot Garnly2: 824 varianter identiske med Strikkefryd (bekrefter forrige runde), **340 nye EAN-er skrevet** (Finull, Vams, Pandora, Fivel, Alpaca Silk, Mitu m.fl.), 8 konflikter beholdt Strikkefryd-verdien (se `docs/barcode_match_rapport_garnkilden.csv`).
- Totalt nå: ~1 720 av 3 667 garnvarianter har strekkode. De ~1 950 uten er Filcolana (Arwetta, Peruvian, Saga, Vilja, Tilia, Anina, Pernilla, Alva-rest), Hillesvåg (Ask, Troll, Luna, Huldra, Sol, Vilje, Vidde) og Ryegarn: ingen av de to butikkene fører dem.
- **WAF-advarsel:** api.kasseservice.no svarer med AWS WAF-captcha til skyservere (Cowork-containeren ble blokkert). Fra Embriks Mac gikk alt. Må testes fra Supabase Edge Functions ved deploy; fallback = be support@duell.no hvitliste, eller proxy.
- Duell-tokens er IP-bundet (`ip`-claim i JWT); hver kjøremiljø må logge inn selv (adapteren gjør det).

## Gjort 06.09.2026 (Cowork)
- Embrik/Halvor la inn **57 nye produkter / 1 348 varianter** i Shopify 05.09 (Isager, Ístex, Cardiff, Lana Grossa, Permin, Rauma, Rowan, Solberg, Viking), alle DRAFT, med EAN som både `sku` og `barcode`. Ingen EAN-kollisjoner med de 133 eldre produktene.
- Dekning mot butikkene (`docs/sortiment_dekning_2026-09-06.csv`): **1 275 varianter matcher på EAN** (Strikkefryd 435, Garnkilden 917, begge 77). 69 av de 73 uten strekkode er koblet via `product_aliases` (Cardiff Classic/Prime hos Garnkilden har bare interne koder som «18379», Strikkefryd har ingen EAN på dem). 4 finnes ikke hos noen: Classic 739 Japan Blue, Spinni «3» (ufullstendig tittel), Plötulopi 0417 Red, Tumi B137 Korallrød.
- Viktig funn: Duell leverer noen EAN-er som GTIN-14 med ledende null (`05744003423439`). `normalizeEan` håndterer det; egne analyser må gjøre det samme.
- Lokasjoner i Shopify: Strikkefryd (Mjøndalen) `gid://shopify/Location/125074604318`, Garnkilden (Stavanger) `gid://shopify/Location/125074637086`. Fortsatt ingen lagersporing på noen varianter (5 203); `sync-products` slår det på ved første kjøring.
- Sortimentsregneark (Garnly_sortiment_Strikkefryd_Garnkilden.xlsx) ligger på Embriks Mac i ~/Garnly; garnlinje-versjonen som Google Sheet i Drive «Garnly → AI → Garnly».

## Gjort 09.09.2026 (Cowork)
- **Butikkpanel bygget** (`panel/`). E-post per tilbud skalerer ikke: en butikk med 50 ordrer om dagen får 50 e-poster, og fristene begynner å gå ut. Erstattet med en side butikken har oppe på nettbrett ved pakkebordet.
  - Sanntid via Supabase Realtime på `offers`, polling hvert 30. sekund som reserve, lyd og telling i fanetittel ved ny ordre, wake lock så skjermen ikke sovner.
  - Innlogging med Supabase Auth (e-post + passord). `store_users` + RLS gir butikken kun sine egne rader. Views `v_panel_queue`, `v_panel_assigned`, `v_panel_stats` skjuler `raw_order` og resten av kundedataene.
  - Godta/avslå går til `offer-respond` med bruker-JWT. Funksjonen fikk tre inngangsveier: panel (POST + JWT), engangslenke (GET, reserve) og internt kall (auto_accept). All logikk er delt.
  - «Godta alle» for kø, nedtelling per ordre som skifter farge når det er under en time og under et halvt igjen.
- `stores.notify_offers` (default false) skrur av e-post og SMS per tilbud. `notifyOps` til Garnly står igjen, det er intern varsling og ikke butikkspam.
- Shopify: to butikklokasjoner manglet i fraktprofilen, derfor viste hele butikken utsolgt selv med lager inne. Lagt inn, testet handlekurv og fraktrater. Garnpakkene fikk lagersporing av, siden de settes sammen av garn butikken allerede har.

## Kjente forbedringspunkter (ikke-blokkerende)
- Første synk av en ny butikk gjøres med `deno task backfill-store <slug>` (tung aktivering
  tåler ikke Edge Function-tidsbudsjettet). sync-store bør senere gjøres chunk-gjenopptakbar
  så onboarding skjer uten manuelt steg. Backfill er gjenopptakbar og idempotent.
- Migrasjoner kjøres mot prosjektet via Management API (001–008). Vault holder functions_url/cron_secret.
- Migrasjonsnumrene 003 og 004 fantes i to versjoner. De som er kjørt i produksjon beholdt
  numrene (`003_exclude_from_sync`, `004_inventory_activated`); panel og alias ble flyttet til
  007 og 008.

## Blokkerende avklaringer
1. Frakt: Shipmondo vs Cargonizer (Logistra) – fortsatt åpent.
2. EAN for Filcolana/Hillesvåg/Ryegarn: tredje butikk eller produsentlister.
3. Skal Garnkilden aktiveres og lageret skrives til Shopify? Se over.

## Ikke deployet ennå (krever tilganger)
- **Butikkpanelet** (`panel/`): `npx wrangler pages deploy panel --project-name garnly-butikkpanel`
  krever Cloudflare-innlogging. anon-nøkkelen er lagt inn i `panel/config.js`. Etterpå:
  `supabase secrets set PANEL_ORIGIN=https://butikk.garnly.no`, CNAME, og en bruker per butikk
  i Supabase Auth + rad i `store_users`.
- **Validation Function**: `shopify app deploy` fra `shopify-app/` (krever Shopify CLI-innlogging),
  deretter aktiveres valideringen i Shopify admin → Settings → Checkout.
- **Ikon** `panel/icon.png` (512×512) for hjemskjerm på nettbrett.

## Ikke bygget ennå
- Partnerside med innlogging (fase 2)

---

