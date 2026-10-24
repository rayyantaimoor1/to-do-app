-- Schedule the reminder sweep every 5 minutes (PLAN.md §6, M5).
--
-- Run this ONCE in the Supabase SQL editor after deploying the
-- reminder-sweep function. Replace the two placeholders first:
--   <PROJECT_REF>  your project ref (the subdomain of your Supabase URL)
--   <CRON_SECRET>  the same value you set with `supabase secrets set CRON_SECRET=...`
-- Both are stored in Vault, so they never appear in the cron job definition.
-- Do not commit this file with real values filled in.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret('https://<PROJECT_REF>.supabase.co', 'project_url');
select vault.create_secret('<CRON_SECRET>', 'cron_secret');

select cron.schedule(
  'reminder-sweep',
  '*/5 * * * *',
  $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
               || '/functions/v1/reminder-sweep',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' ||
                   (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
               ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);

-- Useful checks:
--   select * from cron.job;
--   select * from cron.job_run_details order by start_time desc limit 10;
--   select * from net._http_response order by created desc limit 10;
-- To remove:  select cron.unschedule('reminder-sweep');
