-- Tidsplanlagte jobber via pg_cron + pg_net.
-- Krever at to innstillinger er satt i databasen (gjøres én gang, se README):
--   alter database postgres set app.functions_url = 'https://<ref>.supabase.co/functions/v1';
--   alter database postgres set app.cron_secret   = '<samme verdi som CRON_SECRET i function secrets>';

create or replace function call_edge_function(p_name text, p_body jsonb default '{}'::jsonb)
returns bigint language plpgsql as $$
declare
  v_url    text := current_setting('app.functions_url', true);
  v_secret text := current_setting('app.cron_secret', true);
begin
  if v_url is null or v_secret is null then
    raise exception 'app.functions_url / app.cron_secret er ikke satt';
  end if;
  return net.http_post(
    url     := v_url || '/' || p_name,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
    body    := p_body,
    timeout_milliseconds := 120000
  );
end $$;

-- Synk: hvert 15. minutt kalles sync-store uten store_id; funksjonen velger selv
-- butikkene som er "due" (forskjøvet på id-hash så ikke alle går samtidig).
select cron.schedule('sync-stores', '*/5 * * * *', $$ select call_edge_function('sync-store', '{"mode":"due"}'::jsonb) $$);

-- Timeout-sveip hvert minutt
select cron.schedule('timeout-sweeper', '* * * * *', $$ select call_edge_function('timeout-sweeper') $$);

-- Rydd webhook-idempotens-tabellen ukentlig
select cron.schedule('cleanup-webhook-events', '0 3 * * 0', $$ delete from shopify_webhook_events where received_at < now() - interval '30 days' $$);
