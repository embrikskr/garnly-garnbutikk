-- Tilgang til viewene: to lekker tettet, og anon ut av alle.
--
-- Supabase-linteren (01.10.2026) flagget 11 view som «security definer». Gjennomgang:
--
-- To av dem filtrerte ikke på noe, og var lesbare for `anon`:
--   v_store_overview   butikkene, kassesystem, synkstatus, varer på lager, umatchede varer
--   v_offer_stats_30d  godtatt/avslått/utløpt per butikk siste 30 dager
-- Anon-nøkkelen står åpent i panel/config.js, så hvem som helst kunne lese dem rett fra
-- REST-API-et. Ingen kundedata, men forretningstall som ikke skal ut – og en innlogget butikk
-- så de andre butikkenes tall. Begge er fra 001, laget før panelet fantes, da bare dashboardet
-- leste dem, med service role. Det gjør det fortsatt: dashboard/lib/db.ts bruker service role,
-- og v_offer_stats_30d brukes ingen steder.
--   → security_invoker, og ingen tilgang for anon eller authenticated. Service role omgår RLS
--     og ser alt som før.
--
-- De ni andre (v_panel_* og v_admin_*) kjører som eier MED VILJE og filtrerer selv på
-- current_store_ids() / is_garnly_admin() – se 008 og 025. Butikkbrukerne skal ikke ha
-- lesetilgang på tabellene under, bare på de kolonnene viewene plukker ut. Linteren ser bare
-- at de kjører som eier, ikke filteret, og vil fortsette å flagge dem.
--   → bare anon ut: panelet leser ingenting før innlogging, og anon fikk uansett null rader.
--     Ett lag til, i tilfelle et filter en gang blir feil.

alter view v_store_overview  set (security_invoker = true);
alter view v_offer_stats_30d set (security_invoker = true);
revoke all on v_store_overview  from anon, authenticated;
revoke all on v_offer_stats_30d from anon, authenticated;

revoke all on
  v_panel_queue, v_panel_assigned, v_panel_history, v_panel_stats,
  v_admin_action_needed, v_admin_orders, v_admin_settlement, v_admin_sync, v_admin_stats,
  v_store_settlement, v_pos_catalog_status
from anon;

-- ---------------------------------------------------------------------------
-- Funksjoner som kan kalles via /rest/v1/rpc/.
--
-- Supabase gir anon og authenticated EXECUTE på alt nytt i public. Ingen av disse er farlige
-- i dag – sjekket 01.10.2026: mark_pos_deducted avviser alle uten butikk, de to hjelperne gir
-- tomt/false for anon, og call_edge_function får «permission denied for schema vault» for
-- både anon og butikkbrukere. Men ingen av dem skal kunne kalles av noen som ikke trenger det.
-- ---------------------------------------------------------------------------

-- Panelet: bare innloggede. Hjelperne må authenticated beholde – viewene og RLS-policyene
-- kaller dem, og PostgreSQL sjekker EXECUTE mot den som spør, ikke mot view-eieren.
revoke execute on function current_store_ids()        from public, anon;
revoke execute on function is_garnly_admin()          from public, anon;
revoke execute on function mark_pos_deducted(uuid)    from public, anon;

-- Interne: bare kalt av Edge Functions med service role, og av pg_cron (postgres).
revoke execute on function call_edge_function(text, jsonb) from public, anon, authenticated;
revoke execute on function mark_store_assigned(uuid)        from public, anon, authenticated;
revoke execute on function mark_store_timeout(uuid)         from public, anon, authenticated;
revoke execute on function qualified_stores(jsonb)          from public, anon, authenticated;
revoke execute on function store_coverage(jsonb)            from public, anon, authenticated;

-- Fast search_path, så en rolle ikke kan skygge tabellnavnene med egne objekter.
alter function call_edge_function(text, jsonb) set search_path = public;
alter function mark_store_assigned(uuid)        set search_path = public;
alter function mark_store_timeout(uuid)         set search_path = public;
alter function qualified_stores(jsonb)          set search_path = public;
alter function store_coverage(jsonb)            set search_path = public;
alter function set_updated_at()                 set search_path = public;
