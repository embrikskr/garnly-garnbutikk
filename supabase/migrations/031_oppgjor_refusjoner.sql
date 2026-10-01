-- Oppgjør per butikk: refusjoner, utbetalinger, og én regnebok for admin og butikk.
--
-- Regelen er uendret: butikken får varebeløp minus commission_pct. Frakt tilhører Garnly og er
-- aldri med i butikkens oppgjør. Testordrer telles aldri.
--
-- Nytt:
--   • Refusjoner fra Shopify (refunds/create, se functions/order-refunded) blir trekk i
--     settlement_adjustments: minus refundert varebeløp × (100 − provisjon) / 100.
--   • Utbetalinger markeres per butikk per måned (settlement_payouts). Kommer en refusjon etter
--     at måneden er betalt ut, havner trekket i neste ubetalte måned av seg selv.
--   • settlement_ledger er den ene regneboka: hver ordre og hver justering på én linje, med
--     provisjonen regnet ut per linje. Sammendrag, månedsoversikt, CSV og butikkpanelet leser
--     alle derfra, så tallene kan ikke spre seg fra hverandre.
--   • Måneder følger norsk tid. Før gikk grensen ved midnatt UTC, så en ordre kl. 00:30 natt
--     til 1. oktober havnet i september.
--
-- v_admin_settlement og v_store_settlement fjernes: de regnet hver sin vei (den ene bare
-- 'assigned', den andre også 'fulfilled'), i UTC, og med provisjonen avrundet på månedssummen.

-- ---------------------------------------------------------------------------
-- Måned i norsk tid
-- ---------------------------------------------------------------------------
create or replace function oslo_month(ts timestamptz)
returns date
language sql
stable
set search_path = public
as $$ select date_trunc('month', ts at time zone 'Europe/Oslo')::date $$;

-- ---------------------------------------------------------------------------
-- Provisjonen fryses når butikken får ordren
--
-- Ellers ville en ny avtale med en butikk skrevet om alle tidligere måneder – også de som er
-- betalt ut. Settes av en trigger, så både offer-respond, auto-godkjenning og admin-actions
-- får det uten å endres.
-- ---------------------------------------------------------------------------
alter table routing_groups add column if not exists commission_pct numeric(5,2);
comment on column routing_groups.commission_pct is
  'Butikkens provisjon da den fikk ordren. Satt av trigger; oppgjøret bruker denne, ikke dagens stores.commission_pct.';

create or replace function routing_group_commission()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.assigned_store_id is null then
    new.commission_pct := null;
  elsif tg_op = 'INSERT' or new.assigned_store_id is distinct from old.assigned_store_id then
    select commission_pct into new.commission_pct from stores where id = new.assigned_store_id;
  end if;
  return new;
end $$;

drop trigger if exists routing_groups_commission on routing_groups;
create trigger routing_groups_commission
  before insert or update of assigned_store_id on routing_groups
  for each row execute function routing_group_commission();

update routing_groups g set commission_pct = s.commission_pct
  from stores s
 where s.id = g.assigned_store_id and g.commission_pct is null;

-- ---------------------------------------------------------------------------
-- Utbetalinger
-- ---------------------------------------------------------------------------
create table if not exists settlement_payouts (
  store_id       uuid not null references stores(id),
  month          date not null check (month = date_trunc('month', month)::date),
  paid_on        date not null,
  amount_inc_vat numeric(12,2) not null,
  marked_by      text,
  created_at     timestamptz not null default now(),
  annullert_at   timestamptz,
  annullert_av   text,
  primary key (store_id, month)
);
comment on table settlement_payouts is
  'Måned som er betalt ut til butikken. amount_inc_vat er «Til utbetaling» slik den var da den ble markert.';
comment on column settlement_payouts.annullert_at is
  'Markeringen er angret. Raden blir stående for historikken; måneden regnes som ubetalt.';
alter table settlement_payouts enable row level security;
revoke all on settlement_payouts from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Justeringer: refusjoner
-- ---------------------------------------------------------------------------
alter table settlement_adjustments
  add column if not exists kind              text not null default 'manual',
  add column if not exists shopify_refund_id text,
  add column if not exists gross_inc_vat     numeric(12,2),
  add column if not exists commission_pct    numeric(5,2),
  add column if not exists settlement_month  date;

alter table settlement_adjustments
  add constraint settlement_adjustments_kind_check check (kind in ('refund', 'manual'));
-- Samme refusjon på samme gruppe én gang, uansett hvor mange ganger webhooken eller
-- backstoppen kommer innom. NULL er ulik NULL, så manuelle justeringer berøres ikke.
alter table settlement_adjustments
  add constraint settlement_adjustments_refund_uq unique (shopify_refund_id, group_id);

