-- Automatisk overføring av Cargonizer-sendinger til transportør.
--
-- Funn 30.09.2026: CargonizerConnect lager sendingen og fulfiller ordren i Shopify, men
-- overfører den ikke til transportøren. #1004 (Strikkefryd, avsender 25849) lå som «Usendt»
-- med state=open og transfer-at tom. Uten overføring får PostNord aldri EDI-en, og sporings-
-- nummeret på ordren er dødt: kunden ser ingenting, og pakken kan bli avvist i innlevering.
-- Appen har bare innstilling for automatisk overføring på «Home Small main shipment», som
-- vi ikke bruker. Derfor gjør Garnly det selv.
--
-- Overføringen skjer i det vi får vite at ordren er sendt (fulfillments/create), med
-- backstop i timeout-sweeper. Se _shared/transfer_sync.ts.
--   POST /consignments/transfer.xml?consignment_ids[]=<id>   (verifisert 30.09.2026)
-- .xml-endelsen er med hensikt: uten den svarer Cargonizer 302 til en HTML-404 ved feil,
-- og et `fetch` som følger redirecten ville lest det som suksess. Med .xml kommer 400 og
-- <errors><error>…</error></errors>.

alter table routing_groups
  add column if not exists transferred_at      timestamptz,
  add column if not exists transfer_attempts   integer not null default 0,
  add column if not exists transfer_checked_at timestamptz,
  add column if not exists transfer_error      text,
  add column if not exists transfer_alerted_at timestamptz,
  add column if not exists carrier             text;

comment on column routing_groups.transferred_at is
  'Sendingen er overført til transportøren i Cargonizer (EDI sendt). Null = ikke overført ennå.';
comment on column routing_groups.transfer_attempts is
  'Antall overføringsforsøk. Brukes til å låse mot samtidige forsøk og til å varsle drift.';
comment on column routing_groups.transfer_checked_at is
  'Siste forsøk. Backstoppen i timeout-sweeper prøver ikke samme gruppe oftere enn hvert kvarter.';
comment on column routing_groups.transfer_error is 'Siste feilmelding fra overføringen. Nulles når den lykkes.';
comment on column routing_groups.transfer_alerted_at is 'Drift er varslet om at overføringen ikke går gjennom. Settes én gang.';
comment on column routing_groups.carrier is
  'Transportør fra Shopifys trackingInfo.company (satt av CargonizerConnect). Brukes i panelteksten, så vi ikke skriver «PostNord» på en Bring-pakke.';

-- Backstoppen leter etter sendte grupper som ikke er overført. Delvis indeks: de er få,
-- og sveipet går hvert minutt.
create index if not exists routing_groups_transfer_pending_idx
  on routing_groups (transfer_checked_at)
  where transferred_at is null and fulfilled_at is not null;

-- ---------------------------------------------------------------------------
-- Panelet: butikken skal se at pakken faktisk er meldt inn til transportøren.
-- Ellers er «Sendt» alt de vet, og en sending som ble stående usendt ser lik ut
-- som en som gikk gjennom.
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

-- ---------------------------------------------------------------------------
-- Tidligere ordrer: samme opplysning, for ordrer som er ute av pakkelista.
-- Avslåtte tilbud har fortsatt ingen kundedata – og ingen sending.
-- ---------------------------------------------------------------------------
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
