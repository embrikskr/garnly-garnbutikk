-- Garnly garnbutikk – grunnskjema
-- Kilde: Garnly_Garnbutikk_Byggeplan_v1.md §11 + Garnly_Ordrefordeling_Logikk.md §2

create extension if not exists "pgcrypto";
create extension if not exists "pg_cron";
create extension if not exists "pg_net";

-- ---------------------------------------------------------------------------
-- Partnerbutikker
-- ---------------------------------------------------------------------------
create type pos_system as enum ('duell', 'mystore', 'csv', 'manual');
create type notify_channel as enum ('email', 'sms', 'both');

create table stores (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  slug                text not null unique,
  pos_system          pos_system not null,
  -- Systemspesifikk konfig, f.eks. {"department": "..."} for Duell eller {"shop": "navn"} for Mystore.
  -- Hemmeligheter (tokens) ligger IKKE her, men i Vault-tabellen store_secrets.
  pos_config          jsonb not null default '{}'::jsonb,
  shopify_location_id text unique,              -- gid://shopify/Location/123
  shipping_sender_id  text,                     -- Shipmondo sender / Cargonizer avsender
  contact_email       text,
  contact_phone       text,
  notify_channel      notify_channel not null default 'email',
  -- Åpningstider: {"mon":["10:00","18:00"], ..., "sun":null}
  business_hours      jsonb not null default '{"mon":["10:00","17:00"],"tue":["10:00","17:00"],"wed":["10:00","17:00"],"thu":["10:00","17:00"],"fri":["10:00","17:00"],"sat":["10:00","15:00"],"sun":null}'::jsonb,
  offer_ttl_hours     numeric not null default 3,
  safety_stock        int not null default 0,
  auto_accept         boolean not null default false,
  -- Fordeling (Ordrefordeling_Logikk §2)
  last_assigned_at    timestamptz,
  assigned_count      int not null default 0,
  timeout_streak      int not null default 0,
  weight              int not null default 1,
  active              boolean not null default true,
  -- Synk-status
  last_sync_at        timestamptz,
  last_sync_status    text,
  last_sync_rows      int,
  consecutive_sync_failures int not null default 0,
  created_at          timestamptz not null default now()
);

