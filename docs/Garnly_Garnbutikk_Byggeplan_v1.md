# Garnly – Garnbutikken: teknisk byggeplan

**Versjon 1.0 · 27. august 2026 · Utkast til Embrik og Halvor**
Bygger videre på `Garnly_Ordreruting_Teknisk_Oppsett.md` (v0.1) og `Garnly_Ordrefordeling_Logikk.md` (v0.2). Der denne planen avviker fra de to, gjelder denne.

---

## 0. Hva som er endret siden juli-dokumentene

| Tema | Juli 2026 | Nå |
|---|---|---|
| Orkestrering | n8n | **Supabase Edge Functions + pg_cron** (n8n utgår) |
| Database | Supabase/Postgres (evt. Airtable i fase 0) | **Eget Supabase-prosjekt for garnbutikken**, adskilt fra app-/oppskriftsdatabasen |
| Lagerkilde | Lager vedlikeholdes i Shopify per location | **Butikkenes kassesystemer er kilden.** Garnly leser Duell, Mystore m.fl. og skriver til Shopify |
| Hele ordren fra én butikk | Absolutt krav, ellers eskalering | **Foretrukket, ikke absolutt.** Ufravikelig regel: hele antallet av én varelinje fra samme butikk (garnparti). Ordren kan splittes per varelinje mellom butikker hvis ingen har alt |
| Frist for butikk | 60 min | **Noen timer** (konfigurerbar, foreslått 3 t i åpningstid) |

Alt annet står: Garnly er merchant of record i én sentral Shopify, butikkene er locations, tilbud går sekvensielt til én butikk om gangen, round-robin på `last_assigned_at`, timeout gir nedvekting, avslag straffes ikke, kunden betaler frakt, Shipmondo (eller Cargonizer) via API.

---

## 1. Målbilde i én setning

Kunden handler i Garnlys Shopify. Hvert 15. minutt leser Garnly lageret i hver partnerbutikks kassesystem og speiler det inn på butikkens location i Shopify. Når en kunde betaler, finner Garnly butikken(e) som kan levere, tilbyr ordren én butikk om gangen med frist, og butikken som godtar får etikett og sender.

---

## 2. Arkitektur

```
Kassesystemer                    Garnly backend (Supabase, eget prosjekt)          Shopify (Garnly)
┌──────────┐  pull hvert 15 min  ┌─────────────────────────────────────┐          ┌──────────────┐
│ Duell    │ ──────────────────► │ sync-duell      ┐                   │ inventory │ Locations:   │
│ Mystore  │ ──────────────────► │ sync-mystore    ├─► inventory-tabell├─────────► │  Nøstet Mitt │
│ (neste)  │  webhook/pull       │ sync-<system>   ┘        │          │ SetQty    │  Garnkilden  │
└──────────┘                     │                          ▼          │          │  Strikkefryd │
                                 │   stores · products · inventory     │          │  …           │
                                 │   routing_orders · offers · audit   │ orders/  │              │
                                 │                          ▲          │ paid     │ Checkout +   │
                                 │ order-intake ◄───────────┼──────────┼───────── │ validering   │
                                 │ make-offer → varsel ─────┼─► e-post/SMS        │ (Function)   │
                                 │ offer-respond ◄──────────┼── butikk klikker    │              │
                                 │ timeout-sweeper (cron)   │          │ FO hold/ │              │
                                 │ ship (Shipmondo API) ────┼──────────┼─► move/  │              │
                                 └──────────────────────────┼──────────┘ release  └──────────────┘
                                                            ▼
                                                   Admin-dashboard (Next.js/Vercel)
```

**Prinsipp:** Shopify er butikken kunden ser og hovedboken for ordre og lager per location. Supabase er motoren og sannheten for ruting, tilbud, frister og synk-status. Kassesystemene er sannheten for fysisk lager.

---

## 3. Hvorfor eget Supabase-prosjekt

