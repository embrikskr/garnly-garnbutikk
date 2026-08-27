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

## Lokal utvikling

```bash
deno task check      # typesjekk
deno task test       # enhetstester (ruting, frister, matching)
supabase functions serve --env-file .env   # kjør funksjonene lokalt
```

## Deploy

Push til `main` kjører `deno task check`, `deno task test`, `supabase db push` og `supabase functions deploy` via GitHub Actions. Krever repo-secrets `SUPABASE_ACCESS_TOKEN` og `SUPABASE_DB_PASSWORD`.
