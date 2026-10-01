-- Daglig påminnelse kl. 08 om noe står og venter på Garnly.
--
-- Fyrer på både 06:00 og 07:00 UTC fordi 08:00 i Norge er det ene om sommeren og det andre om
-- vinteren. Funksjonen slipper bare gjennom den kjøringen som faktisk er kl. 08 lokalt; den
-- andre er en no-op. Alternativet – én fast UTC-time – ville sendt e-posten kl. 07 halve året.
select cron.schedule('ops-digest', '0 6,7 * * *', $$ select call_edge_function('ops-digest') $$);
