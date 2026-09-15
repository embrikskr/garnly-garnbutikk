-- Sikkerhetshull: pos_catalog og settlement_adjustments manglet RLS.
--
-- Supabase varslet 13.09.2026 om «Table publicly accessible». Alle de tretten andre
-- tabellene i skjemaet har RLS; disse to ble lagt til senere uten. Anon-nøkkelen er
-- offentlig (den ligger i panel/config.js og serveres fra butikkpanelet), så uten RLS
-- kunne hvem som helst med prosjekt-URL-en lese OG SKRIVE begge.
--
-- Hva som sto åpent:
--   pos_catalog            – 6010 rader med Garnkildens sortiment: strekkoder, varenavn,
--                            leverandører. Skrivbar, så en strekkode kunne pekes mot feil
--                            produkt og lageret ville stille havnet på feil vare.
--   settlement_adjustments – penger. Tom i dag, men skrivbar betyr at noen kunne endret
--                            hva butikkene får utbetalt.
--
-- Ingen policyer trengs: begge tabellene røres bare av Edge Functions via service
-- role-nøkkelen, som går utenom RLS. RLS uten policyer stenger anon helt ute og
-- påvirker ikke synken eller oppgjøret.

alter table pos_catalog enable row level security;
alter table settlement_adjustments enable row level security;

-- Views kjører som eier og omgår RLS på tabellene under. Uten dette ville de to
-- viewene vært en bakdør inn i tabellene vi nettopp stengte.
-- (Panel-viewene i 008 er bevisst det motsatte: de kjører som eier og filtrerer selv
-- på current_store_ids(). Det er en annen og villet løsning, og røres ikke her.)
alter view v_pos_catalog_status set (security_invoker = on);
alter view v_store_settlement  set (security_invoker = on);
