# Status – garnly-garnbutikk

Oppdatert: 2026-08-27 (kveld)

## Bygget (ikke deployet ennå)
- Skjema (001), cron (002)
- Adaptere: Duell, Mystore, CSV
- Edge Functions: sync-store, sync-products, order-intake, offer-respond, timeout-sweeper, order-cancelled, pos-webhook
- Shipmondo-adapter (SHIPPING_PROVIDER=none til fraktvalget er tatt)
- Enhetstester for ruting, frister og matching (10 stk, grønne)
- **Admin-dashboard** (`dashboard/`, Next.js): oversikt, ordrer m/tilbudshistorikk, umatchede varer
  med koble/ignorer (koble lærer produktet EAN/SKU), lager per butikk, synk-status med «Synk nå».
  Beskyttes med HTTP Basic (DASHBOARD_PASSWORD). Deployes til Vercel med root `dashboard/`.
- **Shopify Validation Function** (`shopify-app/`, §7): blokkerer kjøp der ingen enkelt butikk har
  hele antallet av en varelinje, basert på metafeltet `garnly.stock_by_store`. 7 enhetstester grønne.
  Input-query validert mot Functions-skjemaet. Deploy krever Shopify CLI (se `shopify-app/README.md`).
- **`scripts/set-barcodes.ts`**: skriver EAN (barcode) og slår på lagersporing på Shopify-varianter
  fra en CSV med `ean;navn` (butikkenes produktlister). Tørrkjøring som standard, `--apply` skriver.
  Mutasjonen validert mot Admin API 2025-07. Løser blokkerende punkt 3 så snart vi får produktlister.

## Sortimentbeslutning 28.08.2026
Embrik: produktene som ligger i Shopify i dag er IKKE de som skal selges. Sortimentet skal hentes
fra Duell og Mystore, kureres, og opprettes på nytt i Shopify (med EAN og lagersporing fra start).
Verktøy: `scripts/import-products.ts` (hent → slå sammen på EAN → kurerings-CSV → opprett som DRAFT).
De 133 eksisterende produktene arkiveres når Embrik bekrefter (destruktiv operasjon, krever eksplisitt ja).
`set-barcodes.ts` blir dermed mest relevant som reserve hvis noen eksisterende produkter likevel beholdes.

## Funn fra Shopify 27.08.2026
- Garnly2 har 133 produkter, 250+ varianter: **0 strekkoder, 0 SKU, lager ikke sporet**. Hver farge er eget produkt.
- Konsekvens: EAN-matching fungerer ikke før strekkoder er lagt inn. Navnematching (brand + garn + farge) er reserve.
- Én location («Shop location»), ingen webhooks.

## Blokkerende avklaringer
1. Duell: department-token for butikken, og hvilket felt som gir EAN i `all/product/stock`
2. Mystore: shopnavn + personlig tilgangstoken
3. EAN på Shopify-varianter (eller butikkenes produktlister med strekkoder, så vi kan legge dem inn)
4. Frakt: Shipmondo vs Cargonizer (Logistra)

## Ikke bygget ennå
- Partnerside med innlogging (fase 2)

## Ikke deployet ennå (krever tilganger)
- Supabase: `supabase db push` + `functions deploy` (krever SUPABASE_ACCESS_TOKEN; CI gjør det på push til main)
- Dashboard: Vercel-prosjekt med root `dashboard/` og env fra `dashboard/.env.example`
- Validation Function: `shopify app deploy` fra `shopify-app/` (krever Shopify CLI-innlogging),
  deretter aktiveres valideringen i Shopify admin → Settings → Checkout
