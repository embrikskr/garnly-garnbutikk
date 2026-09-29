-- Fulfillment-tidspunktet kommer fra Shopify, ikke fra oss.
--
-- Garnly oppretter aldri fulfillments selv. Butikken lager sendingen i CargonizerConnect
-- (Logistra), og den appen fulfiller ordren i Shopify med sporingsnummer. Vi får vite det
-- gjennom webhooken `fulfillments/create`, og `timeout-sweeper` spør Shopify som backstop i
-- tilfelle en webhook går tapt.
--
-- Uten dette blir `fulfilled_at` aldri satt, og da slår kassauttrekket fra 013 aldri inn:
-- i det CargonizerConnect fulfiller, faller `committed` bort i Shopify, og hullet er tilbake.

alter table routing_groups add column if not exists fulfillment_checked_at timestamptz;

comment on column routing_groups.fulfillment_checked_at is
  'Sist vi spurte Shopify om denne gruppen er sendt. Holder backstoppen, som går hvert '
  'minutt, fra å spørre om de samme ordrene igjen og igjen.';

-- Backstoppens utvalg: tildelt, ikke merket sendt, og ikke nylig sjekket.
create index if not exists routing_groups_fulfillment_backstop_idx
  on routing_groups (assigned_at)
  where status = 'assigned' and fulfilled_at is null;

-- ---------------------------------------------------------------------------
-- Rydder de 23 «Yarn kit»-radene fra den gamle Shopify-butikken.
--
-- De ble deaktivert ved flyttingen 27.09 og erstattet av «Garnpakke – …» med nye id-er.
-- Ingenting peker på dem (verifisert: 0 rader i inventory, product_aliases og
-- unmatched_items). Betingelsen på variant-id holder oss til den gamle id-serien, så et
-- framtidig produkt som tilfeldigvis heter «Yarn kit …» ikke ryker med.
-- ---------------------------------------------------------------------------
delete from products
where name like 'Yarn kit%'
  and not active
  and replace(shopify_variant_id, 'gid://shopify/ProductVariant/', '')::bigint >= 55000000000000;
