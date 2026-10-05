-- Etiketten kan skrives ut fra «Til pakking», og en kansellert ordre rydder etter seg.
--
-- Før kunne etiketten bare hentes etter «Slått ut og klar til sending» – da var pakken alt
-- ferdig, og butikken måtte åpne kortet igjen under «Tidligere ordrer» for å teipe den på.
-- Nå lager etikett-ikonet i «Til pakking» sendingen i Cargonizer, ALLTID uten overføring.
-- «Slått ut og klar til sending» gjenbruker den og melder den inn til PostNord.
--
-- Kanselleres ordren mellom etikett og sending, slettes den uoverførte sendingen i Cargonizer.
-- Går ikke det, står ordren under «Trenger handling» med beskjed om å slette den for hånd.
-- Se functions/_shared/{sending,etikett,annullering}.ts.

alter table routing_groups
  add column if not exists label_printed_at       timestamptz,
  add column if not exists label_printed_via      text,
  add column if not exists consignment_lock_at    timestamptz,
  add column if not exists consignment_voided_at  timestamptz,
  add column if not exists consignment_void_error text;

comment on column routing_groups.label_printed_at is
  'Sist etiketten ble skrevet ut (DirectPrint) eller hentet som PDF. Sendeknappen skriver den ikke ut igjen.';
comment on column routing_groups.label_printed_via is 'skriver = DirectPrint, pdf = hentet i panelet.';
comment on column routing_groups.consignment_lock_at is
  'Satt mens en sending lages i Cargonizer, så to trykk tett i tid ikke gir to sendinger. Eldre enn 2 min regnes som etterlatt.';
comment on column routing_groups.consignment_voided_at is
  'Ordren ble kansellert, og den uoverførte sendingen er slettet i Cargonizer (eller funnet borte).';
comment on column routing_groups.consignment_void_error is
  'Sendingen kunne ikke slettes automatisk. Står under «Trenger handling» til den er borte.';

-- ---------------------------------------------------------------------------
-- Pakkekortet viser «Etikett skrevet ut». Samme definisjon som i 029, med to kolonner til.
-- ---------------------------------------------------------------------------
create or replace view v_panel_assigned as
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
  g.transferred_at,
  g.carrier,
  g.shipped_at,
  g.ship_step,
  g.ship_error,
  g.service_partner,
  ro.is_test,
  ro.shopify_order_name       as order_name,
  ro.customer ->> 'name'      as ship_name,
  ro.customer ->> 'address1'  as ship_address1,
  ro.customer ->> 'address2'  as ship_address2,
  ro.customer ->> 'zip'       as ship_zip,
  ro.customer ->> 'city'      as ship_city,
  ro.customer ->> 'country'   as ship_country,
  g.manually_shipped_at,
  g.label_printed_at,
  g.label_printed_via
from routing_groups g
join routing_orders ro on ro.id = g.routing_order_id
where g.assigned_store_id in (select current_store_ids())
  and (g.status = 'assigned' or (g.status = 'fulfilled' and g.pos_deducted_at is null));

-- ---------------------------------------------------------------------------
-- «Trenger handling»: fjerde årsak, en sending som må slettes for hånd.
-- ---------------------------------------------------------------------------
create or replace view v_admin_action_needed as
select
  'eskalert'::text            as arsak,
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

select
  'frist_utlopt'::text,
  g.id, ro.id, ro.shopify_order_id, ro.shopify_order_name, ro.is_test, ro.created_at,
  o.offered_at, o.deadline_at, o.store_id, s.name, g.line_items,
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

select
  'sending_feilet'::text,
  g.id, ro.id, ro.shopify_order_id, ro.shopify_order_name, ro.is_test, ro.created_at,
  coalesce((select max(a.created_at) from audit_log a
             where a.entity = 'routing_group' and a.entity_id = g.id and a.event = 'ship_failed'), g.assigned_at),
  null::timestamptz, g.assigned_store_id, s.name, g.line_items,
  ro.customer ->> 'name', ro.customer ->> 'zip', ro.customer ->> 'city',
  '[]'::jsonb, g.ship_step, g.ship_error
from routing_groups g
join routing_orders ro on ro.id = g.routing_order_id
left join stores s     on s.id = g.assigned_store_id
where g.status = 'assigned'
  and g.ship_error is not null
  and is_garnly_admin()

union all

-- Kansellert i Shopify etter at etiketten ble laget, og sendingen lot seg ikke slette.
select
  'sending_ma_slettes'::text,
  g.id, ro.id, ro.shopify_order_id, ro.shopify_order_name, ro.is_test, ro.created_at,
  coalesce((select max(a.created_at) from audit_log a
             where a.entity = 'routing_group' and a.entity_id = g.id and a.event = 'consignment_delete_failed'), g.created_at),
  null::timestamptz, g.assigned_store_id, s.name, g.line_items,
  ro.customer ->> 'name', ro.customer ->> 'zip', ro.customer ->> 'city',
  '[]'::jsonb, 'sletting'::text,
  'Sending ' || coalesce(g.cargonizer_consignment_id::text, '?') || ' i Cargonizer er ikke overført. Slett den manuelt. ('
    || g.consignment_void_error || ')'
from routing_groups g
join routing_orders ro on ro.id = g.routing_order_id
left join stores s     on s.id = g.assigned_store_id
where ro.status = 'cancelled'
  and g.consignment_void_error is not null
  and g.consignment_voided_at is null
  and g.transferred_at is null
  and is_garnly_admin();

-- ---------------------------------------------------------------------------
-- Backstop: prøver slettingen igjen, og lukker saken når sendingen er borte (også om den er
-- slettet for hånd).
-- ---------------------------------------------------------------------------
select cron.schedule('void-consignments', '7,37 * * * *',
  $$ select call_edge_function('order-cancelled', '{"mode":"void_backstop"}'::jsonb) $$);
