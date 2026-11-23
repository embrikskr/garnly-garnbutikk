-- 042: Oppgjør for partnerbutikk som er selger (KreStoffer, Danmark), i butikkens valuta
--
-- Byggeplan §15b (18.11.2026): i Danmark er partnerbutikken selger, ikke Garnly. Garnly formidler
-- salget og tar imot betalingen på vegne av butikken. Det betyr for oppgjøret:
--
--   • Hele beløpet kunden betalte (varer og frakt, inkl. dansk moms) er butikkens salg.
--   • Garnly beholder provisjonen: commission_pct av varene uten moms (dansk moms er også 25 %,
--     så settlement_ex_vat gjelder). Provisjonen faktureres butikken; momsen på den avklares med
--     regnskapsfører (tjeneste fra Norge til dansk virksomhet).
--   • Ingen fraktkostnad trekkes: butikken sender med sitt eget oppsett og får frakten kunden betalte.
--   • Betalingsgebyret bærer Garnly (Embrik 18.11.2026).
--   • Ingen mva legges oppå: butikken har alt momsen i beløpet og innberetter den selv.
--   • Alt regnes i butikkens valuta (DKK), med beløpene fra ordren som lages i butikkens Shopify
--     (_shared/partner_order.ts) – de samme tallene som står på kvitteringen kunden får derfra.
--   • En refusjon trekker det refunderte varebeløpet i butikkens valuta, minus provisjonen på det.
--
-- Norske butikker regnes som før (040). Formelen står fortsatt bare i regneboka.
--
-- Trygg å kjøre flere ganger. Ingen DROP: viewene erstattes med de samme kolonnene og nye til slutt.

alter table stores
  add column if not exists is_seller           boolean not null default false,
  add column if not exists settlement_currency text    not null default 'NOK';

comment on column stores.is_seller is
  'Butikken er selger overfor kunden (Danmark, byggeplan §15b). Oppgjøret er da hele beløpet kunden betalte minus provisjonen på varene, i settlement_currency, uten mva oppå.';
comment on column stores.settlement_currency is 'Valutaen butikken gjøres opp i. NOK for norske butikker.';

update stores set is_seller = true, settlement_currency = 'DKK'
 where slug = 'krestoffer' and country = 'DK' and not is_seller;

-- Beløpene i butikkens valuta, satt når ordren lages i butikkens Shopify.
alter table routing_groups
  add column if not exists store_is_seller      boolean,
  add column if not exists presentment_currency text,
  add column if not exists gross_presentment    numeric(12,2),
  add column if not exists shipping_presentment numeric(12,2);

comment on column routing_groups.store_is_seller is 'Om butikken var selger da den fikk ordren. Satt av trigger, som provisjonen.';
comment on column routing_groups.presentment_currency is 'Valutaen kunden betalte i (DKK). Satt av partner_order.ts.';
comment on column routing_groups.gross_presentment is 'Varene i gruppa inkl. moms, i kundens valuta, slik ordren ble laget i butikkens Shopify.';
comment on column routing_groups.shipping_presentment is 'Frakten kunden betalte, i kundens valuta. Bare på gruppa som fikk frakten.';

alter table settlement_adjustments
  add column if not exists gross_presentment numeric(12,2);
comment on column settlement_adjustments.gross_presentment is
  'Refundert varebeløp inkl. moms i kundens valuta, negativt. Brukes for butikker som er selger.';

-- Vilkårene fryses når butikken får ordren (031, 040). Nå også om butikken er selger.
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
    new.store_is_seller := null;
  elsif tg_op = 'INSERT' or new.assigned_store_id is distinct from old.assigned_store_id then
    select commission_pct, shipping_cost_ex_vat, payment_fee_on_store, is_seller
      into new.commission_pct, new.shipping_cost_ex_vat, new.payment_fee_on_store, new.store_is_seller
      from stores where id = new.assigned_store_id;
  end if;
  return new;
end $$;

update routing_groups g set store_is_seller = s.is_seller
  from stores s where s.id = g.assigned_store_id and g.store_is_seller is null;

