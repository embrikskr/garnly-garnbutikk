-- Nattlig lageravstemming mot Shopify, kl. 02:20 UTC.
--
-- sync-store skriver bare når den ser en differanse mot sin egen forrige utregning, og ser
-- derfor ikke endringer Shopify gjør selv: fulfillment, retur med restock, manuell retting i
-- admin. Da blir Shopify stående feil uten en eneste feilmelding.
--
-- Ligger før pos-catalog (03:15) og sync-products (03:40), mens butikkene er stengt og
-- kassetallene står stille, så avstemmingen ikke kappes av en pågående synk.
select cron.schedule('reconcile-inventory', '20 2 * * *', $$ select call_edge_function('reconcile-inventory') $$);
