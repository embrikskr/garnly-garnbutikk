-- Duells produktkatalog (strekkoder) friskes opp én gang i døgnet, kl. 03:15.
-- Selve synken hvert 5. minutt leser bare den mellomlagrede katalogen.
select cron.schedule('pos-catalog', '15 3 * * *', $$ select call_edge_function('pos-catalog') $$);
