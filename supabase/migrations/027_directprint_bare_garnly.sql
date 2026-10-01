-- Etikettskriveren er Garnlys oppsett, ikke butikkens.
--
-- Valget lå i butikkpanelets innstillinger. Det var feil sted: butikkene skal ikke forholde
-- seg til DirectPrint i det hele tatt. Skriveren settes av Garnly – i admin-visningen, med
-- lista fra Cargonizer /printers – og butikken merker bare forskjellen på om etiketten
-- skrives ut av seg selv eller må hentes med ikonet.
--
-- Kolonnen får navnet DirectPrint faktisk har, så det er tydelig hva det er.
alter table stores rename column label_printer_id to directprint_printer_id;

-- Navnet ble bare brukt til å vise valget i panelinnstillingene, og den siden finnes ikke
-- lenger. En kolonne ingenting skriver til blir lest som sannhet av noen senere.
alter table stores drop column if exists label_printer_name;

comment on column stores.directprint_printer_id is
  'DirectPrint-skriver etiketten sendes til ved «Slått ut og klar til sending». Settes bare av '
  'Garnly (admin), aldri av butikken. Null = butikken henter etiketten som PDF fra ikonet på kortet.';
