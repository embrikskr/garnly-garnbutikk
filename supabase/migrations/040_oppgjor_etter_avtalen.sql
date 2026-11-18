-- 040: Butikkoppgjøret regnes etter samarbeidsavtalen (18.11.2026)
--
-- Embrik sendte avregningen SF-2026-01 (Strikkefryd, salg sendt 16.–31. oktober 2026): «den jeg
-- sendte her er riktig. så fiks det så det blir riktig». Regneboka har til nå gitt butikken
-- varebeløpet inkl. mva minus 10 %, per måned, etter dagen ordren ble gitt til butikken. Det er
-- ikke avtalen. For de seks ordrene i SF-2026-01 ga det 4 581,90 kr; avregningen sier 4 384,19 kr.
--
-- Avtalens punkt 5, slik avregningen regner (alle beløp uten merverdiavgift):
--
--   grunnlag per ordre = varesalg + fraktinntekt − fraktkostnad − betalingsgebyr
--     varesalg       varene kunden betalte for, uten mva
--     fraktinntekt   frakten kunden betalte, uten mva
--     fraktkostnad   avtalens sats per pakke (70 kr)
--     betalingsgebyr det faktiske gebyret Shopify Payments tok for ordren
--   butikken får 90 % av grunnlaget (100 − commission_pct), avrundet til øre per ordre
--   Garnly får resten
--   butikkens andel for perioden får 25 % mva oppå, regnet på summen
--   returer i perioden trekkes fra
--
-- Perioder: to i måneden, etter dagen ordren ble SENDT (fulfilled_at, norsk tid). Salg sendt
-- 1.–15. avregnes innen den 20. og utbetales innen den 25. Salg sendt 16.–siste avregnes innen
-- den 5. og utbetales innen den 10. i måneden etter. Ordrer som ikke er sendt, er ikke med.
--
-- Nytt i basen:
--   • routing_orders.payment_fee: gebyret per ordre, hentet fra Shopify (functions/settlement-fees).
--   • stores: fraktsats, om gebyret deles, om butikken er mva-registrert, og det som står på
--     avregningen (juridisk navn, org.nr., adresse, prefiks for avregningsnummeret).
--   • settlement_statements: avregningen. Når den lages, fryses tallene og linjene, og den får
--     nummer (SF-2026-02). Utbetalingen markeres på avregningen. Kommer en ordre eller en retur
--     til en periode som alt er avregnet, havner den i neste åpne periode.
--   • settlement_ledger regner etter avtalen. Funksjonene som leser den, er nye:
--     settlement_periods, settlement_period_detail, settlement_overview.
--
-- Fjernet: settlement_lines, settlement_summary, settlement_months, settlement_month_lines og de
-- gamle mark_/unmark_settlement_paid (per måned). settlement_payouts står igjen, tom og ubrukt.
--
-- Trygg å kjøre flere ganger. Kjøres i SQL Editor: DROP FUNCTION stoppes av Supabase-koblingen.

-- ---------------------------------------------------------------------------
-- Perioder og mva
-- ---------------------------------------------------------------------------
create or replace function settlement_period_start(d date)
returns date
language sql
immutable
set search_path = public
as $$
  select case when extract(day from d) <= 15
              then date_trunc('month', d)::date
              else (date_trunc('month', d) + interval '15 days')::date end;
$$;

create or replace function settlement_period_end(p date)
returns date
language sql
immutable
set search_path = public
as $$
  select case when extract(day from p) <= 15
              then (date_trunc('month', p) + interval '14 days')::date
              else (date_trunc('month', p) + interval '1 month' - interval '1 day')::date end;
$$;

create or replace function settlement_period_next(p date)
returns date
language sql
immutable
set search_path = public
as $$ select settlement_period_end(p) + 1; $$;

create or replace function oslo_period(ts timestamptz)
returns date
language sql
stable
set search_path = public
as $$ select settlement_period_start((ts at time zone 'Europe/Oslo')::date); $$;

-- Beløp uten merverdiavgift. Garnly selger garn til kunder i Norge med 25 % mva. Satsen står
-- bare her.
create or replace function settlement_ex_vat(amount numeric)
returns numeric
language sql
immutable
set search_path = public
as $$ select round(coalesce(amount, 0) / 1.25, 2); $$;

-- ---------------------------------------------------------------------------
-- Vilkårene per butikk, og det som står på avregningen
-- ---------------------------------------------------------------------------
alter table stores
  add column if not exists shipping_cost_ex_vat numeric(10,2) not null default 70.00,
  add column if not exists payment_fee_on_store boolean       not null default true,
  add column if not exists vat_registered       boolean       not null default true,
  add column if not exists legal_name           text,
  add column if not exists org_nr               text,
  add column if not exists legal_address        text,
  add column if not exists settlement_prefix    text;

comment on column stores.shipping_cost_ex_vat is
  'Avtalens fraktsats per pakke, uten mva. Trekkes fra grunnlaget i oppgjøret.';
comment on column stores.payment_fee_on_store is
  'Sant: det faktiske betalingsgebyret trekkes fra grunnlaget før delingen. Usant: Garnly bærer gebyret alene.';
comment on column stores.vat_registered is
  'Butikken er mva-registrert. Da får butikkens andel 25 % mva oppå i avregningen.';
comment on column stores.legal_name is 'Selskapsnavnet på avregningen, f.eks. «Strikkefryd AS».';
comment on column stores.org_nr is 'Organisasjonsnummeret på avregningen, uten «MVA».';
comment on column stores.legal_address is 'Adressen på avregningen.';
comment on column stores.settlement_prefix is 'Forbokstavene i avregningsnummeret, f.eks. SF i SF-2026-01.';

-- Fra avregningen SF-2026-01. Skrives bare der feltet er tomt.
update stores set legal_name = 'Strikkefryd AS'                   where slug = 'strikkefryd' and legal_name is null;
update stores set org_nr = '917 415 137'                          where slug = 'strikkefryd' and org_nr is null;
update stores set legal_address = 'Stasjonsgata 3, 3050 Mjøndalen' where slug = 'strikkefryd' and legal_address is null;
update stores set settlement_prefix = 'SF' where slug = 'strikkefryd' and settlement_prefix is null;
update stores set settlement_prefix = 'GK' where slug = 'garnkilden'  and settlement_prefix is null;
update stores set settlement_prefix = 'KS' where slug = 'krestoffer'  and settlement_prefix is null;
-- Embrik 18.11.2026: gebyret til Shopify Payments på danske ordrer betaler Garnly. Resten av det
-- danske oppgjøret (DKK, dansk frakt og moms) er ikke bygget; se STATUS.md.
update stores set payment_fee_on_store = false where slug = 'krestoffer' and country = 'DK';

