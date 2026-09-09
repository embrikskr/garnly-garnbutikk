# Oppdrag til Claude Code

Skrevet 09.09.2026. Les `CLAUDE.md` og `docs/STATUS.md` først. Dette dokumentet
sier hva som er endret siden sist, og hva som skal gjøres nå, i rekkefølge.

Alt arbeid i Shopify er allerede gjort utenfra. Din jobb er Supabase, Edge
Functions, butikkpanelet og webhookene.

---

## 1. Hvor vi står

**Shopify (kycbgs-yy.myshopify.com) er live.** Butikken er publisert, uten
passord, og kan kjøpes fra. Ingen ordrer har kommet ennå.

| Ting | Verdi |
|---|---|
| Supabase-prosjekt | `zesaeleooiptrpjzqhxe` |
| Location Strikkefryd (Mjøndalen) | `gid://shopify/Location/125074604318` |
| Location Garnkilden (Stavanger) | `gid://shopify/Location/125074637086` |
| Location «Shop location» (Garnlys egen, tom) | `gid://shopify/Location/123740455198` |
| Live tema | «Garnly 2026 (utkast)», id `205742768414` |
| Produkter | 73 aktive, 117 utkast |

**Lager:** det ligger ekte lager på Strikkefryd-lokasjonen, sist skrevet
2026-09-05 13:18. Garnkilden har ingenting. **Finn ut hvor Strikkefryd-tallene
kom fra** før du gjør noe annet: er de skrevet av `sync-store`, er deler av
backend-en allerede deployet, og da skal du ikke kjøre migrasjonene blindt.
Sjekk `sync_runs` og `stores` i Supabase. Er tabellene tomme, kom tallene fra en
manuell import i Shopify og du starter fra bunnen.

**Det som er fikset i Shopify og som du ikke skal røre:**
- De to butikklokasjonene er lagt inn i fraktprofilen. Uten det teller ikke
  Shopify lageret deres, og alt viste utsolgt selv med varer inne.
- Garnpakkene har lagersporing av, siden de settes sammen av garn butikken
  allerede har. Rutingen avgjør om de kan lages, ikke et lagertall.
- Kolleksjonen «På lager nå» (`pa-lager`) er automatisk og inneholder det som
  faktisk kan kjøpes.
- Sidene `/pages/oppskrifter` og `/pages/appen` finnes, menyene er ryddet, og
  kategoriene er oversatt til norsk.

---

## 2. Endringer i repoet siden sist

To commits: `9864189` og `a890cd2`.

### Nytt

| Fil | Hva |
|---|---|
| `supabase/migrations/003_product_aliases.sql` | `product_aliases`: kobler en vare i kassesystemet til et Garnly-produkt når EAN mangler eller er ubrukelig |
| `supabase/seed/product_aliases.sql` | 94 ferdige koblinger (Cardiff Classic og Prime, Plötulopi, Bella Color, Rauma 2-tråds gammelserie m.fl.) |
| `supabase/migrations/004_store_panel.sql` | `store_users`, `current_store_ids()`, RLS på `offers` og `stores`, views `v_panel_queue` / `v_panel_assigned` / `v_panel_stats`, `offers` lagt i `supabase_realtime` |
| `panel/` | Butikkpanelet. Statisk side, ingen byggesteg |
| `docs/sortiment_dekning_2026-09-06.csv` | Dekning per variant mot begge butikkene |

### Endret

- **`_shared/matching.ts`** — `matchLines(lines, products, aliases)` tar nå et
  tredje argument. Rekkefølgen er EAN → alias → SKU → navn.
- **`_shared/types.ts`** — `StockLine.external_id` (kassesystemets egen id) og
  `StoreRow.notify_offers`.
- **`_shared/adapters/duell.ts`** — setter `external_id` = `product_number`.
- **`_shared/adapters/mystore.ts`** — setter `external_id` = `v:<variant-id>`
  eller `p:<product-id>`.
- **`sync-store/index.ts`** — henter aliasene for butikken og sender dem inn i
  `matchLines`. `unmatched_items` bruker `external_id` når SKU mangler.
