-- Duells lagerendepunkt (all/product/stock) gir bare product_id/product_number og antall –
-- ingen strekkode og ingen navn. Strekkoden ligger i product/list, som er klient-omfattende
-- (ikke per avdeling) og må sideblas 100 rader om gangen (~6000 produkter, ~2 min). Det er for
-- tregt for synken som går hvert 5. minutt, så katalogen mellomlagres her og friskes opp
-- én gang i døgnet av pos-catalog-funksjonen.
--
-- source = "<kassesystem>:<klientnummer>", f.eks. "duell:722490". Deles av alle avdelinger
-- under samme Duell-klient. Nøkkelen er kassesystemets egen primærnøkkel (Duell product_id);
-- product_number er IKKE unikt og kan ikke brukes som nøkkel.

drop view if exists v_pos_catalog_status;
drop table if exists pos_catalog;

create table pos_catalog (
  source      text        not null,
  pos_id      text        not null,
  sku         text,
  ean         text,
  name        text,
  category    text,
  supplier    text,
  deleted     boolean     not null default false,
  updated_at  timestamptz not null default now(),
  primary key (source, pos_id)
);

create index pos_catalog_source_ean_idx on pos_catalog (source, ean) where ean is not null;

comment on table pos_catalog is
  'Mellomlagret produktkatalog fra kassesystemer som ikke gir strekkode i lagerkallet (Duell). Friskes opp av pos-catalog-funksjonen.';

create or replace view v_pos_catalog_status as
select source,
       count(*)                                     as rows,
       count(*) filter (where ean is not null)      as with_ean,
       count(*) filter (where deleted)              as deleted,
       max(updated_at)                              as refreshed_at
from pos_catalog
group by source;