-- Vilkårene fryses når butikken får ordren, som provisjonen (031). Ellers ville en ny avtale
-- skrevet om perioder som alt er avregnet.
alter table routing_groups
  add column if not exists shipping_cost_ex_vat numeric(10,2),
  add column if not exists payment_fee_on_store boolean;

comment on column routing_groups.shipping_cost_ex_vat is
  'Fraktsatsen da butikken fikk ordren. Satt av trigger; oppgjøret bruker denne.';
comment on column routing_groups.payment_fee_on_store is
  'Om gebyret deles med butikken, slik det var da butikken fikk ordren. Satt av trigger.';

create or replace function routing_group_commission()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.assigned_store_id is null then
    new.commission_pct := null;
    new.shipping_cost_ex_vat := null;
    new.payment_fee_on_store := null;
  elsif tg_op = 'INSERT' or new.assigned_store_id is distinct from old.assigned_store_id then
    select commission_pct, shipping_cost_ex_vat, payment_fee_on_store
      into new.commission_pct, new.shipping_cost_ex_vat, new.payment_fee_on_store
      from stores where id = new.assigned_store_id;
  end if;
  return new;
end $$;

update routing_groups g
   set shipping_cost_ex_vat = s.shipping_cost_ex_vat,
       payment_fee_on_store = s.payment_fee_on_store
  from stores s
 where s.id = g.assigned_store_id and g.shipping_cost_ex_vat is null;

-- ---------------------------------------------------------------------------
-- Betalingsgebyret per ordre
--
-- Hentes fra Shopify (order.transactions.fees) av functions/settlement-fees. Null = ikke hentet
-- ennå. En periode kan ikke avregnes før alle ordrene i den har gebyret.
-- ---------------------------------------------------------------------------
alter table routing_orders
  add column if not exists payment_fee           numeric(12,2),
  add column if not exists payment_fee_synced_at timestamptz,
  add column if not exists payment_fee_source    text;

comment on column routing_orders.payment_fee is
  'Det faktiske betalingsgebyret for ordren, i kroner. Null = ikke hentet fra Shopify ennå.';
comment on column routing_orders.payment_fee_source is 'shopify = hentet av settlement-fees, manuell = lagt inn for hånd.';

-- Gebyrene for ordrene til og med #1055, lest fra Shopify 18.11.2026 (order.transactions.fees).
-- Skrives bare der gebyret mangler.
update routing_orders ro
   set payment_fee = v.fee, payment_fee_synced_at = now(), payment_fee_source = 'shopify'
  from (values
    ('gid://shopify/Order/18958712569916', 21.99), -- #1019
    ('gid://shopify/Order/18958773846076', 28.43), -- #1020
    ('gid://shopify/Order/18960542662716', 27.00), -- #1021
    ('gid://shopify/Order/18961380180028', 13.48), -- #1022
    ('gid://shopify/Order/18962782224444', 13.48), -- #1023
    ('gid://shopify/Order/18963088179260', 22.06), -- #1024
    ('gid://shopify/Order/18966539862076', 21.99), -- #1025
    ('gid://shopify/Order/18967883415612', 15.47), -- #1026
    ('gid://shopify/Order/18970606469180', 54.29), -- #1027
    ('gid://shopify/Order/18972763979836', 10.85), -- #1028
    ('gid://shopify/Order/18973085073468', 13.48), -- #1029
    ('gid://shopify/Order/18973857447996', 40.27), -- #1030
    ('gid://shopify/Order/18975570165820', 13.48), -- #1031
    ('gid://shopify/Order/18975616106556', 19.35), -- #1032
    ('gid://shopify/Order/18975792988220', 35.45), -- #1033
    ('gid://shopify/Order/18976260718652', 18.97), -- #1034
    ('gid://shopify/Order/18977776959548', 13.48), -- #1035
    ('gid://shopify/Order/18978622799932', 13.48), -- #1036
    ('gid://shopify/Order/18980503683132', 25.20), -- #1037
    ('gid://shopify/Order/18981351751740', 13.48), -- #1038
    ('gid://shopify/Order/18982453968956', 15.47), -- #1039
    ('gid://shopify/Order/18982914588732', 10.85), -- #1040
    ('gid://shopify/Order/18984229371964', 22.06), -- #1041
    ('gid://shopify/Order/18987668373564', 21.46), -- #1042
    ('gid://shopify/Order/18988556779580', 22.06), -- #1043
    ('gid://shopify/Order/18989689569340', 25.20), -- #1044
    ('gid://shopify/Order/18993059037244', 31.30), -- #1045
    ('gid://shopify/Order/18997077344316', 15.13), -- #1046
    ('gid://shopify/Order/18997707538492', 19.52), -- #1047
    ('gid://shopify/Order/18998476570684', 10.85), -- #1048
    ('gid://shopify/Order/18998656958524', 22.06), -- #1049
    ('gid://shopify/Order/18999169384508', 21.46), -- #1050
    ('gid://shopify/Order/18999286595644', 22.06), -- #1051
    ('gid://shopify/Order/18999549853756', 18.21), -- #1052
    ('gid://shopify/Order/19000471093308', 13.48), -- #1053
    ('gid://shopify/Order/19000847499324', 13.48), -- #1054
    ('gid://shopify/Order/19002263535676',  8.40)  -- #1055
  ) as v(order_id, fee)
 where ro.shopify_order_id = v.order_id and ro.payment_fee is null;