- **`sync-products/index.ts`** — slår på lagersporing på varianter som mangler
  det, via ny `ensureVariantsTracked()` i `shopify.ts`. Uten sporing selger
  Shopify ubegrenset uansett hva vi skriver til lokasjonene.
- **`offer-respond/index.ts`** — skrevet om. Tre innganger, delt logikk:
  1. `POST { offer_id, action }` + `Authorization: Bearer <bruker-JWT>` → panelet.
     Verifiserer mot `store_users` at brukeren hører til butikken.
  2. `GET ?t=<token>&a=accept|decline` → engangslenke, beholdt som reserve.
  3. `POST { token, action }` + `x-cron-secret` → internt, `auto_accept`.
  CORS mot `PANEL_ORIGIN`.
- **`_shared/notify.ts`** — `notifyStoreOffer` returnerer med en gang hvis
  `store.notify_offers` er false, som er standard. `notifyOps` er urørt, det er
  intern varsling til Garnly og skal fortsatt gå.

### Prinsipp som ikke skal brytes

Panelet gjør ingen forretningslogikk. Godta og avslå går alltid gjennom
`offer-respond`, som eier lagersjekk, Shopify-flytting og frakt. Legg aldri noe
av det i nettleseren.

---

## 3. Oppdraget, i rekkefølge

### Steg 1. Grunnoppsett i Supabase

```bash
supabase login
supabase link --project-ref zesaeleooiptrpjzqhxe
supabase db push
```

SQL Editor, innstillingene `pg_cron` trenger:

```sql
alter database postgres set app.functions_url = 'https://zesaeleooiptrpjzqhxe.supabase.co/functions/v1';
alter database postgres set app.cron_secret   = '<lang tilfeldig streng>';
```

Lag `.env` fra `.env.example`. Nødvendige verdier nå:
`SHOPIFY_ADMIN_TOKEN`, `SHOPIFY_WEBHOOK_SECRET`, `CRON_SECRET` (samme som over),
`OPS_EMAIL`, `PANEL_ORIGIN`. `RESEND_API_KEY` og Twilio kan stå tomme, e-post per
tilbud er av.

```bash
supabase secrets set --env-file .env
supabase functions deploy
```

### Steg 2. Shopify custom app og webhooks

Scopes står i `README.md`. Webhookene er det som gjør at systemet i det hele tatt
hører om en ordre:

| Event | URL |
|---|---|
| Order payment | `https://zesaeleooiptrpjzqhxe.supabase.co/functions/v1/order-intake` |
| Order cancellation | `https://zesaeleooiptrpjzqhxe.supabase.co/functions/v1/order-cancelled` |

### Steg 3. Legg inn butikkene

Slug-ene `strikkefryd` og `garnkilden` brukes av alias-seeden. Ikke bytt dem.

```sql
insert into stores (name, slug, pos_system, pos_config, shopify_location_id, contact_email, notify_channel, offer_ttl_hours, safety_stock)
values ('Strikkefryd', 'strikkefryd', 'mystore', '{"shop":"strikkefryd","use_variants":true}',
        'gid://shopify/Location/125074604318', '<butikkens e-post>', 'email', 3, 0);
insert into store_secrets (store_id, secrets)
values ((select id from stores where slug = 'strikkefryd'), '{"token":"<mystore token>"}');

insert into stores (name, slug, pos_system, pos_config, shopify_location_id, contact_email, notify_channel, offer_ttl_hours, safety_stock)
values ('Garnkilden', 'garnkilden', 'duell', '{"department":"<duell department api_token>"}',
        'gid://shopify/Location/125074637086', '<butikkens e-post>', 'email', 3, 0);
insert into store_secrets (store_id, secrets)
values ((select id from stores where slug = 'garnkilden'), '{"client_number":"722490","client_token":"<client token>"}');
```

Duell-department-token hentes med `listDepartments()` i `_shared/adapters/duell.ts`,
eller `GET /v1/department/list`.

Strikkefryd-tokenet har vært delt i chat. Be butikken lage et nytt før dere går i
drift, og legg det nye inn her.

### Steg 4. Speil produktene og kjør alias-seeden