comment on column settlement_adjustments.kind is 'refund = fra Shopify-refusjon (order-refunded), manual = lagt inn for hånd.';
comment on column settlement_adjustments.gross_inc_vat is 'Refundert varebeløp inkl. mva, negativt. Uten frakt.';
comment on column settlement_adjustments.amount_inc_vat is 'Det butikken trekkes (negativt): varebeløpet minus Garnlys provisjon.';
comment on column settlement_adjustments.occurred_at is 'Da refusjonen skjedde i Shopify.';
comment on column settlement_adjustments.settlement_month is
  'Måneden trekket gjøres opp i. Refusjonsmåneden, eller neste ubetalte måned hvis den alt er betalt ut.';

-- Provisjon og avrunding regnes HER, med samme regnestykke som salget i settlement_ledger:
-- provisjonen avrundes til øre, butikken får resten. Da går en hel refusjon nøyaktig i null
-- mot salget. functions/_shared/settlement.ts fordeler bare varebeløpet.
create or replace function settlement_adjustment_fill()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  m date;
  brutto numeric;
begin
  if new.kind = 'refund' then
    if new.gross_inc_vat is null or new.gross_inc_vat >= 0 then
      raise exception 'En refusjon må ha negativt varebeløp i gross_inc_vat';
    end if;
    new.commission_pct := coalesce(
      new.commission_pct,
      (select commission_pct from routing_groups where id = new.group_id),
      (select commission_pct from stores where id = new.store_id));
    brutto := abs(new.gross_inc_vat);
    new.amount_inc_vat := -(brutto - round(brutto * new.commission_pct / 100, 2));
  end if;

  if new.settlement_month is null then
    m := oslo_month(new.occurred_at);
    while exists (select 1 from settlement_payouts p
                   where p.store_id = new.store_id and p.month = m and p.annullert_at is null) loop
      m := (m + interval '1 month')::date;
    end loop;
    new.settlement_month := m;
  end if;
  return new;
end $$;

drop trigger if exists settlement_adjustments_fill on settlement_adjustments;
create trigger settlement_adjustments_fill
  before insert on settlement_adjustments
  for each row execute function settlement_adjustment_fill();

update settlement_adjustments set settlement_month = oslo_month(occurred_at) where settlement_month is null;
alter table settlement_adjustments alter column settlement_month set not null;

-- ---------------------------------------------------------------------------
-- Regneboka
--
-- Én linje per ordre (gruppe) og per justering. Provisjonen regnes og avrundes per linje, så
-- summen av linjene i CSV-en er nøyaktig det som står i sammendraget.
--   dato          – da det skjedde (tildelt / refundert), norsk tid
--   oppgjorsdato  – dagen linja teller i: lik dato, eller den 1. i måneden et trekk ble flyttet til
--   maaned        – måneden linja gjøres opp i
-- Ikke lesbar for klientene; de går gjennom funksjonene under, som kjører som eier. Derfor
-- security_invoker: viewet gir ingen rettigheter i seg selv.
-- ---------------------------------------------------------------------------
-- NB: I den levende databasen står disse to fortsatt, stengt (revoke) og merket UTGÅTT. Supabase-
-- koblingen som la inn 031 stopper all DROP til noen bekrefter, og ingen var der. De er ubrukt.
drop view if exists v_admin_settlement;
drop view if exists v_store_settlement;

create or replace view settlement_ledger with (security_invoker = true) as
select
  'salg'::text                                          as art,
  g.assigned_store_id                                   as store_id,
  g.id                                                  as group_id,
  ro.shopify_order_id,
  ro.shopify_order_name                                 as order_name,
  (g.assigned_at at time zone 'Europe/Oslo')::date      as dato,
  (g.assigned_at at time zone 'Europe/Oslo')::date      as oppgjorsdato,
  oslo_month(g.assigned_at)                             as maaned,
  coalesce(g.gross_inc_vat, 0)                          as varebelop,
  coalesce(g.commission_pct, s.commission_pct)          as provisjon_pct,
  round(coalesce(g.gross_inc_vat, 0) * coalesce(g.commission_pct, s.commission_pct) / 100, 2) as provisjon,
  coalesce(g.gross_inc_vat, 0)
    - round(coalesce(g.gross_inc_vat, 0) * coalesce(g.commission_pct, s.commission_pct) / 100, 2) as til_butikk,
  null::text                                            as beskrivelse,
  g.assigned_at                                         as tidspunkt
from routing_groups g
join routing_orders ro on ro.id = g.routing_order_id
join stores s          on s.id = g.assigned_store_id
where g.status in ('assigned', 'fulfilled')
  and g.assigned_at is not null
  and not ro.is_test

