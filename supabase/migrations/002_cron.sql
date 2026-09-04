-- Tidsplanlagte jobber via pg_cron + pg_net.
-- Krever to Vault-hemmeligheter (gjøres én gang, se README). ALTER DATABASE ... SET er ikke
-- tillatt for postgres-rollen på Supabase, derfor Vault:
--   select vault.create_secret('https://<ref>.supabase.co/functions/v1', 'functions_url');
--   select vault.create_secret('<samme verdi som CRON_SECRET i function secrets>', 'cron_secret');

create or replace function call_edge_function(p_name text, p_body jsonb default '{}'::jsonb)
returns bigint language plpgsql as $$
declare
  v_url    text;
  v_secret text;
begin
  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'functions_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'cron_secret';
  if v_url is null or v_secret is null then
    raise exception 'Vault-hemmelighetene functions_url / cron_secret er ikke satt';
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