-- Returer: selgerbutikken trekkes det refunderte varebeløpet i sin valuta, minus provisjonen.
create or replace function settlement_adjustment_fill()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  andel  numeric;
  mva    numeric;
  selger boolean;
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
    selger := coalesce(
      (select store_is_seller from routing_groups where id = new.group_id),
      (select is_seller from stores where id = new.store_id), false);

    if selger then
      if new.gross_presentment is null or new.gross_presentment >= 0 then
        raise exception 'En refusjon hos en butikk som er selger må ha negativt varebeløp i gross_presentment';
      end if;
      brutto := abs(new.gross_presentment);
      new.amount_inc_vat := -(brutto - round(settlement_ex_vat(brutto) * new.commission_pct / 100, 2));
    else
      select case when s.vat_registered then 25 else 0 end into mva from stores s where s.id = new.store_id;
      andel := round(settlement_ex_vat(abs(new.gross_inc_vat)) * (100 - new.commission_pct) / 100, 2);
      new.amount_inc_vat := -round(andel * (100 + coalesce(mva, 25)) / 100, 2);
    end if;
  end if;

  if new.settlement_month is null then
    new.settlement_month := oslo_month(new.occurred_at);
  end if;
  return new;
end $$;

comment on column settlement_adjustments.amount_inc_vat is
  'Det butikken trekkes (negativt), i butikkens valuta. Norsk butikk: andelen av det refunderte varebeløpet inkl. mva. Selgerbutikk: det refunderte varebeløpet minus provisjonen.';

-- ---------------------------------------------------------------------------
-- Regneboka (040), med selgerbutikkene. Samme kolonner som før, pluss valuta til slutt.
--   Norsk butikk:  grunnlag = varesalg + fraktinntekt − fraktkostnad − gebyr, uten mva;
--                  butikken får sin prosent av grunnlaget.
--   Selgerbutikk:  varesalg og fraktinntekt er det kunden betalte, inkl. moms, i butikkens valuta;
--                  ingen fraktkostnad eller gebyr; Garnly får commission_pct av varene uten moms,
--                  butikken resten. gebyr_mangler er sann når beløpet i butikkens valuta mangler.
-- ---------------------------------------------------------------------------
create or replace view settlement_ledger with (security_invoker = true) as
with tildelt as (
  select g.id, g.routing_order_id, g.assigned_store_id as store_id, g.fulfilled_at,
         coalesce(g.gross_inc_vat, 0)                                   as gross,
         coalesce(g.commission_pct, s.commission_pct)                   as garnly_pct,
         coalesce(g.store_is_seller, s.is_seller)                       as selger,
         case when coalesce(g.store_is_seller, s.is_seller) then 0
              else coalesce(g.shipping_cost_ex_vat, s.shipping_cost_ex_vat) end as fraktkostnad,
         coalesce(g.payment_fee_on_store, s.payment_fee_on_store)       as fee_on_store,
         g.gross_presentment, g.shipping_presentment,
         coalesce(g.presentment_currency, s.settlement_currency)        as butikk_valuta,
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
         case when f.selger then f.gross_presentment
              else settlement_ex_vat(f.gross) end                                     as varesalg,
         case when f.selger then coalesce(f.shipping_presentment, 0)
              when f.rn = 1 then settlement_ex_vat(f.shipping_inc_vat) else 0 end     as fraktinntekt,
         case when f.selger then 0
              when f.fee_on_store then f.gebyr_andel else 0 end                       as gebyr,
         case when f.selger then f.gross_presentment is null
              else (f.fee_on_store and f.payment_fee is null) end                     as gebyr_mangler,
         case when f.selger then f.butikk_valuta else 'NOK' end                       as valuta
  from fordelt f
  where f.fulfilled_at is not null
), regnet as (
  select s.*,
         s.varesalg + s.fraktinntekt - s.fraktkostnad - coalesce(s.gebyr, 0)          as grunnlag,
         case when s.selger then round(settlement_ex_vat(s.varesalg) * s.garnly_pct / 100, 2) end as provisjon
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
  case when r.selger then r.grunnlag - r.provisjon
       else round(r.grunnlag * (100 - r.garnly_pct) / 100, 2) end as butikk,
  case when r.selger then r.provisjon
       else r.grunnlag - round(r.grunnlag * (100 - r.garnly_pct) / 100, 2) end as garnly,
  null::numeric                                             as refundert,
  null::numeric                                             as trekk,
  null::text                                                as beskrivelse,
  r.fulfilled_at                                            as tidspunkt,
  r.valuta
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
  case when coalesce(g.store_is_seller, s.is_seller) then a.gross_presentment else a.gross_inc_vat end,
  a.amount_inc_vat,
  a.reason,
  a.occurred_at,
  case when coalesce(g.store_is_seller, s.is_seller) then s.settlement_currency else 'NOK' end
from settlement_adjustments a
join stores s               on s.id = a.store_id
left join routing_groups g  on g.id = a.group_id
left join routing_orders ro on ro.id = g.routing_order_id
where not coalesce(ro.is_test, false);

revoke all on settlement_ledger from anon, authenticated;
grant select on settlement_ledger to service_role;

-- Summene (040). Selgerbutikken får ingen mva oppå; valutaen står til slutt.
create or replace view settlement_period_totals with (security_invoker = true) as
select x.store_id, x.periode, x.ordrer, x.varesalg, x.fraktinntekt, x.fraktkostnad, x.gebyr,
       x.grunnlag, x.butikk_andel, x.garnly_andel, x.mva_pct, x.returer, x.gebyr_mangler,
       round(x.butikk_andel * x.mva_pct / 100, 2)                              as mva,
       x.butikk_andel + round(x.butikk_andel * x.mva_pct / 100, 2) + x.returer  as til_utbetaling,
       x.valuta_                                                               as valuta
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
         (case when s.is_seller then 0 when s.vat_registered then 25 else 0 end)::numeric as mva_pct,
         coalesce(sum(l.trekk), 0)                       as returer,
         (count(*) filter (where l.gebyr_mangler))::int  as gebyr_mangler,
         s.settlement_currency                           as valuta_
  from settlement_ledger l
  join stores s on s.id = l.store_id
  group by l.store_id, l.periode, s.vat_registered, s.is_seller, s.settlement_currency
) x;

