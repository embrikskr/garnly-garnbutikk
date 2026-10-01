-- Garnly-admin: én rolle som ser alt, og handlingene som trengs når rutingen stopper.
--
-- Til nå har eskalerte ordrer bare havnet i en e-post til ops. Står den uåpnet, blir ordren
-- liggende på hold i Shopify uten at noen ser det. Admin-fanen i butikkpanelet er stedet der
-- det faktisk vises – og der det kan rettes.
--
-- Rollen er en egen tabell, ikke store_users.role = 'admin': store_users har store_id som
-- primærnøkkeldel og not null, så en admin måtte knyttes til en vilkårlig butikk. Da ville
-- admin-brukeren dukket opp som butikk i panelet, og butikkvelgeren ville vist Garnly som et
-- sted ordrer kan sendes til.

create table if not exists garnly_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  name       text,
  created_at timestamptz not null default now()
);
comment on table garnly_admins is
  'Garnly-ansatte med full innsyn i panelet. Bevisst adskilt fra store_users: en admin er ikke en butikk.';

alter table garnly_admins enable row level security;

-- Admin skal kunne se at hen selv er admin. Ingen skrivepolicy: rollen gis av Garnly med
-- service role, ikke fra panelet.
create policy garnly_admins_self on garnly_admins
  for select to authenticated
  using (user_id = auth.uid());

-- security definer fordi den leser garnly_admins, som selv er RLS-beskyttet.
create or replace function is_garnly_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from garnly_admins where user_id = auth.uid());
$$;
revoke all on function is_garnly_admin() from public;
grant execute on function is_garnly_admin() to authenticated;

-- Admin må kunne se butikklista for å kunne gi en ordre til en av dem. Butikkbrukernes
-- egen policy (stores_own, 008) står urørt – denne legger seg ved siden av.
create policy stores_admin on stores
  for select to authenticated
  using (is_garnly_admin());

-- ---------------------------------------------------------------------------
-- Admin-viewene.
--
-- Samme mønster som panel-viewene i 008: de kjører som eier og filtrerer SELV på
-- is_garnly_admin(). En butikkbruker som spør får null rader, ikke en feil – og ingen av dem
-- får leserett på tabellene under. Derfor heller ikke security_invoker her.
-- ---------------------------------------------------------------------------

-- a) Trenger handling: eskalerte grupper, og tilbud som står ubesvart etter fristen.
create or replace view v_admin_action_needed as
-- Eskalert: ingen butikk kunne ta den
select
  'eskalert'                  as arsak,
  g.id                        as group_id,
  ro.id                       as order_id,
  ro.shopify_order_id,
  ro.shopify_order_name       as order_name,
  ro.is_test,
  ro.created_at               as order_created_at,
  g.created_at                as ventet_siden,
  null::timestamptz           as deadline_at,
  null::uuid                  as store_id,
  null::text                  as store_name,
  g.line_items,
  ro.customer ->> 'name'      as kunde,
  ro.customer ->> 'zip'       as kunde_postnr,
  ro.customer ->> 'city'      as kunde_sted,
  -- Hvem som har sagt nei, og hva de sa. Uten dette må man gjette hvorfor den står fast.
  (select coalesce(jsonb_agg(jsonb_build_object(
            'butikk', s2.name, 'status', o2.status,
            'begrunnelse', o2.response_note, 'svart', o2.responded_at)
          order by o2.sequence_no), '[]'::jsonb)
     from offers o2 join stores s2 on s2.id = o2.store_id
    where o2.routing_group_id = g.id and o2.status <> 'pending') as svar
from routing_groups g
join routing_orders ro on ro.id = g.routing_order_id
where g.status = 'escalated'
  and is_garnly_admin()

union all

-- Fristen er gått ut, men sveipet har ikke rukket å flytte den videre ennå
select
  'frist_utlopt'              as arsak,
  g.id                        as group_id,
  ro.id                       as order_id,
  ro.shopify_order_id,
  ro.shopify_order_name       as order_name,
  ro.is_test,
  ro.created_at               as order_created_at,
  o.offered_at                as ventet_siden,
  o.deadline_at,
  o.store_id,
  s.name                      as store_name,
  g.line_items,
  ro.customer ->> 'name'      as kunde,
  ro.customer ->> 'zip'       as kunde_postnr,
  ro.customer ->> 'city'      as kunde_sted,
  '[]'::jsonb                 as svar
