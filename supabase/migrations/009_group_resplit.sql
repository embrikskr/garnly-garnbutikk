-- Ny gruppestatus: 'resplit'.
--
-- Når siste butikk avslår en gruppe og ingen enkeltbutikk kan ta hele, planla systemet
-- før dette bare å eskalere til manuell håndtering. Med to butikker skjer det ofte nok
-- til at det ikke er en farbar vei. Nå deles gruppa opp på nytt mot dagens lager.
--
-- Den opprinnelige gruppa blir stående som historikk med status 'resplit', og de nye
-- delgruppene overtar. 'resplit' teller verken som åpen eller som eskalert når
-- ordrestatusen regnes ut.

alter type group_status add value if not exists 'resplit';