- Feil, brudd eller re-synk i garnbutikken rammer aldri brukere, oppskrifter eller designeroppgjør i app-prosjektet.
- Utviklere og partnere kan få tilgang til garnbutikk-prosjektet uten å komme nær persondata i appen.
- Ulike lastprofiler: appen er lese-tung med persondata, garnbutikken er skrive-tung med maskindata hvert 15. minutt.
- Kobling app → garnbutikk («hvem har garnet til denne oppskriften») løses som et lite lese-API eller lenke til Shopify-produktet. Enveis, lesende, ingen felles database.

Kostnad: to prosjekter på Pro-plan er 2 × 25 USD/mnd. Garnbutikken kan starte på gratisplan i pilot.

**Volum, for ordens skyld:** 5 000 produkter × 10 butikker = 50 000 lagerrader. En full synk skriver dette på sekunder. Postgres håndterer dette som en liten database.

---

## 4. Kassesystem-adaptere

Én adapter per system, felles grensesnitt. Adapteren har bare én jobb: returnere `[{ ean, sku, quantity }]` for én butikk.

```ts
interface PosAdapter {
  system: 'duell' | 'mystore' | ...;
  fetchStock(store: StoreConfig): Promise<Array<{ ean: string | null; sku: string | null; qty: number }>>;
}
```

### 4.1 Duell (verifisert mot Duells egen WooCommerce-integrasjon på GitHub)

| | |
|---|---|
| Base-URL | `https://api.kasseservice.no/v1/` |
| Innlogging | `POST getaccesstokens` med `client_number` + `client_token` (fra Duell Admin → System → Integrasjoner → API-oppsett) → Bearer-token. Token caches, fornyes ved 401 |
| Lager | `GET all/product/stock?department=<department_token>&length=<n>&start=<offset>&filter[view_on_webshop]=true` |
| Respons | `{ status, total_count, data: [ { product_number, department: [ { stock } ], … } ] }` |
| Produktoppslag | `GET product/list?filter[product_number]=…` (bruk for å hente strekkode/EAN og navn ved første synk) |
| Paginering | `start`/`length`, Duells eget plugin bruker pause på 0,5 s mellom sider |
| Full dokumentasjon | `https://api.kasseservice.no/docs` (bak captcha, må åpnes i nettleser) |

Merk: `department` er butikkens avdelings-token i Duell. Én Duell-konto kan ha flere avdelinger (= flere fysiske butikker). Hver avdeling blir én Garnly-`store` og én Shopify-location. **Må verifiseres:** hvilket felt som gir EAN i `all/product/stock` (om det mangler, hent fra `product/list` én gang og cache).

### 4.2 Mystore / Acendy API (verifisert mot API-blueprint)

| | |
|---|---|
| Base-URL | `https://api.mystore.no/shops/<butikknavn>/` |
| Innlogging | Personlig tilgangstoken (gyldig 10 år) fra `https://auth.mystore.no`, eller OAuth-app. Header `Authorization: Bearer …`, `Accept: application/vnd.api+json` |
| Lager | `GET products?page[size]=50&page[number]=n&fields[products]=sku,ean,quantity,updated_at` og `GET product-variants?page[size]=50…` (varianter har egne `quantity`, `sku`, `ean`) |
| Delta-synk | `filter[updated_at][path]=updated_at&filter[updated_at][value]=<siste synk>&filter[updated_at][operator]=gte` → bare endrede produkter |
| Webhooks | `products/update`, `products/create`, `products/delete` med HMAC-header `X-No-Mystore-Hmac-Sha256`. Bruk disse i tillegg til pull, da blir lageret nesten sanntid |
| Rate limit | 120 kall/min per token. 5 000 produkter à 50 per side = 100 kall = ca. 1 minutt |
| Dokumentasjon | `https://mystoreapi.docs.apiary.io/` |

Mystore Datakasse og nettbutikk deler samme produktbase, så `quantity` er butikkens reelle lager.