-- ---------------------------------------------------------------------------
-- Avregningen
--
-- Én rad per butikk per periode som er avregnet. Tallene, linjene og selgeropplysningene fryses
-- i raden, så dokumentet er det samme i morgen som i dag. Angres avregningen (annullert_at),
-- blir raden stående med nummeret sitt, og linjene er frie igjen.
-- ---------------------------------------------------------------------------
create table if not exists settlement_statements (
  id             uuid primary key default gen_random_uuid(),
  store_id       uuid not null references stores(id),
  period_start   date not null check (extract(day from period_start) in (1, 16)),
  number         text not null unique,
  year           int  not null,
  seq            int  not null,
  issued_on      date not null,
  issued_by      text,
  totals         jsonb not null,
  lines          jsonb not null,
  returns        jsonb not null default '[]'::jsonb,
  seller         jsonb not null,
  group_ids      uuid[] not null default '{}',
  adjustment_ids uuid[] not null default '{}',
  til_utbetaling numeric(12,2) not null,
  paid_on        date,
  paid_by        text,
  paid_marked_at timestamptz,
  created_at     timestamptz not null default now(),
  annullert_at   timestamptz,
  annullert_av   text,
  unique (store_id, year, seq)
);
create unique index if not exists settlement_statements_active_uq
  on settlement_statements (store_id, period_start) where annullert_at is null;

comment on table settlement_statements is
  'Avregninger til butikkene. Tall og linjer er frosset slik de var da avregningen ble laget.';
comment on column settlement_statements.til_utbetaling is 'Butikkens andel + mva + returer, slik det sto da avregningen ble laget.';
comment on column settlement_statements.paid_on is 'Dagen beløpet ble utbetalt. Null = ikke utbetalt.';
comment on column settlement_statements.annullert_at is 'Avregningen er angret. Nummeret brukes ikke igjen.';

alter table settlement_statements enable row level security;
revoke all on settlement_statements from anon, authenticated;

comment on table settlement_payouts is
  'UTGÅTT (040). Utbetalinger markeres på settlement_statements. Tabellen er tom og leses ikke.';

-- Perioden en linje gjøres opp i: perioden den hører til, eller – hvis den perioden alt er
-- avregnet uten linja – neste periode som ikke er avregnet.
create or replace function settlement_period_for(p_store uuid, p_natural date, p_group uuid, p_adjustment uuid)
returns date
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  p  date := p_natural;
  st settlement_statements;
begin
  loop
    select * into st from settlement_statements s
     where s.store_id = p_store and s.period_start = p and s.annullert_at is null;
    if not found then return p; end if;
    if (p_group is not null and p_group = any (st.group_ids))
       or (p_adjustment is not null and p_adjustment = any (st.adjustment_ids)) then
      return p;
    end if;
    p := settlement_period_next(p);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Returer og justeringer
--
-- En refusjon trekker butikkens andel av det refunderte varebeløpet: varebeløpet uten mva ×
-- butikkens prosent, pluss mva hvis butikken er registrert. Frakt og gebyr på ordren er alt
-- delt og røres ikke. settlement_month fylles fortsatt (kolonnen er påkrevd), men brukes ikke.
-- ---------------------------------------------------------------------------
create or replace function settlement_adjustment_fill()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  andel numeric;
  mva   numeric;
begin
  if new.kind = 'refund' then
    if new.gross_inc_vat is null or new.gross_inc_vat >= 0 then
      raise exception 'En refusjon må ha negativt varebeløp i gross_inc_vat';
    end if;
    new.commission_pct := coalesce(
      new.commission_pct,
      (select commission_pct from routing_groups where id = new.group_id),
      (select commission_pct from stores where id = new.store_id));
    select case when s.vat_registered then 25 else 0 end into mva from stores s where s.id = new.store_id;
    andel := round(settlement_ex_vat(abs(new.gross_inc_vat)) * (100 - new.commission_pct) / 100, 2);
    new.amount_inc_vat := -round(andel * (100 + coalesce(mva, 25)) / 100, 2);
  end if;

  if new.settlement_month is null then
    new.settlement_month := oslo_month(new.occurred_at);
  end if;
  return new;
end $$;

comment on column settlement_adjustments.amount_inc_vat is
  'Det butikken trekkes (negativt), inkl. mva: butikkens andel av det refunderte varebeløpet.';
comment on column settlement_adjustments.settlement_month is
  'UTGÅTT (040). Perioden regnes av settlement_period_for().';

-- ---------------------------------------------------------------------------
-- Regneboka
--
-- Én linje per sendt ordre (gruppe) og per retur eller justering.
--   dato     – dagen ordren ble sendt, eller dagen returen ble refundert (norsk tid)
--   periode  – perioden linja gjøres opp i (den 1. eller den 16.)
-- Er en ordre delt på flere butikker, står fraktinntekten på den første gruppa, og gebyret
-- fordeles etter varebeløpet, med øreresten på den første.
-- gebyr er null og gebyr_mangler sann til gebyret er hentet; grunnlaget er da foreløpig.
-- Ikke lesbar for klientene; de går gjennom funksjonene under.
-- ---------------------------------------------------------------------------
drop function if exists settlement_lines(date, date, uuid);
drop function if exists settlement_summary(date, date, uuid);
drop function if exists settlement_months(uuid, int);
drop function if exists settlement_month_lines(date, uuid);
drop function if exists mark_settlement_paid(uuid, date, date);
drop function if exists unmark_settlement_paid(uuid, date);
drop view if exists settlement_period_totals;
drop view if exists settlement_ledger;

