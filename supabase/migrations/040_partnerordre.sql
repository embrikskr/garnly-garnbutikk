-- Ordren i partnerbutikkens egen Shopify (18.11.2026, byggeplan §15b).
--
-- Når en partnerbutikk med egen Shopify (KreStoffer) godtar, lages ordren i deres Shopify
-- (_shared/partner_order.ts). De sender den derfra, og sporingen hentes tilbake hvert kvarter.
-- Panelet viser ordrenummeret hos dem i stedet for etikett og «Slått ut og klar til sending».

alter table routing_groups add column if not exists partner_order_id text;
alter table routing_groups add column if not exists partner_order_name text;
alter table routing_groups add column if not exists partner_order_created_at timestamptz;
alter table routing_groups add column if not exists partner_order_started_at timestamptz;
alter table routing_groups add column if not exists partner_checked_at timestamptz;
alter table routing_groups add column if not exists partner_order_error text;

comment on column routing_groups.partner_order_id is
  'Ordren i partnerbutikkens egen Shopify (gid). Satt når butikken godtok. Se _shared/partner_order.ts.';
comment on column routing_groups.partner_order_started_at is
  'Lås mens ordren lages i butikkens Shopify, så to trykk på Godta ikke gir to ordrer.';
comment on column routing_groups.partner_checked_at is
  'Sist vi så etter sporing i butikkens Shopify (backstop i timeout-sweeper hvert kvarter).';

-- ---------------------------------------------------------------------------
-- Pakkekortet: samme definisjon som i 032, med ordrenummeret hos butikken til slutt.
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
  g.label_printed_via,
  g.partner_order_name
from routing_groups g
join routing_orders ro on ro.id = g.routing_order_id
where g.assigned_store_id in (select current_store_ids())
  and (g.status = 'assigned' or (g.status = 'fulfilled' and g.pos_deducted_at is null));

-- ---------------------------------------------------------------------------
-- Tidligere ordrer: som i 031, med ordrenummeret hos butikken. En partnerordre er «slått ut»
-- i det den lages (butikkens Shopify trekker lageret), men står som «til pakking» til den er sendt.
-- ---------------------------------------------------------------------------
create or replace view v_panel_history as
select
  g.id                        as group_id,
  g.assigned_store_id         as store_id,
  'tildelt'::text             as kind,
  case
    when g.status = 'cancelled' then 'kansellert'
    when g.partner_order_id is not null and g.fulfilled_at is null then 'til_pakking'
    when g.pos_deducted_at is not null then 'slatt_ut'
    when g.fulfilled_at is not null then 'sendt'
    else 'til_pakking'
  end                         as status,
  ro.is_test,
  ro.shopify_order_name       as order_name,
  ro.created_at               as order_created_at,
  g.assigned_at,
  g.fulfilled_at,
  g.pos_deducted_at,
  g.pos_deducted_by,
  g.transferred_at,
  g.carrier,
  g.shipped_at,
  g.service_partner,
  g.tracking_number,
  g.tracking_url,
  g.line_items,
  ro.customer ->> 'name'      as ship_name,
  ro.customer ->> 'address1'  as ship_address1,
  ro.customer ->> 'address2'  as ship_address2,
  ro.customer ->> 'zip'       as ship_zip,
  ro.customer ->> 'city'      as ship_city,
  ro.customer ->> 'country'   as ship_country,
  g.manually_shipped_at,
  (select -sum(a.gross_inc_vat) from settlement_adjustments a where a.group_id = g.id and a.kind = 'refund') as refundert,
  (select max(a.occurred_at)    from settlement_adjustments a where a.group_id = g.id and a.kind = 'refund') as refundert_at,
  g.partner_order_name
from routing_groups g
join routing_orders ro on ro.id = g.routing_order_id
where g.assigned_store_id in (select current_store_ids())
  and g.status in ('assigned', 'fulfilled', 'cancelled')
union all
select
  g.id                        as group_id,
  o.store_id,
  'avslaatt'::text            as kind,
  'avslatt'::text             as status,
  ro.is_test,
  ro.shopify_order_name       as order_name,
  ro.created_at               as order_created_at,
  null::timestamptz           as assigned_at,
  null::timestamptz           as fulfilled_at,
  null::timestamptz           as pos_deducted_at,
  null::text                  as pos_deducted_by,
  null::timestamptz           as transferred_at,
  null::text                  as carrier,
  null::timestamptz           as shipped_at,
  null::jsonb                 as service_partner,
  null::text                  as tracking_number,
  null::text                  as tracking_url,
  g.line_items,
  null::text                  as ship_name,
  null::text                  as ship_address1,
  null::text                  as ship_address2,
  null::text                  as ship_zip,
  null::text                  as ship_city,
  null::text                  as ship_country,
  null::timestamptz           as manually_shipped_at,
  null::numeric               as refundert,
  null::timestamptz           as refundert_at,
  null::text                  as partner_order_name
from offers o
join routing_groups g  on g.id = o.routing_group_id
join routing_orders ro on ro.id = g.routing_order_id
where o.store_id in (select current_store_ids())
  and o.status in ('declined', 'declined_stock')
  and coalesce(g.assigned_store_id, '00000000-0000-0000-0000-000000000000'::uuid) <> o.store_id;

-- Bare lesing, som i 034.
revoke all on v_panel_assigned from anon, authenticated;
revoke all on v_panel_history  from anon, authenticated;
grant select on v_panel_assigned to authenticated;
grant select on v_panel_history  to authenticated;
