-- En sending som stopper, havner hos Garnly.
--
-- Reserveknappen i panelet («sendt på annen måte – registrer bare kassauttrekk») er fjernet.
-- Den registrerte uttrekket, men ordren ble stående som `assigned`: kortet lå igjen i
-- pakkelista, og Shopify fikk aldri vite at pakken var sendt. Feiler «Slått ut og klar til
-- sending» nå – kunden mangler mobilnummer, pakken er over 10 kg, ingen pakkeboks i nærheten –
-- sier kortet «Kontakt Garnly», og ordren står her i «Trenger handling».
--
-- Garnly sender den manuelt og fulfiller i Shopify. Webhooken (fulfillments/create) setter da
-- gruppen til `fulfilled`, og den forsvinner både fra pakkelista og herfra av seg selv.
--
-- To nye kolonner til slutt i viewet: feilsteg og feilmelding. Null for de andre årsakene.
-- v_admin_stats leser fra viewet og må gjenskapes med det.

drop view if exists v_admin_stats;
drop view if exists v_admin_action_needed;

create view v_admin_action_needed as
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
  (select coalesce(jsonb_agg(jsonb_build_object(
            'butikk', s2.name, 'status', o2.status,
            'begrunnelse', o2.response_note, 'svart', o2.responded_at)
          order by o2.sequence_no), '[]'::jsonb)
     from offers o2 join stores s2 on s2.id = o2.store_id
    where o2.routing_group_id = g.id and o2.status <> 'pending') as svar,
  null::text                  as feilsteg,
  null::text                  as feilmelding
from routing_groups g
join routing_orders ro on ro.id = g.routing_order_id
where g.status = 'escalated'
  and is_garnly_admin()

union all

-- Fristen er gått ut, men sveipet har ikke rukket å flytte den videre ennå
select
  'frist_utlopt', g.id, ro.id, ro.shopify_order_id, ro.shopify_order_name, ro.is_test,
  ro.created_at, o.offered_at, o.deadline_at, o.store_id, s.name, g.line_items,
  ro.customer ->> 'name', ro.customer ->> 'zip', ro.customer ->> 'city',
  '[]'::jsonb, null::text, null::text
from offers o
join routing_groups g  on g.id = o.routing_group_id
join routing_orders ro on ro.id = g.routing_order_id
join stores s          on s.id = o.store_id
where o.status = 'offered'
  and o.deadline_at < now()
  and g.status = 'routing'
  and is_garnly_admin()

union all

-- Butikken har trykket «Slått ut og klar til sending», og sendingen stoppet
select
  'sending_feilet', g.id, ro.id, ro.shopify_order_id, ro.shopify_order_name, ro.is_test,
  ro.created_at,
  -- Når den stoppet. Står ikke på gruppen, men i revisjonsloggen.
  coalesce((select max(a.created_at) from audit_log a
             where a.entity = 'routing_group' and a.entity_id = g.id and a.event = 'ship_failed'),
           g.assigned_at),
  null::timestamptz, g.assigned_store_id, s.name, g.line_items,
  ro.customer ->> 'name', ro.customer ->> 'zip', ro.customer ->> 'city',
  '[]'::jsonb, g.ship_step, g.ship_error
from routing_groups g
join routing_orders ro on ro.id = g.routing_order_id
left join stores s     on s.id = g.assigned_store_id
where g.status = 'assigned'
  and g.ship_error is not null
  and is_garnly_admin();

grant select on v_admin_action_needed to authenticated;

create view v_admin_stats as
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
