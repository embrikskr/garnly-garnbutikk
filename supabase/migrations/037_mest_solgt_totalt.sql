-- Mest solgt i hele Garnly, til alle butikkene (17.11.2026).
--
-- Embrik: butikkene skal se hva som går på tvers av Garnly, ikke bare hos seg selv, så de vet
-- hva de bør ha inne. Én rad per vare: nøster og ordrer summert over alle butikker – aldri
-- hvilken butikk som solgte hva – pluss butikkens eget lager nå.
--
-- Alle innloggede butikkbrukere og Garnly kan lese den. Lageret vises bare for en butikk brukeren
-- selv hører til (eller alle, for Garnly); ellers står det tomt.
create or replace function sales_report_total(p_days int, p_store uuid)
returns table (product_id uuid, vare text, antall bigint, ordrer bigint, lager_na int)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.name,
         sum((li->>'qty')::int)::bigint,
         count(distinct g.routing_order_id),
         max(i.qty)
  from routing_groups g
  join routing_orders ro on ro.id = g.routing_order_id
  cross join lateral jsonb_array_elements(g.line_items) li
  join products p on p.id::text = li->>'product_id'
  left join inventory i on i.store_id = p_store and i.product_id = p.id
    and (is_garnly_admin() or p_store in (select current_store_ids()))
  where (is_garnly_admin() or exists (select 1 from current_store_ids()))
    and g.status in ('assigned', 'fulfilled')
    and not ro.is_test
    and g.assigned_at >= now() - make_interval(days => greatest(least(p_days, 366), 1))
  group by p.id, p.name
  order by 3 desc, 4 desc, 2
  limit 50;
$$;

revoke execute on function sales_report_total(int, uuid) from public, anon;
grant execute on function sales_report_total(int, uuid) to authenticated;
