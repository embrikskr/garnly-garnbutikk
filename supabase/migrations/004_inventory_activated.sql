-- Sporer om et (butikk, produkt) er aktivert + lagersporing slått på i Shopify.
-- Trengs fordi Shopify-variantene mirrores med tracked=false og uten inventory level
-- på butikkens location; sync-store aktiverer og slår på sporing første gang det skriver
-- lager for raden, og hopper over det etterpå. Kan ikke utledes fra "prev tom", siden
-- en tørrkjøring også fyller inventory-tabellen.

alter table inventory add column if not exists shopify_activated boolean not null default false;