union all

select
  case a.kind when 'refund' then 'refusjon' else 'justering' end,
  a.store_id,
  a.group_id,
  ro.shopify_order_id,
  ro.shopify_order_name,
  (a.occurred_at at time zone 'Europe/Oslo')::date,
  greatest((a.occurred_at at time zone 'Europe/Oslo')::date, a.settlement_month),
  a.settlement_month,
  coalesce(a.gross_inc_vat, a.amount_inc_vat),
  a.commission_pct,
  coalesce(a.gross_inc_vat, a.amount_inc_vat) - a.amount_inc_vat,
  a.amount_inc_vat,
  a.reason,
  a.occurred_at
from settlement_adjustments a
left join routing_groups g  on g.id = a.group_id
left join routing_orders ro on ro.id = g.routing_order_id
where not coalesce(ro.is_test, false);

revoke all on settlement_ledger from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Lesing: samme funksjoner for Garnly og butikk
--
-- Garnly ser alle butikker, en butikk bare seg selv. Sjekken ligger i funksjonen, ikke i
-- panelet, så en butikk kan ikke be om en annens tall ved å sende en annen p_store.
-- ---------------------------------------------------------------------------

-- Hver linje i perioden. fra og til er begge med.
create or replace function settlement_lines(p_from date, p_to date, p_store uuid default null)
returns table (
  store_id uuid, butikk text, art text, dato date, oppgjorsdato date, maaned date, group_id uuid,
  order_name text, varebelop numeric, provisjon_pct numeric, provisjon numeric, til_butikk numeric,
  beskrivelse text
)
language sql
stable
security definer
set search_path = public
as $$
  select l.store_id, s.name, l.art, l.dato, l.oppgjorsdato, l.maaned, l.group_id, l.order_name,
         l.varebelop, l.provisjon_pct, l.provisjon, l.til_butikk, l.beskrivelse
  from settlement_ledger l
  join stores s on s.id = l.store_id
  where (is_garnly_admin() or l.store_id in (select current_store_ids()))
    and (p_store is null or l.store_id = p_store)
    and l.oppgjorsdato between p_from and p_to
  order by s.name, l.tidspunkt, l.order_name;
$$;

