-- Panel- og admin-viewene: bare lesing (21.10.2026).
--
-- Supabase gir authenticated ALLE rettigheter på nye view i public, ikke bare SELECT. 030 tok
-- anon ut, men lot authenticated beholde skriving. To av viewene er så enkle at PostgreSQL gjør
-- dem automatisk oppdaterbare (én tabell i FROM, ingen join eller aggregat på toppnivå):
--
--   v_panel_stats  FROM stores WHERE id IN (current_store_ids())
--   v_admin_sync   FROM stores WHERE is_garnly_admin()
--
-- Viewene kjører som eier (se 030), så RLS på stores gjelder ikke gjennom dem. En innlogget
-- butikkbruker kunne derfor via REST-API-et endre id-en på sin egen butikkrad, eller slette
-- den – og stores har ON DELETE CASCADE til lager, umatchede varer, synkhistorikk, aliaser,
-- butikkbrukere og hemmeligheter (FK-ene fra ordrer og tilbud stopper det bare når butikken
-- har slike). Admin kunne i tillegg endre navn, kassesystem og aktiv-flagget gjennom
-- v_admin_sync. Ingen tegn til at det er gjort; panelet leser bare.
--
-- Rådgiveren i Supabase ser ikke dette: den flagger at viewene kjører som eier, ikke at de kan
-- skrives til.
--
-- Nå: authenticated får bare SELECT, og bare på viewene panelet faktisk leser. v_panel_stats
-- brukes ikke lenger (tallene øverst ble fjernet 08.10.2026), v_pos_catalog_status leses bare av
-- dashboardet med service role, og v_admin_settlement hører til oppgjørsfanen som ble fjernet.

revoke all on
  v_panel_queue, v_panel_assigned, v_panel_history, v_panel_stats,
  v_admin_action_needed, v_admin_orders, v_admin_sync, v_admin_stats,
  v_admin_settlement, v_store_settlement, v_pos_catalog_status
from authenticated;

grant select on
  v_panel_queue, v_panel_assigned, v_panel_history,
  v_admin_action_needed, v_admin_orders, v_admin_sync, v_admin_stats
to authenticated;
