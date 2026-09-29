-- Testordrer holdes utenfor oppgjøret, uten at radene må slettes.
--
-- Testordrer skal rutes og pakkes som ekte ordrer – det er hele poenget med å teste – men de
-- skal ikke telle som salg. Uten en regel må hver testordre ryddes for hånd etterpå, og en
-- som blir glemt gir butikken betalt for noe som aldri ble solgt. #1002 (29.09) sto med
-- 255 kr i Strikkefryds oppgjør.
--
-- Flagget settes i order-intake fra Shopify-taggen «TEST» eller Shopifys eget `test`-flagg
-- (testbetaling). Se _shared/testorder.ts.

alter table routing_orders add column if not exists is_test boolean not null default false;

comment on column routing_orders.is_test is
  'Testordre: rutes og pakkes som vanlig, men teller ikke i oppgjør eller panelstatistikk. '
  'Settes fra Shopify-tag «TEST» eller order.test i order-intake.';

create index if not exists routing_orders_is_test_idx on routing_orders (is_test) where is_test;

-- ---------------------------------------------------------------------------
-- Oppgjøret: testordrer ut.
-- ---------------------------------------------------------------------------
create or replace view v_store_settlement as
with salg as (
  select g.assigned_store_id as store_id,
         date_trunc('month', g.assigned_at) as maaned,
         count(*) as ordrer,
         sum(coalesce(g.gross_inc_vat, 0)) as brutto_inkl_mva,
         sum(coalesce(g.vat_amount, 0)) as mva
  from routing_groups g
  join routing_orders ro on ro.id = g.routing_order_id
  where g.status in ('assigned', 'fulfilled')
    and g.assigned_store_id is not null
    and g.assigned_at is not null
    and not ro.is_test
  group by 1, 2
), just as (
  select store_id, date_trunc('month', occurred_at) as maaned, sum(amount_inc_vat) as justering
  from settlement_adjustments group by 1, 2
)
select s.name as butikk,
       coalesce(salg.store_id, just.store_id) as store_id,
       coalesce(salg.maaned, just.maaned) as maaned,
       coalesce(salg.ordrer, 0) as ordrer,
       coalesce(salg.brutto_inkl_mva, 0) as brutto_inkl_mva,
       coalesce(salg.mva, 0) as mva,
       s.commission_pct,
       round(coalesce(salg.brutto_inkl_mva, 0) * s.commission_pct / 100, 2) as garnly_provisjon,
       coalesce(just.justering, 0) as justeringer,
       round(coalesce(salg.brutto_inkl_mva, 0) * (100 - s.commission_pct) / 100, 2) + coalesce(just.justering, 0) as til_utbetaling
from salg
full join just on just.store_id = salg.store_id and just.maaned = salg.maaned
join stores s on s.id = coalesce(salg.store_id, just.store_id)
order by coalesce(salg.maaned, just.maaned) desc, s.name;

alter view v_store_settlement set (security_invoker = on);

-- ---------------------------------------------------------------------------
-- Panelstatistikken: testordrer teller ikke.
--
-- De vises fortsatt som kort i panelet (v_panel_assigned): butikken skal pakke dem og
-- bekrefte kassauttrekk som vanlig. Det er bare tellerne som skal være rene.
-- ---------------------------------------------------------------------------
drop view if exists v_panel_stats;
create view v_panel_stats as
select
  s.id as store_id,
  (select count(*) from offers o
     join routing_groups g on g.id = o.routing_group_id
     join routing_orders ro on ro.id = g.routing_order_id
     where o.store_id = s.id and o.status = 'offered' and g.status = 'routing' and not ro.is_test) as queue,
  (select count(*) from routing_groups g
     join routing_orders ro on ro.id = g.routing_order_id
     where g.assigned_store_id = s.id and g.status = 'assigned' and not ro.is_test)                 as to_pack,
  (select count(*) from routing_groups g
     join routing_orders ro on ro.id = g.routing_order_id
     where g.assigned_store_id = s.id and g.status = 'fulfilled'
       and g.pos_deducted_at is null and not ro.is_test)                                            as awaiting_pos,
  (select count(*) from routing_groups g
     join routing_orders ro on ro.id = g.routing_order_id
     where g.assigned_store_id = s.id and g.assigned_at >= date_trunc('day', now())
       and g.status in ('assigned', 'fulfilled') and not ro.is_test)                                as assigned_today
from stores s
where s.id in (select current_store_ids());

grant select on v_panel_stats to authenticated;

-- ---------------------------------------------------------------------------
-- #1002 (29.09) er en testordre. Den er sendt og kan ikke kanselleres i Shopify uten å
-- avbryte distribusjonen, og lageret er allerede riktig. Den merkes i stedet.
-- ---------------------------------------------------------------------------
update routing_orders
set is_test = true
where shopify_order_id = 'gid://shopify/Order/18912738574396';