create view settlement_ledger with (security_invoker = true) as
with tildelt as (
  select g.id, g.routing_order_id, g.assigned_store_id as store_id, g.fulfilled_at,
         coalesce(g.gross_inc_vat, 0)                                   as gross,
         coalesce(g.commission_pct, s.commission_pct)                   as garnly_pct,
         coalesce(g.shipping_cost_ex_vat, s.shipping_cost_ex_vat)       as fraktkostnad,
         coalesce(g.payment_fee_on_store, s.payment_fee_on_store)       as fee_on_store,
         ro.shopify_order_id, ro.shopify_order_name, ro.shipping_inc_vat, ro.payment_fee,
         row_number() over (partition by g.routing_order_id order by g.group_no) as rn,
         sum(coalesce(g.gross_inc_vat, 0)) over (partition by g.routing_order_id) as order_gross
  from routing_groups g
  join routing_orders ro on ro.id = g.routing_order_id
  join stores s          on s.id = g.assigned_store_id
  where g.status in ('assigned', 'fulfilled')
    and g.assigned_at is not null
    and not ro.is_test
), andre as (
  select t.*,
         case when t.payment_fee is null or t.rn = 1 then null
              when t.order_gross > 0 then round(t.payment_fee * t.gross / t.order_gross, 2)
              else 0 end as gebyr_andre
  from tildelt t
), fordelt as (
  select a.*,
         case when a.payment_fee is null then null
              when a.rn = 1 then a.payment_fee - coalesce(sum(a.gebyr_andre) over (partition by a.routing_order_id), 0)
              else a.gebyr_andre end as gebyr_andel
  from andre a
), salg as (
  select f.*,
         settlement_ex_vat(f.gross)                                                   as varesalg,
         case when f.rn = 1 then settlement_ex_vat(f.shipping_inc_vat) else 0 end     as fraktinntekt,
         case when f.fee_on_store then f.gebyr_andel else 0 end                       as gebyr,
         (f.fee_on_store and f.payment_fee is null)                                   as gebyr_mangler
  from fordelt f
  where f.fulfilled_at is not null
), regnet as (
  select s.*,
         s.varesalg + s.fraktinntekt - s.fraktkostnad - coalesce(s.gebyr, 0)          as grunnlag
  from salg s
)
select
  'salg'::text                                              as art,
  r.store_id,
  r.id                                                      as group_id,
  null::uuid                                                as adjustment_id,
  r.shopify_order_id,
  r.shopify_order_name                                      as order_name,
  (r.fulfilled_at at time zone 'Europe/Oslo')::date         as dato,
  settlement_period_for(r.store_id, oslo_period(r.fulfilled_at), r.id, null) as periode,
  r.varesalg,
  r.fraktinntekt,
  r.fraktkostnad,
  r.gebyr,
  r.gebyr_mangler,
  r.grunnlag,
  100 - r.garnly_pct                                        as butikk_pct,
  round(r.grunnlag * (100 - r.garnly_pct) / 100, 2)         as butikk,
  r.grunnlag - round(r.grunnlag * (100 - r.garnly_pct) / 100, 2) as garnly,
  null::numeric                                             as refundert,
  null::numeric                                             as trekk,
  null::text                                                as beskrivelse,
  r.fulfilled_at                                            as tidspunkt
from regnet r

union all

select
  case a.kind when 'refund' then 'retur' else 'justering' end,
  a.store_id,
  a.group_id,
  a.id,
  ro.shopify_order_id,
  ro.shopify_order_name,
  (a.occurred_at at time zone 'Europe/Oslo')::date,
  settlement_period_for(a.store_id, oslo_period(a.occurred_at), null, a.id),
  null, null, null, null, false, null, null, null, null,
  a.gross_inc_vat,
  a.amount_inc_vat,
  a.reason,
  a.occurred_at
from settlement_adjustments a
left join routing_groups g  on g.id = a.group_id
left join routing_orders ro on ro.id = g.routing_order_id
where not coalesce(ro.is_test, false);

revoke all on settlement_ledger from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Summene per butikk per periode, slik regneboka står nå. Formelen står bare her:
--   butikkens andel = summen av «butikk» per ordre
--   mva             = andelen × 25 % (0 hvis butikken ikke er registrert), regnet på summen
--   til utbetaling  = andel + mva + returer
-- ---------------------------------------------------------------------------
create view settlement_period_totals with (security_invoker = true) as
select x.*,
       round(x.butikk_andel * x.mva_pct / 100, 2)                              as mva,
       x.butikk_andel + round(x.butikk_andel * x.mva_pct / 100, 2) + x.returer  as til_utbetaling
from (
  select l.store_id, l.periode,
         (count(*) filter (where l.art = 'salg'))::int   as ordrer,
         coalesce(sum(l.varesalg), 0)                    as varesalg,
         coalesce(sum(l.fraktinntekt), 0)                as fraktinntekt,
         coalesce(sum(l.fraktkostnad), 0)                as fraktkostnad,
         coalesce(sum(l.gebyr), 0)                       as gebyr,
         coalesce(sum(l.grunnlag), 0)                    as grunnlag,
         coalesce(sum(l.butikk), 0)                      as butikk_andel,
         coalesce(sum(l.garnly), 0)                      as garnly_andel,
         (case when s.vat_registered then 25 else 0 end)::numeric as mva_pct,
         coalesce(sum(l.trekk), 0)                       as returer,
         (count(*) filter (where l.gebyr_mangler))::int  as gebyr_mangler
  from settlement_ledger l
  join stores s on s.id = l.store_id
  group by l.store_id, l.periode, s.vat_registered
) x;

revoke all on settlement_period_totals from anon, authenticated;

-- Perioden slik den står nå: linjer, returer og summer. Intern; brukes av funksjonene under og
-- fryses i settlement_statements når avregningen lages.
create or replace function settlement_snapshot(p_store uuid, p_period date)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with l as (
    select * from settlement_ledger where store_id = p_store and periode = p_period
  ), salg as (
    select * from l where art = 'salg'
  ), andre as (
    select * from l where art <> 'salg'
  )
  select jsonb_build_object(
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'group_id', group_id, 'order_name', order_name, 'sendt', dato,
               'varesalg', varesalg, 'fraktinntekt', fraktinntekt, 'fraktkostnad', fraktkostnad,
               'gebyr', gebyr, 'gebyr_mangler', gebyr_mangler, 'grunnlag', grunnlag,
               'butikk_pct', butikk_pct, 'butikk', butikk, 'garnly', garnly)
             -- Etter ordrenummer, som på avregningen: #999 før #1000.
             order by length(order_name), order_name, tidspunkt)
      from salg), '[]'::jsonb),
    'returns', coalesce((
      select jsonb_agg(jsonb_build_object(
               'adjustment_id', adjustment_id, 'art', art, 'order_name', order_name, 'dato', dato,
               'refundert', refundert, 'trekk', trekk, 'beskrivelse', beskrivelse)
             order by tidspunkt, order_name)
      from andre), '[]'::jsonb),
    'group_ids', coalesce((select jsonb_agg(group_id) from salg), '[]'::jsonb),
    'adjustment_ids', coalesce((select jsonb_agg(adjustment_id) from andre), '[]'::jsonb),
    'totals', jsonb_build_object(
      'ordrer', coalesce(t.ordrer, 0),
      'varesalg', coalesce(t.varesalg, 0),
      'fraktinntekt', coalesce(t.fraktinntekt, 0),
      'fraktkostnad', coalesce(t.fraktkostnad, 0),
      'gebyr', coalesce(t.gebyr, 0),
      'grunnlag', coalesce(t.grunnlag, 0),
      'butikk_andel', coalesce(t.butikk_andel, 0),
      'garnly_andel', coalesce(t.garnly_andel, 0),
      'mva_pct', coalesce(t.mva_pct, case when s.vat_registered then 25 else 0 end),
      'mva', coalesce(t.mva, 0),
      'returer', coalesce(t.returer, 0),
      'til_utbetaling', coalesce(t.til_utbetaling, 0),
      'gebyr_mangler', coalesce(t.gebyr_mangler, 0)))
  from stores s
  left join settlement_period_totals t on t.store_id = s.id and t.periode = p_period
  where s.id = p_store;
