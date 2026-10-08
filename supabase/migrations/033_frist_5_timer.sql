-- Butikkene får 5 timer på å svare på et tilbud, ikke 3 (Embrik 08.10.2026).
--
-- Fristen løper fortsatt bare i åpningstid (business_hours, se routing.ts
-- deadlineWithinBusinessHours). Tilbud som alt er ute, beholder fristen de fikk;
-- de 5 timene gjelder tilbud som lages etter dette.
--
-- Bare butikker som står på den gamle standarden flyttes: en butikk som har fått
-- en egen frist, beholder den.

alter table stores alter column offer_ttl_hours set default 5;

update stores set offer_ttl_hours = 5 where offer_ttl_hours = 3;
