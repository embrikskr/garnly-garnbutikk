-- mark_pos_deducted så ikke gruppen etter at den fikk status 'fulfilled'.
--
-- Funksjonen ble skrevet i 013, før statusen fantes. Da 015/016 innførte 'fulfilled', ble
-- views og TypeScript oppdatert, men ikke denne. Butikken fikk «Fant ingen tildelt ordre»
-- når de trykket «Slått ut i kassa» etter at sendingen var opprettet – og det er den
-- vanligste rekkefølgen: pakk, lag sending, slå ut i kassa.
--
-- Funnet i ekte test 30.09 med #1004. Regelen for de fire tilstandene ligger nå også som
-- ren logikk i _shared/inventory.ts (pendingForGroup), med test.

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
  -- Både 'assigned' og 'fulfilled': butikken slår ofte ut i kassa etter at sendingen er
  -- laget, og da har gruppen alt gått over til 'fulfilled'.
  select assigned_store_id, pos_deducted_at into v_store, v_at
  from routing_groups
  where id = p_group_id and status in ('assigned', 'fulfilled');

  if v_store is null then
    raise exception 'Fant ingen tildelt ordre med id %', p_group_id using errcode = 'no_data_found';
  end if;
  if v_store not in (select current_store_ids()) then
    raise exception 'Ingen tilgang til denne ordren' using errcode = 'insufficient_privilege';
  end if;
  if v_at is not null then
    return v_at;
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