Rekkefølgen betyr noe. `product_aliases` peker på `products.shopify_variant_id`,
så `sync-products` må ha kjørt først.

```bash
curl -X POST https://zesaeleooiptrpjzqhxe.supabase.co/functions/v1/sync-products \
  -H "x-cron-secret: $CRON_SECRET"
```

Så `supabase/seed/product_aliases.sql` i SQL Editor.

### Steg 5. Tørrkjør synken per butikk

```bash
curl -X POST https://zesaeleooiptrpjzqhxe.supabase.co/functions/v1/sync-store \
  -H "x-cron-secret: $CRON_SECRET" -H "Content-Type: application/json" \
  -d '{"store_id":"<uuid>","dry_run":true}'
```

Se på `sync_runs` og `unmatched_items`. Forventning: Strikkefryd treffer på det
meste, Garnkilden er den store gevinsten siden de ikke har lager inne ennå.
Ser matchingen riktig ut, kjør uten `dry_run`.

**Garnkilden er den som kan feile.** `api.kasseservice.no` ligger bak AWS WAF som
blokkerer datasenter-IP-er. Får du HTML i stedet for JSON, kaster adapteren en
`AdapterError` som sier det. Da må Supabase-egressen hvitlistes av
support@duell.no, eller kallene rutes via proxy. Test dette tidlig, det kan ta tid
å få svar.

### Steg 6. Butikkpanelet

```bash
# anon-nøkkel fra Supabase → Project settings → API
# inn i panel/config.js
npx wrangler pages deploy panel --project-name garnly-butikkpanel
supabase secrets set PANEL_ORIGIN=https://butikk.garnly.no
```

CNAME for `butikk.garnly.no` mot Pages-prosjektet.

Bruker per butikk i Supabase → Authentication → Users, så:

```sql
insert into store_users (user_id, store_id, role)
values ('<auth user id>', (select id from stores where slug = 'strikkefryd'), 'owner');
```

Sjekk at `alter publication supabase_realtime add table offers;` faktisk gikk
gjennom i migrasjon 004. Uten den får panelet ingen sanntid, bare polling hvert
tredve sekund, og det er ikke det vi har lovet.

### Steg 7. Test hele løpet før butikkene slippes til

1. Legg en testordre i Shopify med varer Strikkefryd har.
2. Ordren skal settes på hold umiddelbart. Sjekk `routing_orders` og
   `routing_groups`.
3. Tilbudet skal dukke opp i panelet innen et sekund, med riktig frist.
4. Trykk Godta. Fulfillment order skal flyttes til Strikkefryds location, holdet
   slippes, og gruppa få status `assigned`.
5. Test Avslå på en ny ordre og se at den går videre.
6. Sett `deadline_at` bakover på et tilbud manuelt og sjekk at
   `timeout-sweeper` markerer det `expired` og sender videre.
7. Kanseller en ordre i Shopify og se at `order-cancelled` rydder opp.

---

## 4. Ikke gjett på dette

**Frakt.** `SHIPPING_PROVIDER` står på `none` til valget mellom Shipmondo og
Cargonizer er tatt. Med `none` svarer panelet «frakt bookes manuelt», og resten
fungerer. Ikke velg leverandør på egen hånd, det er en avtale Embrik må inngå.

**Hvilke produkter som skal aktiveres.** 117 produkter ligger som utkast med
vilje. Embrik og Halvor går gjennom sortimentet i et regneark. Ikke aktiver noe.

**Temaet.** «Garnly 2026 (utkast)» er publisert og live. Shopify blokkerer
API-skriving mot live-temaet. Skal noe endres i forsiden, lag en kopi og la
Embrik publisere den.

**Sikkerhetsmargin.** `stores.safety_stock` står på 0. Skal den opp, er det en
forretningsbeslutning, ikke en teknisk.

---

## 5. Når du er ferdig

Oppdater `docs/STATUS.md` med hva som faktisk ble deployet, hva som feilet, og
hva Duell svarte om WAF-en. Kjør `deno task check` og `deno task test` før hver
commit. Alle tolv testene skal være grønne.