-- Hemmeligheter per butikk (API-nøkler). Kun service_role leser denne.
create table store_secrets (
  store_id   uuid primary key references stores(id) on delete cascade,
  secrets    jsonb not null,          -- {"client_number":"..","client_token":".."} / {"token":".."}
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Produkter (Garnlys sortiment, speil av Shopify-varianter)
-- ---------------------------------------------------------------------------
create table products (
  id                          uuid primary key default gen_random_uuid(),
  ean                         text unique,
  sku                         text,
  name                        text not null,
  brand                       text,
  yarn_name                   text,
  color_code                  text,
  color_name                  text,
  shopify_product_id          text,
  shopify_variant_id          text unique,
  shopify_inventory_item_id   text unique,
  active                      boolean not null default true,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);
create index products_brand_yarn_idx on products (lower(brand), lower(yarn_name), lower(color_name));

-- Lager per butikk per produkt (sannhet = kassesystemet, dette er siste kjente)
create table inventory (
  store_id    uuid not null references stores(id) on delete cascade,
  product_id  uuid not null references products(id) on delete cascade,
  qty_raw     int not null,          -- som rapportert av kassesystemet
  qty         int not null,          -- qty_raw - safety_stock, aldri under 0 (det som sendes til Shopify)
  synced_at   timestamptz not null default now(),
  primary key (store_id, product_id)
);
create index inventory_product_idx on inventory (product_id) where qty > 0;

-- Rader fra kassesystemet som ikke kunne kobles til et Garnly-produkt
create table unmatched_items (
  id                  uuid primary key default gen_random_uuid(),
  store_id            uuid not null references stores(id) on delete cascade,
  ean                 text,
  sku                 text,
  name                text,
  qty                 int,
  first_seen          timestamptz not null default now(),
  last_seen           timestamptz not null default now(),
  resolved_product_id uuid references products(id),
  ignored             boolean not null default false,
  unique (store_id, ean, sku)
);

create table sync_runs (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references stores(id) on delete cascade,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  status      text not null default 'running',  -- running | ok | error
  rows_read   int,
  rows_matched int,
  rows_changed int,
  error       text
);
create index sync_runs_store_idx on sync_runs (store_id, started_at desc);

-- ---------------------------------------------------------------------------
-- Ordreruting
-- ---------------------------------------------------------------------------
create type routing_status as enum ('routing', 'assigned', 'partially_assigned', 'escalated', 'cancelled');
create type group_status   as enum ('routing', 'assigned', 'escalated', 'cancelled');
create type offer_status   as enum ('pending', 'offered', 'accepted', 'declined', 'declined_stock', 'expired', 'cancelled');

create table routing_orders (
  id                          uuid primary key default gen_random_uuid(),
  shopify_order_id            text not null unique,
  shopify_order_name          text,              -- #1001
  shopify_fulfillment_order_id text,
  status                      routing_status not null default 'routing',
  customer                    jsonb,             -- navn, adresse, e-post (for varsel til butikk)
  customer_geo                jsonb,
  raw_order                   jsonb,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

-- Én ordre kan deles i flere grupper (splitt per varelinje, §8.2). Vanligvis én.
create table routing_groups (
  id                           uuid primary key default gen_random_uuid(),
  routing_order_id             uuid not null references routing_orders(id) on delete cascade,
  group_no                     int not null default 1,
  -- [{ "line_item_id": "gid://..", "product_id": uuid, "variant_id": "gid://..", "qty": 3, "title": ".." }]
  line_items                   jsonb not null,
  shopify_fulfillment_order_id text,
  status                       group_status not null default 'routing',
  assigned_store_id            uuid references stores(id),
  assigned_at                  timestamptz,
  tracking_number              text,
  tracking_url                 text,
  shipment_id                  text,
  created_at                   timestamptz not null default now(),
  unique (routing_order_id, group_no)
);

create table offers (
  id                uuid primary key default gen_random_uuid(),
  routing_group_id  uuid not null references routing_groups(id) on delete cascade,
  store_id          uuid not null references stores(id),
  sequence_no       int not null,
  status            offer_status not null default 'pending',
  token_hash        text unique,        -- sha256 av engangstoken i lenken
  offered_at        timestamptz,
  deadline_at       timestamptz,
  responded_at      timestamptz,
  response_note     text,
  created_at        timestamptz not null default now(),
  unique (routing_group_id, store_id)
);
create index offers_open_idx on offers (deadline_at) where status = 'offered';

create table audit_log (
  id          bigserial primary key,
  entity      text not null,
  entity_id   uuid,
  event       text not null,
  payload     jsonb,
  created_at  timestamptz not null default now()
);
create index audit_log_entity_idx on audit_log (entity, entity_id, created_at desc);

-- Idempotens for Shopify-webhooks
create table shopify_webhook_events (
  id          text primary key,      -- X-Shopify-Webhook-Id
  topic       text not null,
  received_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Funksjoner
-- ---------------------------------------------------------------------------

-- Kandidatkø for en gruppe: butikker som har HELE antallet av HVER linje.
-- Sortert etter fordelingsregelen (Ordrefordeling_Logikk §2).
create or replace function qualified_stores(p_line_items jsonb)
returns table (store_id uuid) language sql stable as $$
  with lines as (
    select (li->>'product_id')::uuid as product_id, (li->>'qty')::int as qty
    from jsonb_array_elements(p_line_items) li
  ),
  n as (select count(*) as cnt from lines),
  ok as (
    select i.store_id
    from inventory i
    join lines l on l.product_id = i.product_id and i.qty >= l.qty
    group by i.store_id
    having count(*) = (select cnt from n)
  )
  select s.id
  from stores s
  join ok on ok.store_id = s.id
  where s.active = true
  order by
    coalesce(s.last_assigned_at, timestamp 'epoch')
      + least(s.timeout_streak, 3) * interval '24 hours' asc,
    s.created_at asc;
$$;

-- Hvilke butikker dekker hvilke linjer (brukes til splitt-logikken i koden)
create or replace function store_coverage(p_line_items jsonb)
returns table (store_id uuid, product_id uuid) language sql stable as $$
  with lines as (
    select (li->>'product_id')::uuid as product_id, (li->>'qty')::int as qty
    from jsonb_array_elements(p_line_items) li
  )
  select i.store_id, i.product_id
  from inventory i
  join lines l on l.product_id = i.product_id and i.qty >= l.qty
  join stores s on s.id = i.store_id and s.active = true;
$$;

-- Ved aksept
create or replace function mark_store_assigned(p_store_id uuid)
returns void language sql as $$
  update stores
  set last_assigned_at = now(),
      assigned_count   = assigned_count + 1,
      timeout_streak   = 0
  where id = p_store_id;
$$;

-- Ved timeout
create or replace function mark_store_timeout(p_store_id uuid)
returns void language sql as $$
  update stores set timeout_streak = timeout_streak + 1 where id = p_store_id;
$$;

-- Oppdatert-trigger
create or replace function set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create trigger products_updated_at before update on products for each row execute function set_updated_at();
create trigger routing_orders_updated_at before update on routing_orders for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Rapport-views
-- ---------------------------------------------------------------------------
create view v_store_overview as
select s.id, s.name, s.pos_system, s.active,
       s.last_sync_at, s.last_sync_status, s.consecutive_sync_failures,
       s.assigned_count, s.timeout_streak, s.last_assigned_at,
       (select count(*) from inventory i where i.store_id = s.id and i.qty > 0) as products_in_stock,
       (select count(*) from unmatched_items u where u.store_id = s.id and u.resolved_product_id is null and not u.ignored) as unmatched_count
from stores s;

create view v_offer_stats_30d as
select s.id as store_id, s.name,
       count(*) filter (where o.status = 'accepted') as accepted,
       count(*) filter (where o.status in ('declined','declined_stock')) as declined,
       count(*) filter (where o.status = 'expired') as expired,
       count(*) filter (where o.status <> 'pending') as offered_total
from stores s
left join offers o on o.store_id = s.id and o.offered_at > now() - interval '30 days'
group by s.id, s.name;

-- ---------------------------------------------------------------------------
-- RLS: alt låst. Edge Functions bruker service_role. Dashboard får egne policies senere.
-- ---------------------------------------------------------------------------
alter table stores enable row level security;
alter table store_secrets enable row level security;
alter table products enable row level security;
alter table inventory enable row level security;
alter table unmatched_items enable row level security;
alter table sync_runs enable row level security;
alter table routing_orders enable row level security;
alter table routing_groups enable row level security;
alter table offers enable row level security;
alter table audit_log enable row level security;
alter table shopify_webhook_events enable row level security;