$$;

-- Fristene i avtalen: 1.–15. avregnes innen den 20. og utbetales innen den 25. samme måned;
-- 16.–siste avregnes innen den 5. og utbetales innen den 10. i måneden etter.
create or replace function settlement_deadline(p_period date, p_what text)
returns date
language sql
immutable
set search_path = public
as $$
  select case
    when extract(day from p_period) = 1 then
      (date_trunc('month', p_period) + case p_what when 'avregnes' then interval '19 days' else interval '24 days' end)::date
    else
      (date_trunc('month', p_period) + interval '1 month' + case p_what when 'avregnes' then interval '4 days' else interval '9 days' end)::date
  end;
$$;

-- ---------------------------------------------------------------------------
-- Lesing: samme funksjoner for Garnly og butikk
--
-- Garnly ser alle butikker, en butikk bare seg selv. Sjekken ligger i funksjonen, så en butikk
-- kan ikke be om en annens tall ved å sende en annen p_store.
-- ---------------------------------------------------------------------------

-- Periode for periode, nyeste først. Perioder med noe i, pluss den som løper nå.
-- status: lopende (perioden er ikke over), klar (kan avregnes), avregnet, utbetalt.
-- Er perioden avregnet, er tallene de frosne. avvik = det regneboka sier nå minus det som ble
-- avregnet (0 når ingenting er endret etterpå).
create or replace function settlement_periods(p_store uuid default null, p_periods int default 24)
returns table (
  store_id uuid, butikk text, periode date, periode_slutt date, status text,
  ordrer int, varesalg numeric, fraktinntekt numeric, fraktkostnad numeric, gebyr numeric,
  grunnlag numeric, butikk_andel numeric, garnly_andel numeric, mva_pct numeric, mva numeric,
  returer numeric, til_utbetaling numeric, gebyr_mangler int,
  avregning_nr text, avregnet_dato date, avregnet_av text, utbetalt_dato date, utbetalt_av text,
  avregnes_innen date, utbetales_innen date, avvik numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with naa as (
    select oslo_period(now()) as periode, (now() at time zone 'Europe/Oslo')::date as idag
  ), synlig as (
    select s.id, s.name, s.vat_registered from stores s
    where (is_garnly_admin() or s.id in (select current_store_ids()))
      and (p_store is null or s.id = p_store)
  ), live as (
    select t.* from settlement_period_totals t where t.store_id in (select id from synlig)
  ), par as (
    select l.store_id, l.periode from live l
    union
    select st.store_id, st.period_start from settlement_statements st
     where st.annullert_at is null and st.store_id in (select id from synlig)
    union
    select y.id, n.periode from synlig y cross join naa n
  ), rad as (
    select p.store_id, p.periode, st.id as st_id, st.number, st.issued_on, st.issued_by, st.paid_on, st.paid_by,
           st.til_utbetaling as st_belop, st.totals as frosset,
           l.til_utbetaling as live_belop, coalesce(l.gebyr_mangler, 0) as gebyr_mangler,
           -- Avregnet: de frosne tallene. Ellers det regneboka sier nå.
           coalesce(st.totals, to_jsonb(l), '{}'::jsonb) as t
    from par p
    left join live l on l.store_id = p.store_id and l.periode = p.periode
    left join settlement_statements st
           on st.store_id = p.store_id and st.period_start = p.periode and st.annullert_at is null
  )
  select y.id, y.name, r.periode, settlement_period_end(r.periode),
         case when r.paid_on is not null then 'utbetalt'
              when r.st_id is not null then 'avregnet'
              when settlement_period_end(r.periode) >= n.idag then 'lopende'
              else 'klar' end,
         coalesce((r.t ->> 'ordrer')::int, 0),
         coalesce((r.t ->> 'varesalg')::numeric, 0), coalesce((r.t ->> 'fraktinntekt')::numeric, 0),
         coalesce((r.t ->> 'fraktkostnad')::numeric, 0), coalesce((r.t ->> 'gebyr')::numeric, 0),
         coalesce((r.t ->> 'grunnlag')::numeric, 0), coalesce((r.t ->> 'butikk_andel')::numeric, 0),
         coalesce((r.t ->> 'garnly_andel')::numeric, 0),
         coalesce((r.t ->> 'mva_pct')::numeric, case when y.vat_registered then 25 else 0 end),
         coalesce((r.t ->> 'mva')::numeric, 0), coalesce((r.t ->> 'returer')::numeric, 0),
         coalesce((r.t ->> 'til_utbetaling')::numeric, 0),
         r.gebyr_mangler,
         r.number, r.issued_on, case when is_garnly_admin() then r.issued_by end,
         r.paid_on, case when is_garnly_admin() then r.paid_by end,
         settlement_deadline(r.periode, 'avregnes'), settlement_deadline(r.periode, 'utbetales'),
         case when r.st_id is not null then coalesce(r.live_belop, 0) - r.st_belop else 0 end
  from rad r
  join synlig y on y.id = r.store_id
  cross join naa n
  order by r.periode desc, y.name
  limit greatest(least(p_periods, 200), 1) * greatest((select count(*) from synlig), 1);
$$;

-- Én periode for én butikk, med alt som står på avregningen: linjene, returene, summene,
-- selgeren og fristene. Er perioden avregnet, er det de frosne tallene som kommer.
create or replace function settlement_period_detail(p_store uuid, p_period date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_period date := settlement_period_start(p_period);
  v_idag   date := (now() at time zone 'Europe/Oslo')::date;
  v_store  stores;
  st       settlement_statements;
  live     jsonb;
  v_hindring text;
begin
  if not (is_garnly_admin() or p_store in (select current_store_ids())) then
    return null;
  end if;
  select * into v_store from stores where id = p_store;
  if not found then return null; end if;

  live := settlement_snapshot(p_store, v_period);
  select * into st from settlement_statements s
   where s.store_id = p_store and s.period_start = v_period and s.annullert_at is null;

  -- Hvorfor perioden ikke kan avregnes ennå, i klartekst. Null = den kan.
  v_hindring := case
    when st.id is not null then null
    when settlement_period_end(v_period) >= v_idag then 'Perioden er ikke over ennå.'
    when jsonb_array_length(live -> 'lines') = 0 and jsonb_array_length(live -> 'returns') = 0 then 'Ingen ordrer eller returer i perioden.'
    when (live -> 'totals' ->> 'gebyr_mangler')::int > 0 then 'Betalingsgebyret er ikke hentet for alle ordrene.'
    when coalesce(btrim(v_store.legal_name), '') = '' or coalesce(btrim(v_store.org_nr), '') = '' then 'Butikkens selskapsnavn og organisasjonsnummer mangler.'
  end;

  return jsonb_build_object(
    'store_id', p_store,
    'butikk', v_store.name,
    'periode', v_period,
    'periode_slutt', settlement_period_end(v_period),
    'neste_periode', settlement_period_next(v_period),
    'status', case when st.paid_on is not null then 'utbetalt'
                   when st.id is not null then 'avregnet'
                   when settlement_period_end(v_period) >= v_idag then 'lopende'
                   else 'klar' end,
    'avregnes_innen', settlement_deadline(v_period, 'avregnes'),
    'utbetales_innen', settlement_deadline(v_period, 'utbetales'),
    'kan_avregnes', st.id is null and v_hindring is null,
    'hindring', v_hindring,
    'avregning', case when st.id is null then null else jsonb_build_object(
      'nummer', st.number, 'dato', st.issued_on,
      'av', case when is_garnly_admin() then st.issued_by end,
      'utbetalt_dato', st.paid_on,
      'utbetalt_av', case when is_garnly_admin() then st.paid_by end) end,
    'selger', coalesce(st.seller, jsonb_build_object(
      'navn', coalesce(nullif(btrim(v_store.legal_name), ''), v_store.name),
      'org_nr', v_store.org_nr,
      'adresse', v_store.legal_address,
      'mva_registrert', v_store.vat_registered,
      'butikk', v_store.name)),
    'totals', coalesce(st.totals, live -> 'totals'),
    'lines', coalesce(st.lines, live -> 'lines'),
    'returns', coalesce(st.returns, live -> 'returns'),
    'avvik', case when st.id is not null then (live -> 'totals' ->> 'til_utbetaling')::numeric - st.til_utbetaling else 0 end,
    -- Ordrer butikken har fått, men ikke sendt. De kommer i perioden de blir sendt i.
    'ikke_sendt', (select count(*) from routing_groups g join routing_orders ro on ro.id = g.routing_order_id
                    where g.assigned_store_id = p_store and g.status = 'assigned'
                      and g.fulfilled_at is null and not ro.is_test));
end $$;

-- Én rad per butikk for et tidsrom, etter dagen ordren ble sendt. Til oversikter og statistikk;
-- avregningen leses fra settlement_periods. Butikker uten salg er med, med nuller.
create or replace function settlement_overview(p_from date, p_to date, p_store uuid default null)
returns table (
  store_id uuid, butikk text, butikk_pct numeric, ordrer bigint, varesalg numeric,
  fraktinntekt numeric, fraktkostnad numeric, gebyr numeric, grunnlag numeric,
  butikk_andel numeric, garnly_andel numeric, returer numeric, gebyr_mangler bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.name, 100 - s.commission_pct,
         count(l.art) filter (where l.art = 'salg'),
         coalesce(sum(l.varesalg), 0),
         coalesce(sum(l.fraktinntekt), 0),
         coalesce(sum(l.fraktkostnad), 0),
         coalesce(sum(l.gebyr), 0),
         coalesce(sum(l.grunnlag), 0),
         coalesce(sum(l.butikk), 0),
         coalesce(sum(l.garnly), 0),
         coalesce(sum(l.trekk), 0),
         count(*) filter (where l.gebyr_mangler)
  from stores s
  left join settlement_ledger l on l.store_id = s.id and l.dato between p_from and p_to
  where (is_garnly_admin() or s.id in (select current_store_ids()))
    and (p_store is null or s.id = p_store)
  group by s.id, s.name, s.commission_pct
  order by s.name;
$$;

-- ---------------------------------------------------------------------------
-- Skriving: bare Garnly (garnly_admin_actor, 038)
-- ---------------------------------------------------------------------------

-- Lag avregningen for en periode: frys tallene og gi den neste nummer for butikken i år.
create or replace function issue_settlement_statement(p_store uuid, p_period date, p_issued_on date default null)
returns settlement_statements
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period date := settlement_period_start(p_period);
  v_idag   date := (now() at time zone 'Europe/Oslo')::date;
  v_dato   date := coalesce(p_issued_on, (now() at time zone 'Europe/Oslo')::date);
  v_by     text := garnly_admin_actor();
  v_store  stores;
  v_snap   jsonb;
  v_mangler text;
  v_seq    int;
  v_row    settlement_statements;
begin
  if v_by is null then
    raise exception 'Bare Garnly kan lage avregninger' using errcode = 'insufficient_privilege';
  end if;
  if p_period is distinct from v_period then
    raise exception 'En periode starter den 1. eller den 16.' using errcode = 'check_violation';
  end if;
  select * into v_store from stores where id = p_store;
  if not found then
    raise exception 'Fant ikke butikken.' using errcode = 'no_data_found';
  end if;
  if settlement_period_end(v_period) >= v_idag then
    raise exception 'Perioden er ikke over ennå. Den kan avregnes fra %.', to_char(settlement_period_end(v_period) + 1, 'DD.MM.YYYY')
      using errcode = 'check_violation';
  end if;
  if v_dato > v_idag then
    raise exception 'Avregningsdatoen kan ikke være fram i tid.' using errcode = 'check_violation';
  end if;
  if coalesce(btrim(v_store.legal_name), '') = '' or coalesce(btrim(v_store.org_nr), '') = '' then
    raise exception 'Butikkens selskapsnavn og organisasjonsnummer må fylles inn før avregningen kan lages.'
      using errcode = 'check_violation';
  end if;

  -- Én om gangen per butikk, så to samtidige trykk ikke får samme nummer.
  perform pg_advisory_xact_lock(hashtext('settlement_statement:' || p_store::text));

  if exists (select 1 from settlement_statements s
              where s.store_id = p_store and s.period_start = v_period and s.annullert_at is null) then
    raise exception 'Perioden er allerede avregnet.' using errcode = 'unique_violation';
  end if;

  v_snap := settlement_snapshot(p_store, v_period);
  if jsonb_array_length(v_snap -> 'lines') = 0 and jsonb_array_length(v_snap -> 'returns') = 0 then
    raise exception 'Ingen ordrer eller returer i perioden.' using errcode = 'no_data_found';
  end if;
  if (v_snap -> 'totals' ->> 'gebyr_mangler')::int > 0 then
    select string_agg(x ->> 'order_name', ', ') into v_mangler
      from jsonb_array_elements(v_snap -> 'lines') x where (x ->> 'gebyr_mangler')::boolean;
    raise exception 'Betalingsgebyret mangler for %. Hent gebyrene før avregningen lages.', v_mangler
      using errcode = 'check_violation';
  end if;

  select coalesce(max(seq), 0) + 1 into v_seq from settlement_statements
   where store_id = p_store and year = extract(year from v_dato)::int;

  insert into settlement_statements (
    store_id, period_start, number, year, seq, issued_on, issued_by,
    totals, lines, returns, seller, group_ids, adjustment_ids, til_utbetaling)
  values (
    p_store, v_period,
    coalesce(nullif(btrim(v_store.settlement_prefix), ''), upper(left(v_store.slug, 2)))
      || '-' || extract(year from v_dato)::int || '-' || lpad(v_seq::text, 2, '0'),
    extract(year from v_dato)::int, v_seq, v_dato, v_by,
    v_snap -> 'totals', v_snap -> 'lines', v_snap -> 'returns',
    jsonb_build_object('navn', btrim(v_store.legal_name), 'org_nr', btrim(v_store.org_nr),
                       'adresse', v_store.legal_address, 'mva_registrert', v_store.vat_registered,
                       'butikk', v_store.name),
    coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(v_snap -> 'group_ids') x), '{}'),
    coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(v_snap -> 'adjustment_ids') x), '{}'),
    (v_snap -> 'totals' ->> 'til_utbetaling')::numeric)
  returning * into v_row;

  insert into audit_log (entity, entity_id, event, payload)
  values ('store', p_store, 'settlement_issued',
          jsonb_build_object('nummer', v_row.number, 'periode', v_period, 'dato', v_dato,
                             'belop', v_row.til_utbetaling, 'av', v_by));
  return v_row;
