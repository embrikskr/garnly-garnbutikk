-- 043: Valutagebyret deles med butikken som er selger (KreStoffer, 24.11.2026)
--
-- Shopify Payments tar 2 % når kunden betaler i DKK og Garnly får utbetalt i NOK. Embrik 24.11.2026:
-- prisene i Danmark settes 2 % opp (prislisten «Danmark +2 % (valutagebyr)» i Shopify, rundet til
-- hele kroner), og valutagebyret deles. Butikken trekkes stores.fx_fee_store_pct (KreStoffer 1 %) av
-- alt kunden betalte (varer og frakt i DKK); Garnly bærer resten.
--
-- Trekket står i kolonnen gebyr i regneboka, som betalingsgebyret gjør for de norske butikkene:
-- grunnlag = varesalg + fraktinntekt − gebyr, og butikken får grunnlaget minus provisjonen.
-- Satsen fryses på gruppa når butikken får ordren, som provisjonen. Refusjoner endrer ikke trekket:
-- Shopify gir ikke valutagebyret tilbake.
--
-- Trygg å kjøre flere ganger. Ingen DROP.

alter table stores add column if not exists fx_fee_store_pct numeric(5,2) not null default 0;
comment on column stores.fx_fee_store_pct is
  'Butikkens del av valutagebyret, i prosent av alt kunden betalte i butikkens valuta. Bare for butikker som er selger (043).';
update stores set fx_fee_store_pct = 1.00 where slug = 'krestoffer' and is_seller and fx_fee_store_pct = 0;

alter table routing_groups add column if not exists fx_fee_store_pct numeric(5,2);
comment on column routing_groups.fx_fee_store_pct is 'Butikkens del av valutagebyret da den fikk ordren. Satt av trigger.';

create or replace function routing_group_commission()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.assigned_store_id is null then
    new.commission_pct := null;
    new.shipping_cost_ex_vat := null;
    new.payment_fee_on_store := null;
    new.store_is_seller := null;
    new.fx_fee_store_pct := null;
  elsif tg_op = 'INSERT' or new.assigned_store_id is distinct from old.assigned_store_id then
    select commission_pct, shipping_cost_ex_vat, payment_fee_on_store, is_seller, fx_fee_store_pct
      into new.commission_pct, new.shipping_cost_ex_vat, new.payment_fee_on_store, new.store_is_seller, new.fx_fee_store_pct
      from stores where id = new.assigned_store_id;
  end if;
  return new;
end $$;

update routing_groups g set fx_fee_store_pct = s.fx_fee_store_pct
  from stores s where s.id = g.assigned_store_id and g.fx_fee_store_pct is null;

