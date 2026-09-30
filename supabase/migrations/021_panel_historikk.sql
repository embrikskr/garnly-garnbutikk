-- «Tidligere ordrer» i butikkpanelet.
--
-- Når butikken trykker «Slått ut i kassa», forsvinner ordren fra panelet. Da finner de ikke
-- igjen fraktetiketten, sporingen eller hva som lå i pakken – og det trenger de når en kunde
-- ringer, pakken må sendes på nytt, eller etiketten må skrives ut igjen.
--
-- To slags rader:
--   'tildelt'   – ordrer butikken fikk. Full detalj, inkludert leveringsadresse.
--   'avslaatt'  – tilbud butikken sa nei til. Bare at det skjedde.
--
-- **Avslåtte ordrer får ingen kundedata.** Spesifikasjonen ba om «uten kundeadresse», men
-- navnet er også kundedata, og butikken som avslo har ingen bruk for det: de skal verken
-- pakke eller sende. CLAUDE.md sier at panel-viewene ikke skal ha kundedata utover det
-- butikken trenger for å pakke og sende. Nullingen skjer her, i SQL – ikke i panelet, der
-- den kunne blitt borte i en opptegning.
--
-- Som de andre panel-viewene kjører denne som eier og filtrerer selv på current_store_ids().
-- Se 008: da slipper butikken leserett på routing_orders, som har hele Shopify-payloaden.

create or replace view v_panel_history as
-- Ordrer butikken fikk tildelt
select
  g.id                        as group_id,
  g.assigned_store_id         as store_id,
  'tildelt'                   as kind,
  case
    when g.status = 'cancelled'          then 'kansellert'
    when g.pos_deducted_at is not null   then 'slatt_ut'
    when g.fulfilled_at is not null      then 'sendt'
    else                                      'til_pakking'
  end                         as status,
  ro.is_test,
  ro.shopify_order_name       as order_name,
  ro.created_at               as order_created_at,
  g.assigned_at,
  g.fulfilled_at,
  g.pos_deducted_at,
  g.pos_deducted_by,
  g.tracking_number,
  g.tracking_url,
  g.line_items,
  ro.customer ->> 'name'      as ship_name,
  ro.customer ->> 'address1'  as ship_address1,
  ro.customer ->> 'address2'  as ship_address2,
  ro.customer ->> 'zip'       as ship_zip,
  ro.customer ->> 'city'      as ship_city,
  ro.customer ->> 'country'   as ship_country
from routing_groups g
join routing_orders ro on ro.id = g.routing_order_id
where g.assigned_store_id in (select current_store_ids())
  and g.status in ('assigned', 'fulfilled', 'cancelled')

union all

-- Tilbud butikken avslo. Varelinjene er produktinformasjon og vises, så butikken kjenner
-- igjen hva de takket nei til. Kundedata gjør det ikke.
select
  g.id                        as group_id,
  o.store_id,
  'avslaatt'                  as kind,
  'avslatt'                   as status,
  ro.is_test,
  ro.shopify_order_name       as order_name,
  ro.created_at               as order_created_at,
  null::timestamptz           as assigned_at,
  null::timestamptz           as fulfilled_at,
  null::timestamptz           as pos_deducted_at,
  null::text                  as pos_deducted_by,
  null::text                  as tracking_number,
  null::text                  as tracking_url,
  g.line_items,
  null::text                  as ship_name,
  null::text                  as ship_address1,
  null::text                  as ship_address2,
  null::text                  as ship_zip,
  null::text                  as ship_city,
  null::text                  as ship_country
from offers o
join routing_groups g  on g.id = o.routing_group_id
join routing_orders ro on ro.id = g.routing_order_id
where o.store_id in (select current_store_ids())
  and o.status in ('declined', 'declined_stock')
  -- Avslo butikken, men fikk den likevel senere (ny oppdeling), er det den tildelte raden
  -- som gjelder. Uten dette ville samme ordre stått to ganger, én av dem som «Avslått».
  and coalesce(g.assigned_store_id, '00000000-0000-0000-0000-000000000000'::uuid) <> o.store_id;

grant select on v_panel_history to authenticated;

-- Historikken sorteres og filtreres på ordredato, og søkes på ordrenummer.
create index if not exists routing_orders_created_at_idx on routing_orders (created_at desc);
create index if not exists routing_orders_name_idx on routing_orders (shopify_order_name);