end $$;

-- Angre avregningen. Går bare så lenge den ikke er utbetalt. Raden blir stående med nummeret.
create or replace function withdraw_settlement_statement(p_store uuid, p_period date)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_by  text := garnly_admin_actor();
  v_row settlement_statements;
begin
  if v_by is null then
    raise exception 'Bare Garnly kan endre avregninger' using errcode = 'insufficient_privilege';
  end if;
  select * into v_row from settlement_statements
   where store_id = p_store and period_start = p_period and annullert_at is null for update;
  if not found then
    raise exception 'Perioden er ikke avregnet.' using errcode = 'no_data_found';
  end if;
  if v_row.paid_on is not null then
    raise exception 'Avregningen er markert som utbetalt. Angre utbetalingen først.' using errcode = 'check_violation';
  end if;
  update settlement_statements set annullert_at = now(), annullert_av = v_by where id = v_row.id;
  insert into audit_log (entity, entity_id, event, payload)
  values ('store', p_store, 'settlement_withdrawn',
          jsonb_build_object('nummer', v_row.number, 'periode', p_period, 'belop', v_row.til_utbetaling, 'av', v_by));
end $$;

-- Marker avregningen som utbetalt. Beløpet er det som står på avregningen.
create or replace function mark_settlement_paid(p_store uuid, p_period date, p_paid_on date default null)
returns settlement_statements
language plpgsql
security definer
set search_path = public
as $$
declare
  v_idag date := (now() at time zone 'Europe/Oslo')::date;
  v_dato date := coalesce(p_paid_on, (now() at time zone 'Europe/Oslo')::date);
  v_by   text := garnly_admin_actor();
  v_row  settlement_statements;
