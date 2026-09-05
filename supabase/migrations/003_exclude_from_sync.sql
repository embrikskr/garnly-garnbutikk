-- Bare garn skal lagersynkes fra butikkenes kassesystemer (Embrik 04.09.2026).
-- Produkter med exclude_from_sync = true holdes helt utenfor sync-store:
-- ingen matching, ingen lagerskriving, ingen metafelt. Gjelder i dag Garnlys
-- egne «Yarn kit»-produkter, som ikke skal få lager fra partnerbutikkene.

alter table products add column if not exists exclude_from_sync boolean not null default false;

update products set exclude_from_sync = true
where brand = 'Garnly' and name like 'Yarn kit%';