revoke all on settlement_period_totals from anon, authenticated;
grant select on settlement_period_totals to service_role;

-- Perioden slik den står nå (040), med valuta og om butikken er selger.
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
               'gebyr', gebyr, 'gebyr_mangler', gebyr_mangler, 'grunnlag', grunnlag, 'valuta', valuta,
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
      'mva_pct', coalesce(t.mva_pct, case when s.is_seller then 0 when s.vat_registered then 25 else 0 end),
      'mva', coalesce(t.mva, 0),
      'returer', coalesce(t.returer, 0),
      'til_utbetaling', coalesce(t.til_utbetaling, 0),
      'gebyr_mangler', coalesce(t.gebyr_mangler, 0),
      'valuta', coalesce(t.valuta, s.settlement_currency),
      'butikken_er_selger', s.is_seller))
  from stores s
  left join settlement_period_totals t on t.store_id = s.id and t.periode = p_period
  where s.id = p_store;
$$;


-- Én periode (040). Hindringen og selgeren sier fra om butikken er selger og valutaen.
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
    when (live -> 'totals' ->> 'gebyr_mangler')::int > 0 then case when v_store.is_seller then 'Beløpet i butikkens valuta mangler for noen av ordrene.' else 'Betalingsgebyret er ikke hentet for alle ordrene.' end
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
      'butikken_er_selger', v_store.is_seller,
      'valuta', v_store.settlement_currency,
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


-- Lag avregningen (040). Selgerbutikken stoppes når beløpet i dens valuta mangler.
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
    if v_store.is_seller then
      raise exception 'Beløpet i % mangler for %.', v_store.settlement_currency, v_mangler using errcode = 'check_violation';
    end if;
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
                       'butikken_er_selger', v_store.is_seller, 'valuta', v_store.settlement_currency,
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


revoke execute on function routing_group_commission()                     from public, anon, authenticated;
revoke execute on function settlement_adjustment_fill()                   from public, anon, authenticated;
revoke execute on function settlement_snapshot(uuid, date)                from public, anon, authenticated;
revoke execute on function settlement_period_detail(uuid, date)           from public, anon;
revoke execute on function issue_settlement_statement(uuid, date, date)   from public, anon;
grant execute on function settlement_snapshot(uuid, date)                 to service_role;
grant execute on function settlement_period_detail(uuid, date)            to authenticated, service_role;
grant execute on function issue_settlement_statement(uuid, date, date)    to authenticated, service_role;
