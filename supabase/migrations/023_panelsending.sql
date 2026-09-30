-- «Slått ut og klar til sending»: butikken sender ordren fra panelet.
--
-- Test 30.09.2026 viste to hull i flyten som var tenkt:
--   1. Butikkene har ikke tilgang til Shopify-admin, så de kan ikke trykke «Fulfill with
--      CargonizerConnect». Ordren ble liggende usendt til noen med admin-tilgang gjorde det.
--   2. CargonizerConnect overfører ikke sendingen til PostNord. Appen har bare automatisk
--      overføring på «Home Small main shipment», ikke på pakkeboks.
--
-- Én knapp i panelet gjør nå alt: kassauttrekk, sending i Cargonizer med pakkeboks og
-- SMS-varsling, overføring til PostNord, fulfillment i Shopify med sporing, og etiketten.
-- Se supabase/functions/_shared/ship.ts.

alter table routing_groups
  add column if not exists shipped_at      timestamptz,
  add column if not exists ship_step       text,
  add column if not exists ship_error      text,
  add column if not exists service_partner jsonb;

comment on column routing_groups.shipped_at is 'Da sendingen ble opprettet i Cargonizer fra panelet.';
comment on column routing_groups.ship_step is
  'Steget som feilet sist: uttrekk, sending, fulfillment eller etikett. Null når alt gikk gjennom.';
comment on column routing_groups.ship_error is 'Feilmeldingen butikken ser på kortet, med «Prøv igjen».';
comment on column routing_groups.service_partner is
  'Pakkeboksen sendingen går til (nummer, navn, adresse), som Cargonizer ga den. Vises i panelet.';

-- ---------------------------------------------------------------------------
-- Butikkens fraktoppsett.
--
-- Transportavtale og produkt ligger i databasen, ikke i koden: avtale-id-ene er ulike per
-- butikk, og en butikk som bytter transportør skal ikke kreve ny utrulling. Verdiene er
-- lest ut av transport_agreements.xml 30.09.2026, ikke gjettet:
--   25849 Strikkefryd → PostNord-avtale 37187
--   25848 Garnkilden  → PostNord-avtale 37185
-- postnord_mypack_small = «Parcel Locker» hos begge.
-- ---------------------------------------------------------------------------
alter table stores
  add column if not exists shipping_transport_agreement text,
  add column if not exists shipping_product             text,
  add column if not exists label_printer_id             text,
  add column if not exists label_printer_name           text;

comment on column stores.shipping_transport_agreement is 'Cargonizer transport_agreement-id for butikkens fraktavtale.';
comment on column stores.shipping_product is 'Produktidentifikator fra avtalen, f.eks. postnord_mypack_small (Parcel Locker).';
comment on column stores.label_printer_id is 'DirectPrint-skriver etiketten sendes til. Null = butikken skriver ut PDF selv.';
comment on column stores.label_printer_name is 'Navnet på skriveren, til visning i panelet.';

update stores set shipping_product = 'postnord_mypack_small' where shipping_product is null;
update stores set shipping_transport_agreement = '37187' where slug = 'strikkefryd' and shipping_transport_agreement is null;
update stores set shipping_transport_agreement = '37185' where slug = 'garnkilden'  and shipping_transport_agreement is null;

-- ---------------------------------------------------------------------------
-- Vekt på varene.
--
-- Pakkeboks krever vekt (requires_weight_or_volume), og maks er 10 kg. Shopify har vekten
-- på inventoryItem.measurement.weight; sync-products henter den. Mangler den, regner
-- _shared/shipping/consignment.ts med en fallback per vare.
-- ---------------------------------------------------------------------------
alter table products add column if not exists grams integer;
comment on column products.grams is
  'Vekt per enhet i gram, fra Shopify (inventoryItem.measurement.weight). Null = ikke satt i Shopify; da brukes fallback ved fraktberegning.';

-- ---------------------------------------------------------------------------
-- Panelet
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
  ro.customer ->> 'country'   as ship_country
from routing_groups g
join routing_orders ro on ro.id = g.routing_order_id
where g.assigned_store_id in (select current_store_ids())
  and (
    g.status = 'assigned'                                      -- skal pakkes
    -- Sendt, men fortsatt butikkens bord. To grunner:
    --   • kassauttrekket er ikke bekreftet (ordrer sendt på annen måte), eller
    --   • den ble sendt herfra nå nettopp – da gjør den nye knappen uttrekket FØRST, og
    --     kortet ville forsvunnet i samme sekund som butikken trykket, med etiketten og
    --     sporingen på. Det står ut dagen i stedet.
    or (g.status = 'fulfilled' and (g.pos_deducted_at is null or g.fulfilled_at > now() - interval '24 hours'))
  );

grant select on v_panel_assigned to authenticated;

drop view if exists v_panel_history;
create view v_panel_history as
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
  ro.customer ->> 'country'   as ship_country
from routing_groups g
join routing_orders ro on ro.id = g.routing_order_id
where g.assigned_store_id in (select current_store_ids())
  and g.status in ('assigned', 'fulfilled', 'cancelled')

union all

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
  null::text                  as ship_country
from offers o
join routing_groups g  on g.id = o.routing_group_id
join routing_orders ro on ro.id = g.routing_order_id
where o.store_id in (select current_store_ids())
  and o.status in ('declined', 'declined_stock')
  and coalesce(g.assigned_store_id, '00000000-0000-0000-0000-000000000000'::uuid) <> o.store_id;

grant select on v_panel_history to authenticated;

-- Panelet viser hvilken skriver som er valgt. Butikken leser alt sin egen rad i stores
-- (008); dette er bare to kolonner til på den.