begin
  if v_by is null then
    raise exception 'Bare Garnly kan markere utbetalinger' using errcode = 'insufficient_privilege';
  end if;
  select * into v_row from settlement_statements
   where store_id = p_store and period_start = p_period and annullert_at is null for update;
  if not found then
    raise exception 'Perioden er ikke avregnet. Lag avregningen først.' using errcode = 'no_data_found';
  end if;
  if v_row.paid_on is not null then
    raise exception 'Avregningen er allerede markert som utbetalt.' using errcode = 'unique_violation';
  end if;
  if v_dato > v_idag then
    raise exception 'Utbetalingsdatoen kan ikke være fram i tid.' using errcode = 'check_violation';
  end if;
  update settlement_statements set paid_on = v_dato, paid_by = v_by, paid_marked_at = now()
   where id = v_row.id returning * into v_row;
  insert into audit_log (entity, entity_id, event, payload)
  values ('store', p_store, 'settlement_paid',
          jsonb_build_object('nummer', v_row.number, 'periode', p_period, 'utbetalt', v_dato,
                             'belop', v_row.til_utbetaling, 'av', v_by));
  return v_row;
end $$;

-- Angre en feilmarkert utbetaling. Avregningen står; den er bare ikke betalt lenger.
create or replace function unmark_settlement_paid(p_store uuid, p_period date)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_by  text := garnly_admin_actor();
  v_row settlement_statements;
