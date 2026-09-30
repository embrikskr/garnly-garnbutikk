-- Kortet skal forsvinne fra «Aktive ordrer» med én gang butikken har sendt.
--
-- 023 lot sendte ordrer stå i 24 timer, fordi den nye knappen registrerer kassauttrekket
-- først og kortet ellers ville forsvunnet i samme sekund som butikken trykket. Test med
-- #1005 viste at det var feil medisin: butikken vil ha kortet vekk når pakken er ferdig, og
-- pakkelista skal bare vise det som faktisk gjenstår. Panelet viser i stedet en kort
-- bekreftelse med hvor ordren ble av, og «Tidligere ordrer» har både etikett og sporing.
--
-- Vilkåret er tilbake til det 016 hadde: sendte ordrer står bare så lenge kassauttrekket
-- ikke er bekreftet. Det gjelder ordrer som er sendt på annen måte enn fra panelet.

drop view if exists v_panel_assigned;
create view v_panel_assigned as
select
  g.id                        as group_id,
  g.assigned_store_id         as store_id,
  g.status                    as group_status,
  g.line_items,
  g.assigned_at,
  g.tracking_number,
  g.tracking_url,
  g.fulfilled_at,
  g.pos_deducted_at,
  g.transferred_at,
  g.carrier,
  g.shipped_at,
  g.ship_step,
  g.ship_error,
  g.service_partner,
  ro.is_test,
  ro.shopify_order_name       as order_name,
  ro.customer ->> 'name'      as ship_name,
  ro.customer ->> 'address1'  as ship_address1,
  ro.customer ->> 'address2'  as ship_address2,
  ro.customer ->> 'zip'       as ship_zip,
  ro.customer ->> 'city'      as ship_city,
  ro.customer ->> 'country'   as ship_country
from routing_groups g
join routing_orders ro on ro.id = g.routing_order_id
where g.assigned_store_id in (select current_store_ids())
  and (
    g.status = 'assigned'                                      -- skal pakkes
    or (g.status = 'fulfilled' and g.pos_deducted_at is null)   -- sendt utenfor panelet, venter på kassa
  );

grant select on v_panel_assigned to authenticated;
