-- Salgsrapport og «manglet» i panelet, og oppgjøret én måned om gangen med frakten (17.11.2026).
--
-- Embrik: butikkene får ulikt mye salg (Strikkefryd mer enn Garnkilden). Hver butikk skal se hva
-- som selger hos dem, og hva de gikk glipp av fordi de ikke hadde nok på lager. Garnly ser alle.
-- Oppgjørsfanen kommer tilbake (fjernet 08.10.2026), nå én side per måned med regnestykket per
-- ordre: varer + frakt, frakten til Garnly, provisjon av varene til Garnly, resten til butikken.
--
-- Tilgang som i 031: funksjonene kjører som eier og sjekker selv is_garnly_admin() /
-- current_store_ids(), så en butikk ikke kan be om en annens tall ved å sende en annen p_store.

-- ---------------------------------------------------------------------------
-- «Manglet»: hvilke varelinjer hver aktiv butikk ikke hadde nok av da ordren kom inn
--
-- Logges av en trigger når en gruppe opprettes, mot lageret akkurat da (inventory.qty, salgbart
-- antall etter buffer og ventende kassauttrekk). Deles gruppa opp senere, kommer de samme linjene
-- igjen i nye grupper; den unike nøkkelen gjør at de telles én gang per ordre, butikk og vare.
-- Ingen historikk før 17.11.2026: lageret ved tidligere ordrer er ikke lagret noe sted.
-- Testordrer og inaktive butikker telles ikke. NB: når utenlandske butikker blir aktive, må
-- dette begrenses til butikker i kundens land (byggeplan §15b).
-- ---------------------------------------------------------------------------
create table if not exists missed_lines (
  id               bigint generated always as identity primary key,
  routing_order_id uuid not null references routing_orders(id),
  store_id         uuid not null references stores(id),
  product_id       uuid not null references products(id),
  qty_wanted       int  not null,
  qty_had          int  not null,
  created_at       timestamptz not null default now(),
  unique (routing_order_id, store_id, product_id)
);
create index if not exists missed_lines_store_time_idx on missed_lines (store_id, created_at);
alter table missed_lines enable row level security;
revoke all on missed_lines from anon, authenticated;

create or replace function log_missed_lines()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from routing_orders where id = new.routing_order_id and is_test) then
    return new;
  end if;
  insert into missed_lines (routing_order_id, store_id, product_id, qty_wanted, qty_had)
  select new.routing_order_id, s.id, p.id, (li->>'qty')::int, coalesce(i.qty, 0)
  from jsonb_array_elements(coalesce(new.line_items, '[]'::jsonb)) li
  join products p on p.id::text = li->>'product_id'
  cross join stores s
  left join inventory i on i.store_id = s.id and i.product_id = p.id
  where s.active
    and coalesce((li->>'qty')::int, 0) > 0
    and coalesce(i.qty, 0) < (li->>'qty')::int
  on conflict (routing_order_id, store_id, product_id) do nothing;
  return new;
end;
$$;
revoke execute on function log_missed_lines() from public, anon, authenticated;

create or replace trigger routing_groups_missed_lines
after insert on routing_groups
for each row execute function log_missed_lines();

-- ---------------------------------------------------------------------------
-- Salgsrapport: mest solgt hos butikken siste p_days dager
-- Én rad per vare: nøster, ordrer, beløp og lageret nå. Ordrer telles fra de ble tildelt.
-- ---------------------------------------------------------------------------
create or replace function sales_report_top(p_days int, p_store uuid)
returns table (product_id uuid, vare text, antall bigint, ordrer bigint, belop numeric, lager_na int)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.name,
         sum((li->>'qty')::int)::bigint,
         count(distinct g.routing_order_id),
         coalesce(sum((li->>'amount_inc_vat')::numeric), 0),
         max(i.qty)
  from routing_groups g
  join routing_orders ro on ro.id = g.routing_order_id
  cross join lateral jsonb_array_elements(g.line_items) li
  join products p on p.id::text = li->>'product_id'
  left join inventory i on i.store_id = g.assigned_store_id and i.product_id = p.id
  where (is_garnly_admin() or g.assigned_store_id in (select current_store_ids()))
    and g.assigned_store_id = p_store
    and g.status in ('assigned', 'fulfilled')
    and not ro.is_test
    and g.assigned_at >= now() - make_interval(days => greatest(least(p_days, 366), 1))
  group by p.id, p.name
  order by 3 desc, 5 desc, 2;
$$;

-- ---------------------------------------------------------------------------
-- Salgsrapport: det butikken manglet siste p_days dager
-- Ganger = antall ordrer der butikken ikke hadde nok; nøster = sum av det kundene ville ha.
-- ---------------------------------------------------------------------------
create or replace function sales_report_missed(p_days int, p_store uuid)
returns table (product_id uuid, vare text, ganger bigint, antall bigint, lager_na int, sist timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.name,
         count(*),
         sum(m.qty_wanted)::bigint,
         max(i.qty),
         max(m.created_at)
  from missed_lines m
  join products p on p.id = m.product_id
  left join inventory i on i.store_id = m.store_id and i.product_id = m.product_id
  where (is_garnly_admin() or m.store_id in (select current_store_ids()))
    and m.store_id = p_store
    and m.created_at >= now() - make_interval(days => greatest(least(p_days, 366), 1))
  group by p.id, p.name
  order by 3 desc, 4 desc, 2;
$$;

-- ---------------------------------------------------------------------------
-- Oppgjøret for én måned, linje for linje, med frakten
--
-- Samme linjer og tall som settlement_lines (regneboka i 031), pluss frakten kunden betalte.
-- Frakten er Garnlys og inngår aldri i det butikken får; den står her så regnestykket per
-- ordre er helt: varer + frakt = det kunden betalte for den delen. Er ordren delt på flere
-- butikker, står frakten på den første gruppa.
-- ---------------------------------------------------------------------------
create or replace function settlement_month_lines(p_month date, p_store uuid)
returns table (
  art text, dato date, order_name text, varebelop numeric, frakt numeric, provisjon_pct numeric,
  provisjon numeric, til_butikk numeric, beskrivelse text
)
language sql
stable
security definer
set search_path = public
as $$
  select l.art, l.dato, l.order_name, l.varebelop,
         case when l.art = 'salg' and g.group_no = (
                select min(g2.group_no) from routing_groups g2
                where g2.routing_order_id = g.routing_order_id and g2.status in ('assigned', 'fulfilled'))
              then coalesce(ro.shipping_inc_vat, 0) else 0 end,
         l.provisjon_pct, l.provisjon, l.til_butikk, l.beskrivelse
  from settlement_ledger l
  left join routing_groups g  on g.id = l.group_id
  left join routing_orders ro on ro.id = g.routing_order_id
  where (is_garnly_admin() or l.store_id in (select current_store_ids()))
    and l.store_id = p_store
    and l.maaned = date_trunc('month', p_month)::date
  order by l.tidspunkt, l.order_name;
$$;

revoke execute on function sales_report_top(int, uuid)        from public, anon;
revoke execute on function sales_report_missed(int, uuid)     from public, anon;
revoke execute on function settlement_month_lines(date, uuid) from public, anon;
grant execute on function sales_report_top(int, uuid)         to authenticated;
grant execute on function sales_report_missed(int, uuid)      to authenticated;
grant execute on function settlement_month_lines(date, uuid)  to authenticated;
