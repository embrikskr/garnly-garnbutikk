-- Butikkpanel: innlogging per butikk, sanntidskø og godta/avslå fra nettbrett.
-- Erstatter e-post per tilbud, som ikke skalerer når en butikk får titalls ordrer om dagen.

-- ---------------------------------------------------------------------------
-- Varsling av per tilbud er nå AV som standard. Butikkene bruker panelet.
-- Feltet står igjen for butikker uten nettbrett, og for varsling til Garnly ops.
-- ---------------------------------------------------------------------------
alter table stores add column if not exists notify_offers boolean not null default false;
comment on column stores.notify_offers is
  'Send e-post/SMS per tilbud. Av som standard, butikkene svarer i butikkpanelet.';

-- ---------------------------------------------------------------------------
-- Hvem får logge inn på vegne av hvilken butikk
-- ---------------------------------------------------------------------------
create table store_users (
  user_id    uuid not null references auth.users(id) on delete cascade,
  store_id   uuid not null references stores(id) on delete cascade,
  role       text not null default 'staff',   -- 'staff' | 'owner'
  created_at timestamptz not null default now(),
  primary key (user_id, store_id)
);
create index store_users_store_idx on store_users (store_id);
alter table store_users enable row level security;

-- Butikkene i denne sesjonen. security definer fordi den leser store_users,
-- som selv er RLS-beskyttet.
create or replace function current_store_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select store_id from store_users where user_id = auth.uid();
$$;
revoke all on function current_store_ids() from public;
grant execute on function current_store_ids() to authenticated;

create policy store_users_self on store_users
  for select to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Tilbud: butikken ser sine egne. Denne policyen er også det som gjør at
-- Realtime får sende endringer til panelet.
-- ---------------------------------------------------------------------------
create policy offers_own on offers
  for select to authenticated
  using (store_id in (select current_store_ids()));

create policy stores_own on stores
  for select to authenticated
  using (id in (select current_store_ids()));

alter publication supabase_realtime add table offers;

-- ---------------------------------------------------------------------------
-- Views for panelet.
-- Bevisst uten security_invoker: de kjører som eier og filtrerer selv på
-- current_store_ids(). Da slipper butikken å få leserett på routing_orders,
-- som inneholder hele Shopify-payloaden med kundedata vi ikke skal dele.
-- ---------------------------------------------------------------------------
create view v_panel_queue as
select
  o.id                     as offer_id,
  o.store_id,
  o.status                 as offer_status,
  o.offered_at,
  o.deadline_at,
  o.sequence_no,
  g.id                     as group_id,
  g.group_no,
  g.line_items,
  ro.shopify_order_name    as order_name,
  ro.created_at            as order_created_at,
  ro.customer ->> 'zip'    as ship_zip,
  ro.customer ->> 'city'   as ship_city
from offers o
join routing_groups g  on g.id = o.routing_group_id
join routing_orders ro on ro.id = g.routing_order_id
where o.status = 'offered'
  and g.status = 'routing'
  and o.store_id in (select current_store_ids());

create view v_panel_assigned as
select
  g.id                        as group_id,
  g.assigned_store_id         as store_id,
  g.line_items,
  g.assigned_at,
  g.tracking_number,
  g.tracking_url,
  ro.shopify_order_name       as order_name,
  ro.customer ->> 'name'      as ship_name,
  ro.customer ->> 'address1'  as ship_address1,
  ro.customer ->> 'address2'  as ship_address2,
  ro.customer ->> 'zip'       as ship_zip,
  ro.customer ->> 'city'      as ship_city,
  ro.customer ->> 'country'   as ship_country
from routing_groups g
join routing_orders ro on ro.id = g.routing_order_id
where g.status = 'assigned'
  and g.assigned_store_id in (select current_store_ids());

-- Enkel dagsstatistikk til toppen av panelet.
create view v_panel_stats as
select
  s.id as store_id,
  (select count(*) from offers o join routing_groups g on g.id = o.routing_group_id
     where o.store_id = s.id and o.status = 'offered' and g.status = 'routing')            as queue,
  (select count(*) from routing_groups g
     where g.assigned_store_id = s.id and g.status = 'assigned')                            as to_pack,
  (select count(*) from routing_groups g
     where g.assigned_store_id = s.id and g.assigned_at >= date_trunc('day', now()))        as assigned_today
from stores s
where s.id in (select current_store_ids());

grant select on v_panel_queue, v_panel_assigned, v_panel_stats to authenticated;

-- ---------------------------------------------------------------------------
-- Slik kobler du en bruker til en butikk:
--   1. Opprett brukeren i Supabase → Authentication → Users (e-post + passord).
--   2. insert into store_users (user_id, store_id)
--      values ('<auth user id>', (select id from stores where slug = 'strikkefryd'));
-- ---------------------------------------------------------------------------
