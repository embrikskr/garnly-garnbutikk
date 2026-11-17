-- 038: Garnly-admin flytter til admin.garnly.no (17.11.2026)
--
-- Embrik 17.11: «butikkene må ha tilgang til shopadmin … men vi admin trenger bare én
-- innlogging, og et sted der all oversikt ligger». Butikkpanelet (shopadmin.garnly.no) er
-- fortsatt butikkenes. Fanen «Garnly» der flyttes til admin.garnly.no, som har sin egen
-- innlogging i appens Supabase-prosjekt.
--
-- admin.garnly.no når denne basen fra serveren med service role, ETTER at den selv har
-- sjekket at brukeren er admin. To ting må da virke her:
--
-- 1. Admin-viewene og -funksjonene (v_admin_*, settlement_*, sales_report_*) filtrerer på
--    is_garnly_admin(), som bare så på garnly_admins/auth.uid(). For service role var den
--    usann, så serveren fikk null rader. Nå er den sann for service role. Det gir ikke
--    service role noe nytt: den leser tabellene direkte og går forbi RLS uansett.
--    Butikkbrukere (authenticated) får det samme som før.
--
-- 2. «Marker som utbetalt» og «Angre» skriver hvem som trykket (marked_by, annullert_av,
--    audit_log). Fra admin.garnly.no er JWT-en service role, uten e-post. Navnet kommer i
--    stedet i headeren x-garnly-actor, som PostgREST legger i request.headers. Mangler den,
--    nektes skrivingen, så loggen aldri får et tomt «av».
--
-- Ellers er funksjonene uendret (sammenlignet med definisjonene i basen 17.11, fra 031).
-- CREATE OR REPLACE beholder tilgangene. Trygg å kjøre flere ganger.

-- Hvem som handler som Garnly-admin, eller null hvis ingen.
create or replace function garnly_admin_actor()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when coalesce(auth.jwt() ->> 'role', '') = 'service_role' then
      nullif(btrim(coalesce(
        nullif(current_setting('request.headers', true), '')::json ->> 'x-garnly-actor',
        '')), '')
    when exists (select 1 from garnly_admins where user_id = auth.uid()) then
      coalesce(auth.jwt() ->> 'email', auth.uid()::text)
  end;
$$;
revoke all on function garnly_admin_actor() from public, anon, authenticated;
grant execute on function garnly_admin_actor() to service_role;

create or replace function is_garnly_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(auth.jwt() ->> 'role', '') = 'service_role'
      or exists (select 1 from garnly_admins where user_id = auth.uid());
$$;

create or replace function mark_settlement_paid(p_store uuid, p_month date, p_paid_on date default null)
returns settlement_payouts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_idag  date := (now() at time zone 'Europe/Oslo')::date;
  v_by    text := garnly_admin_actor();
  v_row   settlement_payouts;
begin
  if v_by is null then
    raise exception 'Bare Garnly kan markere utbetalinger' using errcode = 'insufficient_privilege';
  end if;
  if v_month >= oslo_month(now()) then
    raise exception 'Måneden er ikke over ennå. Den kan markeres som utbetalt fra den 1. i neste måned.'
      using errcode = 'check_violation';
  end if;
  if coalesce(p_paid_on, v_idag) > v_idag then
    raise exception 'Utbetalingsdatoen kan ikke være fram i tid.' using errcode = 'check_violation';
  end if;

  -- En angret markering (annullert_at satt) tas i bruk igjen; en gjeldende røres ikke.
  insert into settlement_payouts as p (store_id, month, paid_on, amount_inc_vat, marked_by)
  values (p_store, v_month, coalesce(p_paid_on, v_idag),
          (select coalesce(sum(til_butikk), 0) from settlement_ledger where store_id = p_store and maaned = v_month),
          v_by)
  on conflict (store_id, month) do update
     set paid_on = excluded.paid_on, amount_inc_vat = excluded.amount_inc_vat, marked_by = excluded.marked_by,
         created_at = now(), annullert_at = null, annullert_av = null
   where p.annullert_at is not null
  returning * into v_row;

  if v_row is null then
    raise exception 'Måneden er allerede markert som utbetalt.' using errcode = 'unique_violation';
  end if;

  insert into audit_log (entity, entity_id, event, payload)
  values ('store', p_store, 'settlement_paid',
          jsonb_build_object('maaned', v_month, 'utbetalt', v_row.paid_on, 'belop', v_row.amount_inc_vat, 'av', v_by));
  return v_row;
end $$;

create or replace function unmark_settlement_paid(p_store uuid, p_month date)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_by    text := garnly_admin_actor();
  v_row   settlement_payouts;
begin
  if v_by is null then
    raise exception 'Bare Garnly kan endre utbetalinger' using errcode = 'insufficient_privilege';
  end if;
  update settlement_payouts set annullert_at = now(), annullert_av = v_by
   where store_id = p_store and month = v_month and annullert_at is null
  returning * into v_row;
  if v_row is null then
    raise exception 'Måneden var ikke markert som utbetalt.' using errcode = 'no_data_found';
  end if;
  insert into audit_log (entity, entity_id, event, payload)
  values ('store', p_store, 'settlement_unpaid',
          jsonb_build_object('maaned', v_month, 'var_utbetalt', v_row.paid_on, 'belop', v_row.amount_inc_vat, 'av', v_by));
end $$;
