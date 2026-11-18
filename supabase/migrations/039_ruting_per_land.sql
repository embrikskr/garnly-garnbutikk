-- Ruting per land (18.11.2026): Garnly sender aldri over tollgrensen (byggeplan §15b).
--
-- En ordre tilbys bare butikker i samme land som leveringsadressen. Norske kunder får varene fra
-- norske butikker, danske fra danske. Første utenlandske butikk er KreStoffer (Odense).
--
-- Ingen DROP i denne migrasjonen (Supabase-koblingen stopper dem). De gamle funksjonene med ett
-- argument blir stående, men ruter nå bare i Norge – så en Edge Function som ikke er deployet på
-- nytt ennå, kan aldri sende en norsk ordre til Danmark.

-- ---------------------------------------------------------------------------
-- Butikkens land (ISO 3166-1 alpha-2). Alle eksisterende butikker er norske.
-- ---------------------------------------------------------------------------
alter table stores add column if not exists country text not null default 'NO';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'stores_country_iso2') then
    alter table stores add constraint stores_country_iso2 check (country ~ '^[A-Z]{2}$');
  end if;
end $$;

-- Landet stod alt i pos_config for partnerbutikkene (035).
update stores set country = upper(pos_config->>'country')
where pos_config ? 'country' and upper(pos_config->>'country') ~ '^[A-Z]{2}$' and country <> upper(pos_config->>'country');

-- ---------------------------------------------------------------------------
-- Ordrens leveringsland, fra adressen order-intake lagrer i routing_orders.customer.
-- Null når ordren ikke har leveringsadresse; da rutes den i Norge (routingCountry i routing.ts).
-- ---------------------------------------------------------------------------
alter table routing_orders add column if not exists ship_country text
  generated always as (upper(nullif(customer->>'countryCodeV2', ''))) stored;

-- ---------------------------------------------------------------------------
-- Dekning og kvalifiserte butikker, per land
-- ---------------------------------------------------------------------------
create or replace function store_coverage(p_line_items jsonb, p_country text)
returns table (store_id uuid, product_id uuid)
language sql
stable
set search_path = public
as $$
  with lines as (
    select (li->>'product_id')::uuid as product_id, (li->>'qty')::int as qty
    from jsonb_array_elements(p_line_items) li
  )
  select i.store_id, i.product_id
  from inventory i
  join lines l on l.product_id = i.product_id and i.qty >= l.qty
  join stores s on s.id = i.store_id and s.active = true
    and s.country = coalesce(upper(p_country), 'NO');
$$;

create or replace function qualified_stores(p_line_items jsonb, p_country text)
returns table (store_id uuid)
language sql
stable
set search_path = public
as $$
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
    and s.country = coalesce(upper(p_country), 'NO')
  order by
    coalesce(s.last_assigned_at, timestamp 'epoch')
      + least(s.timeout_streak, 3) * interval '24 hours' asc,
    s.created_at asc;
$$;

-- De gamle med ett argument: bare Norge, til alle Edge Functions er deployet på nytt.
create or replace function store_coverage(p_line_items jsonb)
returns table (store_id uuid, product_id uuid)
language sql
stable
set search_path = public
as $$ select * from store_coverage(p_line_items, 'NO'); $$;

create or replace function qualified_stores(p_line_items jsonb)
returns table (store_id uuid)
language sql
stable
set search_path = public
as $$ select * from qualified_stores(p_line_items, 'NO'); $$;

revoke execute on function store_coverage(jsonb, text)   from public, anon, authenticated;
revoke execute on function qualified_stores(jsonb, text) from public, anon, authenticated;
revoke execute on function store_coverage(jsonb)         from public, anon, authenticated;
revoke execute on function qualified_stores(jsonb)       from public, anon, authenticated;
grant execute on function store_coverage(jsonb, text)   to service_role;
grant execute on function qualified_stores(jsonb, text) to service_role;

-- ---------------------------------------------------------------------------
-- «Manglet» (036) teller bare butikker i ordrens land. En dansk butikk har ikke «gått glipp av»
-- en norsk ordre den aldri kunne fått.
-- ---------------------------------------------------------------------------
create or replace function log_missed_lines()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_test boolean;
  v_land text;
begin
  select is_test, coalesce(ship_country, 'NO') into v_test, v_land from routing_orders where id = new.routing_order_id;
  if coalesce(v_test, false) then
    return new;
  end if;
  insert into missed_lines (routing_order_id, store_id, product_id, qty_wanted, qty_had)
  select new.routing_order_id, s.id, p.id, (li->>'qty')::int, coalesce(i.qty, 0)
  from jsonb_array_elements(coalesce(new.line_items, '[]'::jsonb)) li
  join products p on p.id::text = li->>'product_id'
  cross join stores s
  left join inventory i on i.store_id = s.id and i.product_id = p.id
  where s.active
    and s.country = coalesce(v_land, 'NO')
    and coalesce((li->>'qty')::int, 0) > 0
    and coalesce(i.qty, 0) < (li->>'qty')::int
  on conflict (routing_order_id, store_id, product_id) do nothing;
  return new;
end;
$$;
revoke execute on function log_missed_lines() from public, anon, authenticated;