from offers o
join routing_groups g  on g.id = o.routing_group_id
join routing_orders ro on ro.id = g.routing_order_id
join stores s          on s.id = o.store_id
where o.status = 'offered'
  and o.deadline_at < now()
  and g.status = 'routing'
  and is_garnly_admin();

grant select on v_admin_action_needed to authenticated;

-- b) Alle ordrer på tvers av butikker.
create or replace view v_admin_orders as
select
  g.id                        as group_id,
  ro.id                       as order_id,
  ro.shopify_order_id,
  ro.shopify_order_name       as order_name,
  ro.is_test,
  ro.created_at               as order_created_at,
  g.status                    as group_status,
  g.assigned_store_id         as store_id,
  s.name                      as store_name,
  g.assigned_at,
  g.fulfilled_at,
  g.pos_deducted_at,
  g.transferred_at,
  g.tracking_number,
  g.tracking_url,
  g.carrier,
  g.ship_error,
  g.line_items,
  ro.customer ->> 'name'      as kunde,
  -- Fristen som gjelder nå: tilbudet som ligger ute.
  (select min(o.deadline_at) from offers o
    where o.routing_group_id = g.id and o.status = 'offered') as deadline_at,
  (select s3.name from offers o join stores s3 on s3.id = o.store_id
    where o.routing_group_id = g.id and o.status = 'offered'
    order by o.sequence_no desc limit 1)                      as tilbudt_butikk
from routing_groups g
join routing_orders ro on ro.id = g.routing_order_id
left join stores s on s.id = g.assigned_store_id
where g.status <> 'resplit'
  and g.status <> 'archived'
  and is_garnly_admin();

grant select on v_admin_orders to authenticated;

-- c) Oppgjør per butikk. v_store_settlement kjører med security_invoker og gir admin
--    ingenting, siden admin ikke har RLS-lesetilgang på tabellene under. Denne kjører som
--    eier, med samme regnestykke.
create or replace view v_admin_settlement as
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
where is_garnly_admin()
order by coalesce(salg.maaned, just.maaned) desc, s.name;

grant select on v_admin_settlement to authenticated;

-- d) Synkstatus. Grønt eller feilmelding, per butikk.
create or replace view v_admin_sync as
select
  s.id                         as store_id,
  s.name                       as butikk,
  s.pos_system,
  s.active,
  s.last_sync_at,
  s.last_sync_status,
  s.last_sync_rows,
  s.consecutive_sync_failures,
  -- Siste feil, uansett hvor lenge siden: den forteller hva som pleier å ryke.
  (select jsonb_build_object('nar', a.created_at, 'feil', a.payload ->> 'error')
     from audit_log a
    where a.entity = 'store' and a.entity_id = s.id and a.event = 'sync_failed'
    order by a.created_at desc limit 1)                                   as siste_feil,
  (select count(*) from audit_log a
    where a.entity = 'store' and a.entity_id = s.id and a.event = 'sync_failed'
      and a.created_at > now() - interval '7 days')                       as feil_siste_uke
from stores s
where is_garnly_admin();

grant select on v_admin_sync to authenticated;

-- e) Nøkkeltall.
create or replace view v_admin_stats as
select
  (select count(*) from v_admin_action_needed)                                     as trenger_handling,
  (select count(*) from routing_groups g join routing_orders ro on ro.id = g.routing_order_id
    where g.status = 'routing' and not ro.is_test)                                 as ute_pa_tilbud,
  (select count(*) from routing_groups g join routing_orders ro on ro.id = g.routing_order_id
    where g.status = 'assigned' and not ro.is_test)                                as til_pakking,
  (select count(*) from routing_groups g join routing_orders ro on ro.id = g.routing_order_id
    where g.status = 'fulfilled' and g.pos_deducted_at is null and not ro.is_test) as venter_kassauttrekk,
  (select count(*) from routing_groups g join routing_orders ro on ro.id = g.routing_order_id
    where g.assigned_at >= date_trunc('day', now()) and not ro.is_test)            as tildelt_i_dag,
  (select count(*) from stores where active and consecutive_sync_failures > 0)     as butikker_med_synkfeil
where is_garnly_admin();

grant select on v_admin_stats to authenticated;