begin
  if v_by is null then
    raise exception 'Bare Garnly kan endre utbetalinger' using errcode = 'insufficient_privilege';
  end if;
  select * into v_row from settlement_statements
   where store_id = p_store and period_start = p_period and annullert_at is null for update;
  if not found or v_row.paid_on is null then
    raise exception 'Perioden var ikke markert som utbetalt.' using errcode = 'no_data_found';
  end if;
  update settlement_statements set paid_on = null, paid_by = null, paid_marked_at = null where id = v_row.id;
  insert into audit_log (entity, entity_id, event, payload)
  values ('store', p_store, 'settlement_unpaid',
          jsonb_build_object('nummer', v_row.number, 'periode', p_period, 'var_utbetalt', v_row.paid_on,
                             'belop', v_row.til_utbetaling, 'av', v_by));
end $$;

-- ---------------------------------------------------------------------------
-- Tilgang (se 030 og 034): ingenting til anon, lesing og de sjekkede skrivefunksjonene til
-- innloggede, resten bare til eieren.
-- ---------------------------------------------------------------------------
revoke execute on function settlement_period_start(date)                    from public, anon;
revoke execute on function settlement_period_end(date)                      from public, anon;
revoke execute on function settlement_period_next(date)                     from public, anon;
revoke execute on function oslo_period(timestamptz)                         from public, anon;
revoke execute on function settlement_ex_vat(numeric)                       from public, anon;
revoke execute on function settlement_deadline(date, text)                  from public, anon;
revoke execute on function settlement_period_for(uuid, date, uuid, uuid)    from public, anon, authenticated;
revoke execute on function settlement_snapshot(uuid, date)                  from public, anon, authenticated;
revoke execute on function settlement_adjustment_fill()                     from public, anon, authenticated;
revoke execute on function routing_group_commission()                       from public, anon, authenticated;
revoke execute on function settlement_periods(uuid, int)                    from public, anon;
revoke execute on function settlement_period_detail(uuid, date)             from public, anon;
revoke execute on function settlement_overview(date, date, uuid)            from public, anon;
revoke execute on function issue_settlement_statement(uuid, date, date)     from public, anon;
revoke execute on function withdraw_settlement_statement(uuid, date)        from public, anon;
revoke execute on function mark_settlement_paid(uuid, date, date)           from public, anon;
revoke execute on function unmark_settlement_paid(uuid, date)               from public, anon;
grant execute on function settlement_periods(uuid, int)                     to authenticated, service_role;
grant execute on function settlement_period_detail(uuid, date)              to authenticated, service_role;
grant execute on function settlement_overview(date, date, uuid)             to authenticated, service_role;
grant execute on function issue_settlement_statement(uuid, date, date)      to authenticated, service_role;
grant execute on function withdraw_settlement_statement(uuid, date)         to authenticated, service_role;
grant execute on function mark_settlement_paid(uuid, date, date)            to authenticated, service_role;
grant execute on function unmark_settlement_paid(uuid, date)                to authenticated, service_role;
grant select on settlement_ledger, settlement_period_totals to service_role;
-- Regneboka er security_invoker: den som leser den direkte (service role, fra admin.garnly.no),
-- må selv få kjøre funksjonene den bruker.
grant execute on function settlement_period_for(uuid, date, uuid, uuid) to service_role;
grant execute on function settlement_snapshot(uuid, date)               to service_role;
grant execute on function oslo_period(timestamptz)                      to service_role;
grant execute on function settlement_ex_vat(numeric)                    to service_role;

-- ---------------------------------------------------------------------------
-- SF-2026-01: avregningen Strikkefryd fikk 11.11.2026 for salg sendt 16.–31. oktober
--
-- Den ble laget før systemet regnet etter avtalen. Legges inn med tallene regneboka gir nå, og
-- stopper hvis de ikke er avregningens: 6 ordrer, grunnlag 3 897,05, butikkens andel 3 507,35,
-- mva 876,84, til utbetaling 4 384,19. Da er regnestykket feil, og ingenting skal lagres.
-- ---------------------------------------------------------------------------
do $$
declare
  v_store stores;
  v_snap  jsonb;
  v_t     jsonb;
begin
  select * into v_store from stores where slug = 'strikkefryd';
  if not found then return; end if;
  if exists (select 1 from settlement_statements where number = 'SF-2026-01') then return; end if;
  if exists (select 1 from settlement_statements where store_id = v_store.id and period_start = date '2026-10-16' and annullert_at is null) then
    return;
  end if;

  v_snap := settlement_snapshot(v_store.id, date '2026-10-16');
  v_t := v_snap -> 'totals';
  if (v_t ->> 'ordrer')::int <> 6
     or (v_t ->> 'grunnlag')::numeric <> 3897.05
     or (v_t ->> 'butikk_andel')::numeric <> 3507.35
     or (v_t ->> 'mva')::numeric <> 876.84
     or (v_t ->> 'til_utbetaling')::numeric <> 4384.19 then
    raise exception 'Regneboka gir ikke tallene i SF-2026-01: %', v_t;
  end if;

  insert into settlement_statements (
    store_id, period_start, number, year, seq, issued_on, issued_by,
    totals, lines, returns, seller, group_ids, adjustment_ids, til_utbetaling)
  values (
    v_store.id, date '2026-10-16', 'SF-2026-01', 2026, 1, date '2026-11-11',
    'Halvor Skrindo (laget før systemet regnet avregningen)',
    v_t, v_snap -> 'lines', v_snap -> 'returns',
    jsonb_build_object('navn', v_store.legal_name, 'org_nr', v_store.org_nr, 'adresse', v_store.legal_address,
                       'mva_registrert', v_store.vat_registered, 'butikk', v_store.name),
    coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(v_snap -> 'group_ids') x), '{}'),
    '{}',
    (v_t ->> 'til_utbetaling')::numeric);

  insert into audit_log (entity, entity_id, event, payload)
  values ('store', v_store.id, 'settlement_issued',
          jsonb_build_object('nummer', 'SF-2026-01', 'periode', date '2026-10-16', 'dato', date '2026-11-11',
                             'belop', 4384.19, 'av', 'migrasjon 040'));
end $$;

-- ---------------------------------------------------------------------------
-- Gebyrene hentes hvert 30. minutt for ordrer som mangler dem (functions/settlement-fees).
-- ---------------------------------------------------------------------------
select cron.schedule('settlement-fees', '12,42 * * * *',
  $$ select call_edge_function('settlement-fees') $$);
