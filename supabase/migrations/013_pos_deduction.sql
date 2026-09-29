-- Dobbelttelling av lager: Garnly-salg trekkes ikke automatisk i butikkens kasse.
--
-- Butikken slår ordren ut manuelt, av og til dager etter at den er sendt. I mellomtiden
-- rapporterer kassa for høyt tall. Shopifys `committed` dekker bare tiden FØR fulfillment;
-- i det fulfillment opprettes trekker Shopify selv ned `on_hand`, og neste synk skriver
-- kassetallet rett over igjen. Varen blir tilgjengelig for salg to ganger.
--
-- Løsningen er å holde rede på hvilke linjer kassa ennå ikke har trukket fra, og trekke dem
-- fra selv til butikken bekrefter at de er slått ut.

alter table routing_groups add column if not exists fulfilled_at    timestamptz;
alter table routing_groups add column if not exists pos_deducted_at timestamptz;
alter table routing_groups add column if not exists pos_deducted_by text;
alter table routing_groups add column if not exists pos_reminder_sent_at timestamptz;

comment on column routing_groups.fulfilled_at is
  'Når fulfillment ble opprettet i Shopify. Fra da av har Shopify selv trukket ned on_hand, '
  'mens kassa fortsatt teller varene – differansen er det vi må kompensere for.';
comment on column routing_groups.pos_deducted_at is
  'Når butikken bekreftet at varene er slått ut i egen kasse. Null = kassetallet er for høyt.';

-- Bare rader som faktisk venter på uttrekk. Delvis indeks, så den holder seg liten.
create index if not exists routing_groups_pending_deduction_idx
  on routing_groups (assigned_store_id)
  where status = 'assigned' and fulfilled_at is not null and pos_deducted_at is null;

-- ---------------------------------------------------------------------------
-- Hva sync-store må trekke fra, per butikk og produkt.
--
-- Bare grupper som ER fulfillet teller. En gruppe som er tildelt, men ikke sendt, står
-- fortsatt som `committed` i Shopify, og Shopify trekker den fra `available` selv. Trakk vi
-- den fra her også, ville vi trukket dobbelt og vist for lite på lager.
-- ---------------------------------------------------------------------------
create or replace view v_pos_pending_deduction as
select
  g.assigned_store_id            as store_id,
  (li ->> 'product_id')::uuid    as product_id,
  sum((li ->> 'qty')::int)       as qty
from routing_groups g
cross join lateral jsonb_array_elements(g.line_items) as li
where g.assigned_store_id is not null
  and g.status = 'assigned'
  and g.fulfilled_at is not null
  and g.pos_deducted_at is null
  and li ? 'product_id'
  and li ->> 'product_id' is not null
group by 1, 2;

alter view v_pos_pending_deduction set (security_invoker = on);

-- Bare backenden leser denne. Ingen grant til anon/authenticated.
revoke all on v_pos_pending_deduction from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Butikkens knapp «Slått ut i kassa».
--
-- security definer fordi den skriver til routing_groups, som panelbrukeren ikke har
-- skriverett på. Tilgangen avgrenses av current_store_ids(): butikken kan bare merke
-- sine egne grupper. Idempotent – et dobbelttrykk flytter ikke tidspunktet.
-- ---------------------------------------------------------------------------
create or replace function mark_pos_deducted(p_group_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid;
  v_at    timestamptz;
begin
  select assigned_store_id, pos_deducted_at into v_store, v_at
  from routing_groups
  where id = p_group_id and status = 'assigned';

  if v_store is null then
    raise exception 'Fant ingen tildelt ordre med id %', p_group_id using errcode = 'no_data_found';
  end if;
  if v_store not in (select current_store_ids()) then
    raise exception 'Ingen tilgang til denne ordren' using errcode = 'insufficient_privilege';
  end if;
  if v_at is not null then
    return v_at;  -- allerede merket, la tidspunktet stå
  end if;

  update routing_groups
  set pos_deducted_at = now(),
      pos_deducted_by = coalesce(auth.jwt() ->> 'email', auth.uid()::text)
  where id = p_group_id
  returning pos_deducted_at into v_at;

  insert into audit_log (entity, entity_id, event, payload)
  values ('routing_group', p_group_id, 'pos_deducted',
          jsonb_build_object('by', coalesce(auth.jwt() ->> 'email', auth.uid()::text)));

  return v_at;
end $$;

revoke all on function mark_pos_deducted(uuid) from public;
grant execute on function mark_pos_deducted(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Panelet trenger å se hva som venter på uttrekk, og hvor lenge.
-- ---------------------------------------------------------------------------
drop view if exists v_panel_assigned;
create view v_panel_assigned as
select
  g.id                        as group_id,
  g.assigned_store_id         as store_id,
  g.line_items,
  g.assigned_at,
  g.tracking_number,
  g.tracking_url,
  g.fulfilled_at,
  g.pos_deducted_at,
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

grant select on v_panel_assigned to authenticated;

-- ---------------------------------------------------------------------------
-- Eksisterende ordrer: alt som alt er sendt regnes som trukket fra i kassa.
--
-- Vi vet ikke om butikken faktisk har slått dem ut, men lageret i basen er allerede
-- avstemt mot kassa slik den står i dag. Merket vi dem som ventende, ville vi trukket fra
-- en gang til for varer kassa forlengst har trukket – og vist for lite på lager.
-- ---------------------------------------------------------------------------
update routing_groups
set fulfilled_at    = coalesce(fulfilled_at, assigned_at),
    pos_deducted_at = coalesce(pos_deducted_at, assigned_at)
where status = 'assigned' and assigned_at is not null;
