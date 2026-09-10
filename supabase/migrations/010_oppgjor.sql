-- Grunnlag for oppgjør med butikkene.
--
-- Systemet lagret ikke ett eneste beløp: ordreinntaket hentet bare id, navn, adresse og
-- antall. Uten pengene kan verken salgsoversikt eller månedlig utbetaling bygges.
--
-- Prisene i Shopify inkluderer mva (shop.taxesIncluded = true), så alle beløp her er
-- INKLUSIVE mva med mindre navnet sier noe annet. Provisjonen regnes av bruttobeløpet
-- inkludert mva, etter avtalen med butikkene.

-- Provisjon per butikk, ikke i koden: avtalene kommer til å avvike mellom butikker.
alter table stores add column if not exists commission_pct numeric(5,2) not null default 10.00;
comment on column stores.commission_pct is 'Garnlys andel av bruttosalg inkl. mva, i prosent. Resten utbetales butikken.';

-- Beløp per ordre. Frakt holdes utenfor provisjonsgrunnlaget: Garnly tar fraktinntekten
-- og betaler fraktleverandøren.
alter table routing_orders add column if not exists currency          text;
alter table routing_orders add column if not exists total_inc_vat     numeric(12,2);
alter table routing_orders add column if not exists shipping_inc_vat  numeric(12,2);
alter table routing_orders add column if not exists vat_amount        numeric(12,2);

-- Beløp per gruppe. Gruppa er enheten som tildeles én butikk, og dermed enheten det
-- gjøres opp for. Beløpet er summen av varelinjene i gruppa, uten frakt.
alter table routing_groups add column if not exists gross_inc_vat numeric(12,2);
alter table routing_groups add column if not exists vat_amount    numeric(12,2);

-- Justeringer som skal trekkes fra en senere utbetaling: retur eller refusjon etter at
-- butikken har fått oppgjør. Embrik: «det trekkes bare fra neste måned, det er lettest.»
create table if not exists settlement_adjustments (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references stores(id),
  group_id    uuid references routing_groups(id),
  amount_inc_vat numeric(12,2) not null,   -- negativt = trekk fra butikkens utbetaling
  reason      text not null,
  occurred_at timestamptz not null default now(),
  created_at  timestamptz not null default now()
);
create index if not exists settlement_adjustments_store_idx on settlement_adjustments (store_id, occurred_at);

-- Månedlig oppgjør per butikk. Måneden bestemmes av når gruppa ble tildelt.
create or replace view v_store_settlement as
with salg as (
  select g.assigned_store_id as store_id,
         date_trunc('month', g.assigned_at) as maaned,
         count(*)                           as ordrer,
         sum(coalesce(g.gross_inc_vat, 0))  as brutto_inkl_mva,
         sum(coalesce(g.vat_amount, 0))     as mva
  from routing_groups g
  where g.status = 'assigned' and g.assigned_store_id is not null and g.assigned_at is not null
  group by 1, 2
),
just as (
  select store_id, date_trunc('month', occurred_at) as maaned,
         sum(amount_inc_vat) as justering
  from settlement_adjustments group by 1, 2
)
select s.name                                   as butikk,
       coalesce(salg.store_id, just.store_id)   as store_id,
       coalesce(salg.maaned, just.maaned)       as maaned,
       coalesce(salg.ordrer, 0)                 as ordrer,
       coalesce(salg.brutto_inkl_mva, 0)        as brutto_inkl_mva,
       coalesce(salg.mva, 0)                    as mva,
       s.commission_pct,
       round(coalesce(salg.brutto_inkl_mva, 0) * s.commission_pct / 100, 2) as garnly_provisjon,
       coalesce(just.justering, 0)              as justeringer,
       round(coalesce(salg.brutto_inkl_mva, 0) * (100 - s.commission_pct) / 100, 2)
         + coalesce(just.justering, 0)          as til_utbetaling
from salg
full outer join just on just.store_id = salg.store_id and just.maaned = salg.maaned
join stores s on s.id = coalesce(salg.store_id, just.store_id)
order by maaned desc, butikk;

comment on view v_store_settlement is
  'Månedlig oppgjør per butikk. Brutto er inkl. mva og uten frakt. Justeringer er retur og refusjon som trekkes fra måneden de skjedde i.';
