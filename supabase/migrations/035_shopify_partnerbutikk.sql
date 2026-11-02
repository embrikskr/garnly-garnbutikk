-- Partnerbutikker med lager i egen Shopify (02.11.2026), først en dansk butikk.
--
-- Butikken installerer Garnly-appen (Dev Dashboard, custom distribution – én app per butikk).
-- Edge Function `shopify-install` finner butikken på `pos_config.shop_domain` og lagrer nøklene
-- i `store_secrets`. Se _shared/shopify_oauth.ts og shopify-partner-app/README.md.
--
-- Lagersynken mot butikkens Shopify (adapteren `shopify`) er ikke bygget ennå. Til den er det,
-- står butikken med active = false.

alter type pos_system add value if not exists 'shopify';

-- To butikker med samme Shopify ville fått hverandres nøkler.
create unique index if not exists stores_shop_domain_key
  on stores ((pos_config->>'shop_domain'))
  where pos_config ? 'shop_domain';
