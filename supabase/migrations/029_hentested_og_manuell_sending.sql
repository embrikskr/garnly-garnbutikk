-- To justeringer etter at reserveknappen ble fjernet.
--
-- 1) Hentested som reserve når det ikke finnes pakkeboks.
--    Parcel Locker (postnord_mypack_small) finnes ikke overalt. Sjekket 01.10.2026 mot
--    /service_partners.xml: 9990 Båtsfjord, 9760 Honningsvåg, 8700 Nesna, 3864 Rauland og
--    5966 Eivindvik har null pakkebokser, men fem vanlige hentesteder hver. Der sender vi nå
--    som PostNord Service Point (`mypack`, «MyPack Collect») i stedet for å stoppe. Feiler
--    bare hvis det heller ikke finnes hentested (6997 hadde ingen av delene).
--
--    Produktet ligger i stores, som resten av fraktoppsettet – ikke i koden. Begge butikkenes
--    PostNord-avtale (37187 og 37185) har `mypack`, lest ut av transport_agreements.xml.
--    Service Point krever pakkested og vekt, men ikke mobilnummer, og har SMS-varsling.
--
-- 2) «Sendt manuelt» i stedet for evig overføringsforsøk.
--    Fulfilles en ordre i Shopify med et annet fraktselskap enn PostNord, eller uten noen
--    Cargonizer-sending, har vi ingenting å overføre. Før prøvde backstoppen hvert kvarter og
--    varslet drift etter tre forsøk – om en pakke som var sendt helt fint. Nå markeres den
--    med `manually_shipped_at`, og backstoppen lar den være.

alter table stores add column if not exists shipping_product_fallback text;
comment on column stores.shipping_product_fallback is
  'Produkt som brukes når shipping_product ikke har pakkested nær kunden. For PostNord: '
  'mypack (Service Point / MyPack Collect) når det ikke finnes Parcel Locker. Null = ingen reserve.';
update stores set shipping_product_fallback = 'mypack'
 where shipping_product = 'postnord_mypack_small' and shipping_product_fallback is null;

alter table routing_groups add column if not exists manually_shipped_at timestamptz;
comment on column routing_groups.manually_shipped_at is
  'Sendt utenom Garnlys Cargonizer-flyt (annet fraktselskap, eller ingen Cargonizer-sending). '
  'Da finnes det ingenting å overføre, og overføringsbackstoppen hopper over gruppen.';

-- Backstoppens indeks skal ikke ta med manuelt sendte.
drop index if exists routing_groups_transfer_pending_idx;
create index routing_groups_transfer_pending_idx
  on routing_groups (transfer_checked_at)
  where transferred_at is null and fulfilled_at is not null and manually_shipped_at is null;

-- Panelet: «Sendt manuelt» skal vises der overføringen ellers står. Uten det ville kortet
-- sagt «Ikke overført til transportør ennå» om en pakke som er sendt helt fint.
-- Kolonnen legges til SIST, så create or replace holder.
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
  g.manually_shipped_at
from routing_groups g
join routing_orders ro on ro.id = g.routing_order_id
where g.assigned_store_id in (select current_store_ids())
  and (
    g.status = 'assigned'
    or (g.status = 'fulfilled' and g.pos_deducted_at is null)
  );

create or replace view v_panel_history as
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
  g.manually_shipped_at
from routing_groups g
join routing_orders ro on ro.id = g.routing_order_id
where g.assigned_store_id in (select current_store_ids())
  and g.status in ('assigned', 'fulfilled', 'cancelled')

union all

select
  g.id, o.store_id, 'avslaatt', 'avslatt', ro.is_test, ro.shopify_order_name, ro.created_at,
  null::timestamptz, null::timestamptz, null::timestamptz, null::text,
  null::timestamptz, null::text, null::timestamptz, null::jsonb, null::text, null::text,
  g.line_items,
  null::text, null::text, null::text, null::text, null::text, null::text,
  null::timestamptz
from offers o
join routing_groups g  on g.id = o.routing_group_id
join routing_orders ro on ro.id = g.routing_order_id
where o.store_id in (select current_store_ids())
  and o.status in ('declined', 'declined_stock')
  and coalesce(g.assigned_store_id, '00000000-0000-0000-0000-000000000000'::uuid) <> o.store_id;
