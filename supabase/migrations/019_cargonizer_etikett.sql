-- Fraktetikett som PDF i panelet, for butikker uten etikettskriver.
--
-- Sendingen lages fortsatt i CargonizerConnect. Vi slår den opp på ordrenummeret i
-- avsenders referanse og henter PDF-en. Verifisert mot ekte data 30.09.2026:
--   GET /consignments.xml?text=<ordrenummer>            → sendingen, med <id>
--   GET /consignments/label_pdf?consignment_ids[]=<id>  → PDF, også før overføring
--
-- Avsender-ID-ene er per butikk: en sending må slås opp med ID-en til butikken som laget
-- den. Kolonnen fantes fra 001 (kommentert «Shipmondo sender / Cargonizer avsender»).
update stores set shipping_sender_id = '25848' where slug = 'garnkilden';
update stores set shipping_sender_id = '25849' where slug = 'strikkefryd';

-- Id-en lagres første gang den er funnet, så vi slipper et søk per visning.
alter table routing_groups add column if not exists cargonizer_consignment_id bigint;

comment on column routing_groups.cargonizer_consignment_id is
  'Cargonizer-sendingen for denne gruppen. Slås opp på ordrenummer i avsenders referanse første gang, og lagres. Cargonizers søk treffer delstreng, så oppslaget krever eksakt lik referanse.';
