-- Tar i bruk statusene fra 015, og retter to lagerfeil funnet i testen 29.09.
--
-- Alle views som filtrerte på `status = 'assigned'` må med her. Glemmes ett av dem,
-- forsvinner enten kassauttrekket eller oppgjøret uten en eneste feilmelding.

-- ---------------------------------------------------------------------------
-- 1. Kassauttrekk, nå med nettoberegning.
--
-- To tilfeller trekker i hver sin retning:
--
--   sendt, ikke slått ut i kassa   → kassa teller varer som er ute av butikken. Trekk fra.
--   slått ut i kassa, ikke sendt   → kassa har alt trukket, men Shopify holder varene som
--                                    `committed` og trekker dem fra `available` selv.
--                                    Trekker vi fra her også, trekkes de dobbelt. Legg tilbake.
--
-- Det andre tilfellet er normalt: butikken slår ofte ut i kassa når de plukker, før sendingen
-- er opprettet i CargonizerConnect. Uten pluss-leddet ville hver eneste ordre vist for lite på
-- lager i vinduet mellom plukk og sending.
-- ---------------------------------------------------------------------------
create or replace view v_pos_pending_deduction as
select
  g.assigned_store_id         as store_id,
  (li ->> 'product_id')::uuid as product_id,
  sum(
    case
      when g.fulfilled_at is not null and g.pos_deducted_at is null then  (li ->> 'qty')::int
      when g.pos_deducted_at is not null and g.fulfilled_at is null then -(li ->> 'qty')::int
      else 0
    end
  ) as qty
from routing_groups g
cross join lateral jsonb_array_elements(g.line_items) as li
where g.assigned_store_id is not null
  and g.status in ('assigned', 'fulfilled')
  and li ? 'product_id'
  and li ->> 'product_id' is not null
group by 1, 2
having sum(
  case
    when g.fulfilled_at is not null and g.pos_deducted_at is null then  (li ->> 'qty')::int
    when g.pos_deducted_at is not null and g.fulfilled_at is null then -(li ->> 'qty')::int
    else 0
  end
) <> 0;

alter view v_pos_pending_deduction set (security_invoker = on);
revoke all on v_pos_pending_deduction from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Produkter som nettopp byttet tilstand.
--
-- sync-store sammenligner mot sin egen forrige utregning, ikke mot Shopify. Endrer Shopify
-- `on_hand` selv – ved fulfillment, retur med restock eller manuell retting – og vårt tall
-- havner likt med forrige verdi, skrives ingenting og Shopify blir stående feil.
--
-- Reprodusert 29.09: #1002 ble sendt og slått ut i kassa mellom to synker, uten at kassetallet
-- endret seg. Synken regnet 55 = forrige 55 og hoppet over. Shopify ble stående på 52.
--
-- Disse produktene tas derfor alltid med i skrivelista, uavhengig av diff.
-- ---------------------------------------------------------------------------
create or replace view v_pos_recent_transitions as
select distinct
  g.assigned_store_id         as store_id,
  (li ->> 'product_id')::uuid as product_id
from routing_groups g
cross join lateral jsonb_array_elements(g.line_items) as li
where g.assigned_store_id is not null
  and g.status in ('assigned', 'fulfilled')
  and greatest(coalesce(g.fulfilled_at, 'epoch'::timestamptz), coalesce(g.pos_deducted_at, 'epoch'::timestamptz))
      > now() - interval '24 hours'
  and li ? 'product_id'
  and li ->> 'product_id' is not null;

alter view v_pos_recent_transitions set (security_invoker = on);
revoke all on v_pos_recent_transitions from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Panelet: sendte ordrer skal ut av pakkelista, men stå til kassauttrekket er bekreftet.
-- ---------------------------------------------------------------------------
drop view if exists v_panel_assigned;
create view v_panel_assigned as
select
  g.id                        as group_id,
  g.assigned_store_id         as store_id,
  g.status                    as group_status,
  g.line_items,
  g.assigned_at,
  g.tracking_number,
  g.tracking_url,
  g.fulfilled_at,
  g.pos_deducted_at,
  ro.shopify_order_name       as order_name,
  ro.customer ->> 'name'      as ship_name,
  ro.customer ->> 'address1'  as ship_address1,
  ro.customer ->> 'address2'  as ship_address2,
  ro.customer ->> 'zip'       as ship_zip,
  ro.customer ->> 'city'      as ship_city,
  ro.customer ->> 'country'   as ship_country
from routing_groups g
join routing_orders ro on ro.id = g.routing_order_id
where g.assigned_store_id in (select current_store_ids())
  and (
    g.status = 'assigned'                                      -- skal pakkes
    or (g.status = 'fulfilled' and g.pos_deducted_at is null)   -- sendt, venter på kassa
  );

grant select on v_panel_assigned to authenticated;

drop view if exists v_panel_stats;
create view v_panel_stats as
select
  s.id as store_id,
  (select count(*) from offers o join routing_groups g on g.id = o.routing_group_id
     where o.store_id = s.id and o.status = 'offered' and g.status = 'routing')              as queue,
  (select count(*) from routing_groups g
     where g.assigned_store_id = s.id and g.status = 'assigned')                             as to_pack,
  -- Sendt, men ikke bekreftet slått ut i kassa. Til det er gjort holder Garnly igjen varene.
  (select count(*) from routing_groups g
     where g.assigned_store_id = s.id and g.status = 'fulfilled' and g.pos_deducted_at is null) as awaiting_pos,
  (select count(*) from routing_groups g
     where g.assigned_store_id = s.id and g.assigned_at >= date_trunc('day', now())
       and g.status in ('assigned', 'fulfilled'))                                            as assigned_today
from stores s
where s.id in (select current_store_ids());

grant select on v_panel_stats to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Oppgjør: en sendt ordre er like mye et salg som en tildelt.
--    Uten `fulfilled` her ville hver ordre falt ut av oppgjøret i det den ble sendt.
-- ---------------------------------------------------------------------------
create or replace view v_store_settlement as
with salg as (
  select g.assigned_store_id as store_id,
         date_trunc('month', g.assigned_at) as maaned,
         count(*) as ordrer,
         sum(coalesce(g.gross_inc_vat, 0)) as brutto_inkl_mva,
         sum(coalesce(g.vat_amount, 0)) as mva
  from routing_groups g
  where g.status in ('assigned', 'fulfilled')
    and g.assigned_store_id is not null
    and g.assigned_at is not null
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
-- 5. Rader fra den gamle Shopify-butikken arkiveres.
--
-- De har de samme ordrenavnene (#1001–#1003) som de nye testordrene, og fulfillment
-- order-id-ene peker på en butikk som ikke finnes lenger. To av dem sto som `assigned` og
-- dukket derfor opp både i panelets pakkeliste og i oppgjøret – uten beløp, men de talte som
-- ordrer. Flyttingen skjedde 27.09.
-- ---------------------------------------------------------------------------
update routing_groups g
set status = 'archived'
from routing_orders ro
where ro.id = g.routing_order_id
  and ro.created_at < '2026-09-27'::date
  and g.status in ('assigned', 'fulfilled');