### 4.3 Neste systemer

Vanlige i norske garnbutikker: Front Systems, Tellix, Zettle, Shopify POS, Vipps/Softpay, PCKasse. Hvert nytt system = én ny fil `adapters/<system>.ts` på 100–200 linjer. Ingenting annet endres.

**Fallback for butikker uten API:** en `adapters/csv.ts` som leser en CSV butikken laster opp i dashboardet (EAN, antall). Bedre enn å vente på integrasjon.

---

## 5. Produktmatching (den viktigste datajobben)

Garnly har allerede 133 produkter i Shopify og en garndatabase (`Garn_database/`, Sandnes, Rauma m.fl.). Matching gjøres på **EAN/strekkode** på variantnivå (ett nøste i én farge = én EAN).

Tabell `products` i Supabase: `ean`, `shopify_variant_id`, `shopify_inventory_item_id`, `name`, `brand`, `color_code`. Shopify-varianten må ha `barcode` satt.

Regler:
1. Kassesystemets rad matches på EAN. Treff → skriv lager.
2. Ingen treff, men SKU/produktnummer matcher et kjent mønster (f.eks. Sandnes' varenummer) → foreslå kobling i dashboardet.
3. Ingen treff → rad i `unmatched_items` (butikk, ean, sku, navn, antall). Vises i dashboardet så noen kan koble eller opprette produktet i Shopify.

Butikkens lager for varer Garnly ikke selger ignoreres. Varer Garnly selger som butikken ikke har, får 0 på den locationen.

---

## 6. Lagersynk til Shopify

Edge Function `sync-store` kjøres av pg_cron hvert 15. minutt per aktiv butikk (forskjøvet, så ikke alle går samtidig):

1. Kall adapteren, få `[{ean, qty}]`.
2. Skriv til `inventory (store_id, product_id, qty, synced_at)` med upsert.
3. Beregn diff mot forrige synk. Kun endrede rader sendes til Shopify.
4. Shopify: `inventorySetQuantities` (GraphQL Admin API) med `name: "available"`, `reason: "correction"`, opptil 250 rader per kall, på `shopify_location_id` for butikken.
5. Oppdater `stores.last_sync_at`, `last_sync_status`, `last_sync_rows`. Feil → `sync_errors` og varsel til ops hvis 3 synker på rad feiler.

Første synk for en ny butikk er full. Deretter skrives bare endringer, så Shopify-kallene er få selv med mange produkter.

**Sikkerhetsbuffer:** valgfritt per butikk, `safety_stock` (f.eks. 1). Shopify får `qty - safety_stock` så butikksalg i mellomtiden ikke gir tomt hylle når nettordren kommer. Startverdi 0, justeres etter erfaring.

---

## 7. Kassevalidering i Shopify («ett parti fra én butikk»)

Shopify lar kunden kjøpe 7 nøster så lenge summen over alle locations er 7, og splitter gjerne 4 + 3. Det bryter partiregelen. Løsning: **Shopify Function – Cart and Checkout Validation** i en liten custom app.

- Synken skriver et metafelt på hver variant: `garnly.stock_by_store = {"<location_id>": qty, …}` (JSON). Oppdateres i samme kall som lageret.
- Funksjonen leser handlekurven og metafeltet per linje, og sjekker: *finnes minst én butikk som har hele antallet av denne linjen?* Nei → blokker med melding: «Vi har dessverre ikke 7 nøster av denne fargen fra samme parti akkurat nå. Prøv 5, eller velg en annen farge.»
- Funksjonen sjekker **ikke** at én butikk har hele kurven. Det er rutingens jobb (§8).

Det er den eneste koden som bor i Shopify. Fase 1 kan kjøre uten den (ordre uten kvalifisert butikk eskaleres manuelt), men den bør inn før nasjonal lansering.

---

## 8. Ordreruting

### 8.1 Trigger og hold
Shopify-webhook `orders/paid` → Edge Function `order-intake`. Verifiser HMAC. Idempotent på `shopify_order_id`. Sett `fulfillmentOrderHold` umiddelbart.

### 8.2 Kvalifisering
Fra `inventory` (ferskt fra siste synk): for hver varelinje, hvilke butikker har `qty >= antall`?

**Trinn 1 – hele ordren fra én butikk (foretrukket).**
`candidates = butikker som kvalifiserer for ALLE linjer`. Finnes minst én → én rutingsgruppe med hele ordren.

**Trinn 2 – splitt per varelinje (reserve).**
Ingen butikk har alt → del linjene i færrest mulig grupper (grådig: velg butikken som dekker flest gjenværende linjer, gjenta). Hver gruppe rutes uavhengig med egen tilbudsrunde. Shopify: `fulfillmentOrderSplit` per gruppe.

**Ingen butikk for en linje** (skal ikke skje med §7 på, men kan skje ved butikksalg i mellomtiden) → gruppen får status `escalated`, ops varsles.

### 8.3 Tilbud og round-robin (uendret fra juli)
Per gruppe: kandidater sorteres med spørringen fra `Garnly_Ordrefordeling_Logikk.md` §2 (`last_assigned_at` eldst først, `timeout_streak` × 24 t, `created_at` tiebreak). Tilbud til én butikk om gangen, `deadline_at = now + frist`. Ved aksept: `last_assigned_at = now()`, `assigned_count += 1`, `timeout_streak = 0`. En butikk som tar én gruppe i en splittet ordre teller som én tildeling.

### 8.4 Frist
Konfig `offer_ttl_hours` (foreslått 3) og `business_hours` per butikk. Fristen løper kun i åpningstid; et tilbud sendt kl. 17 med stengt kl. 18 fortsetter kl. 10 neste dag. Kunden får uansett ordrebekreftelse med en gang og en forventet leveringstid som tar høyde for dette.

### 8.5 Aksept
`offer-respond` (signert engangs-token i lenken):
1. Sjekk at tilbudet fortsatt er `offered`.
2. **Re-verifiser lager live** via adapteren for den butikken (ikke fra cache). Ikke nok → tilbudet markeres `declined_stock`, neste butikk.
3. `fulfillmentOrderMove` til butikkens location, `fulfillmentOrderReleaseHold`.
4. Book frakt (§10), skriv tracking med `fulfillmentCreateV2`.
5. Status `assigned`, kvittering til butikken.

### 8.6 Avslag, timeout, kansellering
Som i juli-dokumentet: avslag → neste kandidat uten straff. `timeout-sweeper` (pg_cron hvert minutt) markerer utløpte tilbud, øker `timeout_streak`, går videre. `orders/cancelled` avbryter aktive tilbud. Tom kø → `escalated`.

---

## 9. Varsling og partnerflate

**MVP:** e-post (Resend eller Postmark) + SMS (Twilio) med to lenker: Godta / Avslå. Landingssiden viser ordrelinjene, frist og en knapp. Ingen innlogging.

**Fase 2:** partnerside på Vercel med innlogging (Supabase Auth, magic link), åpne tilbud, historikk, egen fordeling og synk-status for egen butikk.

---

## 10. Frakt

Uendret beslutning: butikken sender, Garnly eier avtalen, kunden betaler frakt. Booking via API i aksept-steget (Shipmondo `POST /shipments` med butikk som avsender), etikett auto-printes (Print Client, Essentials-plan) eller sendes på e-post.

**Åpen signaturbeslutning fra juli, fortsatt åpen:** Shipmondo med Logistras Bring-avtale, eller Cargonizer direkte. Adapter-mønsteret brukes også her (`shipping/shipmondo.ts`, `shipping/cargonizer.ts`) så valget kan tas uten å låse koden.

**Ny konsekvens av splitt (§8.2):** kunden betaler én frakt, men to etiketter bookes. Anbefaling: Garnly dekker den ekstra etiketten i pilot, og `split_rate` måles. Alternativ: trekkes fra provisjon på ordren. Policyvalg, ikke teknisk.

---

## 11. Datamodell (eget Supabase-prosjekt)

```sql
stores            id, name, pos_system, pos_config (jsonb, kryptert), shopify_location_id,
                  shipmondo_sender_id, contact_email, contact_phone, notify_channel,
                  business_hours (jsonb), offer_ttl_hours, safety_stock, auto_accept,
                  last_assigned_at, assigned_count, timeout_streak, weight, active,
                  last_sync_at, last_sync_status, created_at

products          id, ean, sku, name, brand, color_code,
                  shopify_product_id, shopify_variant_id, shopify_inventory_item_id, active

inventory         store_id, product_id, qty, qty_raw, synced_at   (PK store_id+product_id)

unmatched_items   id, store_id, ean, sku, name, qty, first_seen, resolved_product_id

routing_orders    id, shopify_order_id, shopify_fulfillment_order_id, status
                  (routing|assigned|partially_assigned|escalated|cancelled),
                  customer_geo, created_at

routing_groups    id, routing_order_id, line_items (jsonb), shopify_fulfillment_order_id,
                  status, assigned_store_id, assigned_at, tracking_number

offers            id, routing_group_id, store_id, sequence_no, status
                  (pending|offered|accepted|declined|declined_stock|expired),
                  token_hash, offered_at, deadline_at, responded_at

sync_runs         id, store_id, started_at, finished_at, rows, changed, status, error
audit_log         id, entity, entity_id, event, payload, created_at
```

`routing_groups` er nytt: én ordre kan ha flere grupper (splitt). Alt annet er fra juli-dokumentet.

---

## 12. Edge Functions (repo-struktur)

```
garnly-butikk/
├── supabase/
│   ├── migrations/          001_schema.sql, 002_cron.sql
│   └── functions/
│       ├── sync-store/      henter én butikk, skriver inventory + Shopify
│       ├── pos-webhook/     mottar Mystore-webhooks (HMAC), trigger delta-synk
│       ├── order-intake/    Shopify orders/paid → hold → kvalifisering → grupper → første tilbud
│       ├── make-offer/      neste kandidat, sender varsel
│       ├── offer-respond/   godta/avslå-lenker, re-verifisering, move/release, frakt
│       ├── timeout-sweeper/ cron hvert minutt
│       ├── order-cancelled/ Shopify orders/cancelled
│       └── _shared/         adapters/, shopify.ts, shipping/, notify.ts, routing.ts
├── shopify-app/             Validation Function (§7), Rust eller JS
├── dashboard/               Next.js: lager per butikk, unmatched, synk-status, ordrer, eskaleringer
└── .github/workflows/       deploy.yml: supabase db push + functions deploy
```

pg_cron: `sync-store` hvert 15. min per butikk (forskjøvet med `store.id`-hash), `timeout-sweeper` hvert minutt, `threshold-report` daglig.

Secrets (Supabase Vault / function secrets): Shopify Admin token, Duell client_number/token per butikk, Mystore-token per butikk, Shipmondo, Resend/Twilio. Aldri i repo.

---

## 13. Shopify-oppsett som må gjøres (manuelt + via API)

1. Opprett én location per partnerbutikk (navn, adresse). Deaktiver «Shop location» for online-ordre, eller bruk den som Garnlys eskaleringslager.
2. Sett `barcode` (EAN) på alle varianter. 133 produkter i dag; sjekk hvor mange som mangler.
3. Slå av automatisk fulfillment. Ordreruting skal styre alt.
4. Custom app med scopes: `read_orders, write_orders, read_products, write_products, read_inventory, write_inventory, write_merchant_managed_fulfillment_orders, read_locations, write_fulfillments`.
5. Webhooks: `orders/paid`, `orders/cancelled` → Edge Functions. (Ingen webhooks i dag.)
6. Fraktprofiler: én sats uavhengig av location (Garnly betaler forskjellen ved splitt).
7. Validation Function-app deployes (§7), fase 1b.

---

## 14. Utrulling i faser

| Fase | Innhold | Klar når |
|---|---|---|
| **0. Grunnmur** (uke 1) | Nytt Supabase-prosjekt, skjema, repo, GitHub Actions, Shopify custom app + locations, EAN på varianter | `sync-store` kan kjøres manuelt mot én butikk |
| **1. Lagersynk** (uke 1–2) | Duell- og Mystore-adaptere, matching, unmatched-liste, cron hvert 15. min, dashboard med lager per butikk | Begge butikker speiles i Shopify og dashboardet viser siste synk |
| **2. Ruting MVP** (uke 2–3) | order-intake, hold, kvalifisering trinn 1, tilbud på e-post/SMS, godta/avslå, timeout, move/release, eskalering | Én testordre går hele veien til «assigned» uten manuell inngripen |
| **3. Splitt + validering** (uke 3–4) | Trinn 2 (grupper), `fulfillmentOrderSplit`, Validation Function med metafelt | Testordre med to varer fra to butikker fungerer; 7 nøster uten parti blokkeres i kassen |
| **4. Frakt** (uke 4) | Shipmondo eller Cargonizer i aksept-steget, tracking til Shopify, etikett til butikk | Butikken får etikett automatisk ved aksept |
| **5. Pilot** (uke 5–6) | 2 butikker, ekte ordrer, lav trafikk. Mål: akseptrate, timeout-rate, split-rate, synk-avvik | 2 uker uten eskaleringer som skyldes systemet |
| **6. Skalering** | Nye adaptere etter hvert som butikker kommer, partnerside med innlogging, kapasitetsvekting | Ny butikk onboardes på under en dag |

Estimat for fase 0–4: 60–90 timer utvikling. Frakt-valget (§10) og EAN-dekningen i Shopify er de to tingene som kan forsinke.

---

## 15. Å avklare før bygging starter

1. **Duell:** hvilken avdeling (department-token) tilhører butikken, og gir `all/product/stock` EAN? (Åpne `api.kasseservice.no/docs` i nettleser, eller be support@duell.no om et eksempelsvar.)
2. **Mystore:** butikkens shop-navn (delen etter `/shops/`) og et personlig tilgangstoken med `read:products`.
3. **EAN i Shopify:** hvor mange av de 133 produktene/variantene har `barcode` satt?
4. **Frist:** 3 timer i åpningstid? Skal fristen løpe i helg?
5. **Splitt-frakt:** Garnly dekker, eller trekk i provisjon?
6. **Frakt-plattform:** Shipmondo eller Cargonizer (hang på Logistras svar i juli).
7. **Varsling:** e-post, SMS eller begge til butikkene?
8. **Safety stock:** 0 eller 1 nøste per variant per butikk i pilot?

---

## 16. Kilder brukt i denne planen

- Duell: `https://www.duell.no/support/api-dokumentasjon/` og Duells egen WooCommerce-integrasjon `https://github.com/Kasseservice/woocommerce-3x` (endepunkter og feltnavn hentet derfra)
- Mystore/Acendy API v2: `https://mystoreapi.docs.apiary.io/` (blueprint lest 27.08.2026)
- Shopify Admin GraphQL: `inventorySetQuantities`, `fulfillmentOrderHold/Move/ReleaseHold/Split`, `fulfillmentCreateV2`, Cart and Checkout Validation Functions. Mutasjonsnavn må bekreftes mot gjeldende API-versjon før bygg (samme forbehold som i juli-dokumentet)
- Garnly-butikken i Shopify per 27.08.2026: 133 produkter, 13 samlinger, 1 location, 0 webhooks

*Utkast til vurdering. Parametere (15 min, 3 t frist, safety stock) er startverdier som justeres etter måling i pilot.*
