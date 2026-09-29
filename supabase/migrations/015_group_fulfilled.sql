-- Nye gruppestatuser. MÅ stå alene i sin egen migrasjon: Postgres tillater ikke å bruke en
-- nyopprettet enum-verdi i samme transaksjon som den legges til. Bruken ligger i 016.
--
-- `fulfilled` – gruppen er sendt. Før dette sto en sendt ordre igjen som `assigned`, og
--               panelet viste den i pakkelista for alltid.
-- `archived`  – raden hører til den gamle Shopify-butikken og skal ikke telle med noe sted.

alter type group_status add value if not exists 'fulfilled';
alter type group_status add value if not exists 'archived';