-- Én rad per butikk for perioden. Butikker uten salg er med, med nuller.
-- varesalg − provisjon + justeringer = til_utbetaling.
create or replace function settlement_summary(p_from date, p_to date, p_store uuid default null)
returns table (
  store_id uuid, butikk text, provisjon_pct numeric, ordrer bigint, varesalg numeric,
  provisjon numeric, justeringer numeric, til_utbetaling numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.name, s.commission_pct,
         count(l.art) filter (where l.art = 'salg'),
         coalesce(sum(l.varebelop)  filter (where l.art = 'salg'), 0),
         coalesce(sum(l.provisjon)  filter (where l.art = 'salg'), 0),
         coalesce(sum(l.til_butikk) filter (where l.art <> 'salg'), 0),
         coalesce(sum(l.til_butikk), 0)
  from stores s
  left join settlement_ledger l on l.store_id = s.id and l.oppgjorsdato between p_from and p_to
  where (is_garnly_admin() or s.id in (select current_store_ids()))
    and (p_store is null or s.id = p_store)
  group by s.id, s.name, s.commission_pct
  order by s.name;
$$;

-- Måned for måned, med utbetalingsstatus. Bare måneder med noe i, pluss inneværende.
create or replace function settlement_months(p_store uuid default null, p_months int default 12)
returns table (
  store_id uuid, butikk text, maaned date, ordrer bigint, varesalg numeric, provisjon numeric,
  justeringer numeric, til_utbetaling numeric, utbetalt_dato date, utbetalt_belop numeric,
  utbetalt_av text, kan_markeres boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with mnd as (
    select (oslo_month(now()) - make_interval(months => n))::date as maaned
    from generate_series(0, greatest(least(p_months, 60), 1) - 1) n
  ), sum_ as (
    select l.store_id, l.maaned,
           count(*) filter (where l.art = 'salg')                    as ordrer,
           coalesce(sum(l.varebelop)  filter (where l.art = 'salg'), 0)  as varesalg,
           coalesce(sum(l.provisjon)  filter (where l.art = 'salg'), 0)  as provisjon,
           coalesce(sum(l.til_butikk) filter (where l.art <> 'salg'), 0) as justeringer,
           coalesce(sum(l.til_butikk), 0)                                as til_utbetaling
    from settlement_ledger l
    group by l.store_id, l.maaned
  )
  select s.id, s.name, m.maaned,
         coalesce(x.ordrer, 0), coalesce(x.varesalg, 0), coalesce(x.provisjon, 0),
         coalesce(x.justeringer, 0), coalesce(x.til_utbetaling, 0),
         p.paid_on, p.amount_inc_vat,
         case when is_garnly_admin() then p.marked_by end,
         is_garnly_admin() and p.store_id is null and m.maaned < oslo_month(now())
  from stores s
  cross join mnd m
  left join sum_ x               on x.store_id = s.id and x.maaned = m.maaned
  left join settlement_payouts p on p.store_id = s.id and p.month = m.maaned and p.annullert_at is null
  where (is_garnly_admin() or s.id in (select current_store_ids()))
    and (p_store is null or s.id = p_store)
    and (x.store_id is not null or p.store_id is not null or m.maaned = oslo_month(now()))
  order by m.maaned desc, s.name;
$$;

-- ---------------------------------------------------------------------------
-- Skriving: bare Garnly
--
-- Sjekker garnly_admins eksplisitt – et filter som gir null rader stopper ingen skriving.
-- ---------------------------------------------------------------------------
create or replace function mark_settlement_paid(p_store uuid, p_month date, p_paid_on date default null)
returns settlement_payouts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_idag  date := (now() at time zone 'Europe/Oslo')::date;
  v_by    text := coalesce(auth.jwt() ->> 'email', auth.uid()::text);
  v_row   settlement_payouts;
begin
  if not exists (select 1 from garnly_admins where user_id = auth.uid()) then
    raise exception 'Bare Garnly kan markere utbetalinger' using errcode = 'insufficient_privilege';
  end if;
  -- En måned som fortsatt løper kan få flere ordrer etter at den er «betalt».
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

-- Angre en feilmarkering. Raden annulleres, ikke fjernes: det skal gå an å se at en måned var
-- markert og ble angret, og av hvem. Trekk som alt er flyttet til neste måned blir liggende der.
create or replace function unmark_settlement_paid(p_store uuid, p_month date)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_by    text := coalesce(auth.jwt() ->> 'email', auth.uid()::text);
  v_row   settlement_payouts;
begin
  if not exists (select 1 from garnly_admins where user_id = auth.uid()) then
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

revoke execute on function settlement_lines(date, date, uuid)       from public, anon;
revoke execute on function settlement_summary(date, date, uuid)     from public, anon;
revoke execute on function settlement_months(uuid, int)             from public, anon;
revoke execute on function mark_settlement_paid(uuid, date, date)   from public, anon;
revoke execute on function unmark_settlement_paid(uuid, date)       from public, anon;
revoke execute on function oslo_month(timestamptz)                  from public, anon;
revoke execute on function routing_group_commission()               from public, anon, authenticated;
revoke execute on function settlement_adjustment_fill()             from public, anon, authenticated;
grant execute on function settlement_lines(date, date, uuid)        to authenticated;
grant execute on function settlement_summary(date, date, uuid)      to authenticated;
grant execute on function settlement_months(uuid, int)              to authenticated;
grant execute on function mark_settlement_paid(uuid, date, date)    to authenticated;
grant execute on function unmark_settlement_paid(uuid, date)        to authenticated;

-- ---------------------------------------------------------------------------
-- «Refundert» i Tidligere ordrer
--
-- Samme definisjon som i 029, med to kolonner lagt til på slutten.
-- ---------------------------------------------------------------------------
create or replace view v_panel_history as
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
  ro.customer ->> 'country'   as ship_country,
  g.manually_shipped_at,
  -- Refundert varebeløp (positivt), uten frakt. Null = ikke refundert.
  (select -sum(a.gross_inc_vat) from settlement_adjustments a
    where a.group_id = g.id and a.kind = 'refund')             as refundert,
  (select max(a.occurred_at) from settlement_adjustments a
    where a.group_id = g.id and a.kind = 'refund')             as refundert_at
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
  null::text                  as ship_country,
  null::timestamptz           as manually_shipped_at,
  null::numeric               as refundert,
  null::timestamptz           as refundert_at
from offers o
join routing_groups g  on g.id = o.routing_group_id
join routing_orders ro on ro.id = g.routing_order_id
where o.store_id in (select current_store_ids())
  and o.status in ('declined', 'declined_stock')
  and coalesce(g.assigned_store_id, '00000000-0000-0000-0000-000000000000'::uuid) <> o.store_id;

-- ---------------------------------------------------------------------------
-- Backstop: refusjoner der webhooken aldri kom fram. Nattlig, før ops-digest kl. 08.
-- ---------------------------------------------------------------------------
select cron.schedule('refund-backstop', '50 4 * * *',
  $$ select call_edge_function('order-refunded', '{"mode":"backstop"}'::jsonb) $$);
