-- Duells lagerendepunkt (all/product/stock) gir bare product_number og antall – ingen strekkode
-- og ingen navn. Strekkoden ligger i product/list, som er klient-omfattende (ikke per avdeling)
-- og må sideblas 100 rader om gangen (~6000 produkter, ~2 min). Det er for tregt for synken som
-- går hvert 15. minutt, så katalogen mellomlagres her og friskes opp én gang i døgnet.
--
-- source = "<kassesystem>:<klientnummer>", f.eks. "duell:722490". Én rad per produktnummer.
-- Deles av alle avdelinger under samme Duell-klient.

create table if not exists pos_catalog (
  source      text        not null,
  sku         text        not null,
  ean         text,
  name        text,
  category    text,
  supplier    text,
  updated_at  timestamptz not null default now(),
  primary key (source, sku)
);

create index if not exists pos_catalog_source_ean_idx on pos_catalog (source, ean) where ean is not null;

comment on table pos_catalog is
  'Mellomlagret produktkatalog fra kassesystemer som ikke gir strekkode i lagerkallet (Duell). Friskes opp av pos-catalog-funksjonen.';

-- Når katalogen sist ble oppfrisket per kilde. Brukes til å avgjøre om et nytt crawl trengs.
create or replace view v_pos_catalog_status as
select source,
       count(*)                          as rows,
       count(*) filter (where ean is not null) as with_ean,
       max(updated_at)                   as refreshed_at
from pos_catalog
group by source;
