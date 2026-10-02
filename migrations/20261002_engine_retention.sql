-- Storage retention policy for rebuildable high-frequency telemetry.
-- Apply only after Supabase exits disk-full read-only mode.
-- Durable research artifacts (signals, signal_outcomes, paper_trades, model_versions,
-- model_calibrations, backtest_runs, OHLCV) are intentionally preserved.

create schema if not exists internal;

create or replace function internal.enforce_engine_retention()
returns void
language plpgsql
security invoker
set search_path = engine, public, pg_catalog
as $$
begin
  delete from engine.trades
   where observed_at < now() - interval '2 hours';

  delete from engine.orderbook_snapshots
   where observed_at < now() - interval '2 hours';

  delete from engine.feature_values
   where observed_at < now() - interval '24 hours';

  delete from engine.regime_states
   where observed_at < now() - interval '24 hours';

  delete from engine.data_quality
   where checked_at < now() - interval '24 hours';

  delete from engine.market_ticks
   where observed_at < now() - interval '30 hours';

  delete from cron.job_run_details
   where end_time < now() - interval '7 days';
end;
$$;

revoke all on function internal.enforce_engine_retention() from public;
grant execute on function internal.enforce_engine_retention() to postgres;

do $$
declare
  existing_job bigint;
begin
  select jobid into existing_job
  from cron.job
  where jobname = 'crypto-engine-retention'
  limit 1;

  if existing_job is not null then
    perform cron.unschedule(existing_job);
  end if;

  perform cron.schedule(
    'crypto-engine-retention',
    '17 * * * *',
    $cron$select internal.enforce_engine_retention();$cron$
  );
end $$;
