# garnly-garnbutikk

Backend for Garnlys felles nettbutikk: lagersynk fra partnerbutikkenes kassesystemer til Shopify, og ordreruting mellom butikkene. Se `docs/Garnly_Garnbutikk_Byggeplan_v1.md` for arkitektur og `CLAUDE.md` for arbeidsregler.

## Første oppsett (gjøres én gang, lokalt)

Forutsetninger: [Supabase CLI](https://supabase.com/docs/guides/cli), [Deno 2](https://deno.land), tilgang til Supabase-prosjektet `zesaeleooiptrpjzqhxe` og Shopify-butikken.

### 1. Supabase

```bash
supabase login
supabase link --project-ref zesaeleooiptrpjzqhxe
supabase db push                       # kjører migrasjonene
```

Sett databaseinnstillingene pg_cron trenger (SQL Editor i Supabase Dashboard):

```sql
alter database postgres set app.functions_url = 'https://zesaeleooiptrpjzqhxe.supabase.co/functions/v1';
alter database postgres set app.cron_secret   = '<lang tilfeldig streng>';
```

Lag `.env` fra `.env.example`, fyll inn, og sett secrets:

```bash
supabase secrets set --env-file .env
supabase functions deploy
```

### 2. Shopify custom app

Shopify admin → Settings → Apps and sales channels → Develop apps → Create app «Garnly ruting».
Admin API scopes: `read_products, write_products, read_inventory, write_inventory, read_locations, read_orders, write_orders, read_merchant_managed_fulfillment_orders, write_merchant_managed_fulfillment_orders, read_assigned_fulfillment_orders, write_assigned_fulfillment_orders, write_fulfillments`.
Installer appen, kopier Admin API access token → `SHOPIFY_ADMIN_TOKEN`. API secret key → `SHOPIFY_WEBHOOK_SECRET`.

Webhooks (Settings → Notifications → Webhooks, format JSON):

| Event | URL |
|---|---|
| Order payment | `https://zesaeleooiptrpjzqhxe.supabase.co/functions/v1/order-intake` |
| Order cancellation | `https://zesaeleooiptrpjzqhxe.supabase.co/functions/v1/order-cancelled` |

Opprett én location per partnerbutikk (Settings → Locations). Kopier location-GID (`gid://shopify/Location/…`, finnes i URL-en som tall) til `stores.shopify_location_id`.

### 3. Butikker

```sql
insert into stores (name, slug, pos_system, pos_config, shopify_location_id, contact_email, notify_channel)
values ('Nøstet Mitt Trondheim', 'nostet-mitt-trd', 'duell', '{"department":"<duell department token>"}', 'gid://shopify/Location/1234', 'butikk@example.no', 'email');
insert into store_secrets (store_id, secrets) values ('<store id>', '{"client_number":"…","client_token":"…"}');

insert into stores (name, slug, pos_system, pos_config, shopify_location_id, contact_email)
values ('Garnkilden', 'garnkilden', 'mystore', '{"shop":"<mystore shopnavn>"}', 'gid://shopify/Location/5678', 'post@example.no');
insert into store_secrets (store_id, secrets) values ('<store id>', '{"token":"<mystore personal access token>","webhook_secret":"<valgfri>"}');
```

### 4. Kjør

```bash
# Speil Shopify-varianter inn i products
curl -X POST https://zesaeleooiptrpjzqhxe.supabase.co/functions/v1/sync-products -H "x-cron-secret: $CRON_SECRET"

# Tørrkjør synk for én butikk (henter, matcher, skriver IKKE til Shopify)
curl -X POST https://zesaeleooiptrpjzqhxe.supabase.co/functions/v1/sync-store -H "x-cron-secret: $CRON_SECRET" \
  -H "Content-Type: application/json" -d '{"store_id":"<uuid>","dry_run":true}'
```

Sjekk `unmatched_items` og `sync_runs` i Supabase-tabellvisningen. Når matchingen ser riktig ut, kjør uten `dry_run`.

### 5. Bygg sortimentet fra kassesystemene

Sortimentet hentes fra butikkenes kassesystemer, kureres og opprettes i Shopify (med EAN og
lagersporing fra start):

```bash
# 1) Hent og slå sammen på EAN → produktimport.csv (env: DUELL_* og/eller MYSTORE_*)
deno task import-products

# 2) Åpne CSV-en, sett x i behold-kolonnen og fyll pris for varene Garnly skal selge

# 3) Opprett de valgte som DRAFT-produkter i Shopify (env: SHOPIFY_SHOP, SHOPIFY_ADMIN_TOKEN)
deno task import-products -- --create produktimport.csv
```

Gå gjennom utkastene i Shopify admin (bilder, beskrivelser, ACTIVE), og kjør deretter
`sync-products` (steg 4) så `products`-tabellen speiler katalogen.

### 5b. EAN og lagersporing på eksisterende varianter (reserve)

Shopify-variantene mangler i dag strekkoder, og lager spores ikke. Når butikkene leverer
produktlister (CSV med `ean;navn`), kjør:

```bash
deno task set-barcodes -- liste.csv            # tørrkjøring: viser matching og hva som ville blitt gjort
deno task set-barcodes -- liste.csv --apply    # skriver barcode + slår på lagersporing
```

Kjør deretter `sync-products` på nytt (steg 4) så `products`-tabellen speiler endringene.

## Admin-dashboard (`dashboard/`)

Next.js-app for Garnly ops: oversikt per butikk, ordrer med tilbudshistorikk, umatchede varer
(koble/ignorer), lager og synk-status med «Synk nå»-knapp.

```bash
cd dashboard
cp .env.example .env.local   # fyll inn
npm install
npm run dev                  # http://localhost:3000
```

Deploy: Vercel-prosjekt med **Root Directory `dashboard/`** og miljøvariablene fra `.env.example`.
Sett `DASHBOARD_PASSWORD` – uten den er dashboardet åpent.

## Kassevalidering i Shopify (`shopify-app/`)

Shopify Function som håndhever garnparti-regelen i kassen (byggeplan §7). Se `shopify-app/README.md`
for deploy med Shopify CLI.

## Lokal utvikling

```bash
deno task check      # typesjekk
deno task test       # enhetstester (ruting, frister, matching)
supabase functions serve --env-file .env   # kjør funksjonene lokalt
node --test "shopify-app/extensions/parti-validering/test/*.test.mjs"   # test valideringsfunksjonen
```

## Deploy

Push til `main` kjører `deno task check`, `deno task test`, `supabase db push` og `supabase functions deploy` via GitHub Actions. Krever repo-secrets `SUPABASE_ACCESS_TOKEN` og `SUPABASE_DB_PASSWORD`.