-- Regneboka (042) med butikkens del av valutagebyret i gebyr.
create or replace view settlement_ledger with (security_invoker = true) as
with tildelt as (
  select g.id, g.routing_order_id, g.assigned_store_id as store_id, g.fulfilled_at,
         coalesce(g.gross_inc_vat, 0)                                   as gross,
         coalesce(g.commission_pct, s.commission_pct)                   as garnly_pct,
         coalesce(g.store_is_seller, s.is_seller)                       as selger,
         case when coalesce(g.store_is_seller, s.is_seller) then 0
              else coalesce(g.shipping_cost_ex_vat, s.shipping_cost_ex_vat) end as fraktkostnad,
         coalesce(g.payment_fee_on_store, s.payment_fee_on_store)       as fee_on_store,
         g.gross_presentment, g.shipping_presentment,
         coalesce(g.fx_fee_store_pct, s.fx_fee_store_pct, 0)             as fx_pct,
         coalesce(g.presentment_currency, s.settlement_currency)        as butikk_valuta,
         ro.shopify_order_id, ro.shopify_order_name, ro.shipping_inc_vat, ro.payment_fee,
         row_number() over (partition by g.routing_order_id order by g.group_no) as rn,
         sum(coalesce(g.gross_inc_vat, 0)) over (partition by g.routing_order_id) as order_gross
  from routing_groups g
  join routing_orders ro on ro.id = g.routing_order_id
  join stores s          on s.id = g.assigned_store_id
  where g.status in ('assigned', 'fulfilled')
    and g.assigned_at is not null
    and not ro.is_test
), andre as (
  select t.*,
         case when t.payment_fee is null or t.rn = 1 then null
              when t.order_gross > 0 then round(t.payment_fee * t.gross / t.order_gross, 2)
              else 0 end as gebyr_andre
  from tildelt t
), fordelt as (
  select a.*,
         case when a.payment_fee is null then null
              when a.rn = 1 then a.payment_fee - coalesce(sum(a.gebyr_andre) over (partition by a.routing_order_id), 0)
              else a.gebyr_andre end as gebyr_andel
  from andre a
), salg as (
  select f.*,
         case when f.selger then f.gross_presentment
              else settlement_ex_vat(f.gross) end                                     as varesalg,
         case when f.selger then coalesce(f.shipping_presentment, 0)
              when f.rn = 1 then settlement_ex_vat(f.shipping_inc_vat) else 0 end     as fraktinntekt,
         -- Selgerbutikken: butikkens del av valutagebyret, en avtalt prosent av alt kunden betalte.
         case when f.selger then round((f.gross_presentment + coalesce(f.shipping_presentment, 0)) * f.fx_pct / 100, 2)
              when f.fee_on_store then f.gebyr_andel else 0 end                       as gebyr,
         case when f.selger then f.gross_presentment is null
              else (f.fee_on_store and f.payment_fee is null) end                     as gebyr_mangler,
         case when f.selger then f.butikk_valuta else 'NOK' end                       as valuta
  from fordelt f
  where f.fulfilled_at is not null
), regnet as (
  select s.*,
         s.varesalg + s.fraktinntekt - s.fraktkostnad - coalesce(s.gebyr, 0)          as grunnlag,
         case when s.selger then round(settlement_ex_vat(s.varesalg) * s.garnly_pct / 100, 2) end as provisjon
  from salg s
)
select
  'salg'::text                                              as art,
  r.store_id,
  r.id                                                      as group_id,
  null::uuid                                                as adjustment_id,
  r.shopify_order_id,
  r.shopify_order_name                                      as order_name,
  (r.fulfilled_at at time zone 'Europe/Oslo')::date         as dato,
  settlement_period_for(r.store_id, oslo_period(r.fulfilled_at), r.id, null) as periode,
  r.varesalg,
  r.fraktinntekt,
  r.fraktkostnad,
  r.gebyr,
  r.gebyr_mangler,
  r.grunnlag,
  100 - r.garnly_pct                                        as butikk_pct,
  case when r.selger then r.grunnlag - r.provisjon
       else round(r.grunnlag * (100 - r.garnly_pct) / 100, 2) end as butikk,
  case when r.selger then r.provisjon
       else r.grunnlag - round(r.grunnlag * (100 - r.garnly_pct) / 100, 2) end as garnly,
  null::numeric                                             as refundert,
  null::numeric                                             as trekk,
  null::text                                                as beskrivelse,
  r.fulfilled_at                                            as tidspunkt,
  r.valuta
from regnet r

union all

select
  case a.kind when 'refund' then 'retur' else 'justering' end,
  a.store_id,
  a.group_id,
  a.id,
  ro.shopify_order_id,
  ro.shopify_order_name,
  (a.occurred_at at time zone 'Europe/Oslo')::date,
  settlement_period_for(a.store_id, oslo_period(a.occurred_at), null, a.id),
  null, null, null, null, false, null, null, null, null,
  case when coalesce(g.store_is_seller, s.is_seller) then a.gross_presentment else a.gross_inc_vat end,
  a.amount_inc_vat,
  a.reason,
  a.occurred_at,
  case when coalesce(g.store_is_seller, s.is_seller) then s.settlement_currency else 'NOK' end
from settlement_adjustments a
join stores s               on s.id = a.store_id
left join routing_groups g  on g.id = a.group_id
left join routing_orders ro on ro.id = g.routing_order_id
where not coalesce(ro.is_test, false);

revoke all on settlement_ledger from anon, authenticated;
grant select on settlement_ledger to service_role;
revoke execute on function routing_group_commission() from public, anon, authenticated;
