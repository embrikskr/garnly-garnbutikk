# Status – garnly-garnbutikk

Oppdatert: 2026-08-27

## Bygget (ikke deployet ennå)
- Skjema (001), cron (002)
- Adaptere: Duell, Mystore, CSV
- Edge Functions: sync-store, sync-products, order-intake, offer-respond, timeout-sweeper, order-cancelled, pos-webhook
- Shipmondo-adapter (SHIPPING_PROVIDER=none til fraktvalget er tatt)
- Enhetstester for ruting, frister og matching (10 stk, grønne)

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
- Shopify Validation Function (§7)
- Admin-dashboard
- Partnerside med innlogging (fase 2)
