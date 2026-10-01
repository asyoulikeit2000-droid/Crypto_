-- Pre-Rally Token Scanner v1
-- Additive migration: no existing engine tables are modified.
create extension if not exists pgcrypto;

create table if not exists engine.scanner_tokens (
  token_id uuid primary key default gen_random_uuid(),
  chain_id text not null,
  contract_address text not null,
  token_name text,
  token_symbol text,
  token_decimals integer,
  logo_url text,
  verification_status text,
  official_links jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  token_created_at timestamptz,
  active boolean not null default true,
  provider_metadata jsonb not null default '{}'::jsonb,
  unique(chain_id, contract_address)
);

create table if not exists engine.scanner_pairs (
  pair_id uuid primary key default gen_random_uuid(),
  token_id uuid not null references engine.scanner_tokens(token_id) on delete cascade,
  chain_id text not null,
  pair_address text not null,
  dex_name text,
  base_token jsonb,
  quote_token jsonb,
  pair_created_at timestamptz,
  first_seen_at timestamptz not null default now(),
  active boolean not null default true,
  primary_pair boolean not null default false,
  provider_metadata jsonb not null default '{}'::jsonb,
  unique(chain_id, pair_address)
);

create index if not exists scanner_pairs_token_idx on engine.scanner_pairs(token_id, primary_pair desc);

create table if not exists engine.scanner_market_snapshots (
  snapshot_id bigint generated always as identity primary key,
  token_id uuid not null references engine.scanner_tokens(token_id) on delete cascade,
  pair_id uuid references engine.scanner_pairs(pair_id) on delete set null,
  observed_at timestamptz not null,
  price_usd numeric,
  liquidity_usd numeric,
  market_cap numeric,
  fdv numeric,
  volume_1h numeric,
  volume_6h numeric,
  volume_24h numeric,
  buys_1h integer,
  sells_1h integer,
  buys_24h integer,
  sells_24h integer,
  buy_volume numeric,
  sell_volume numeric,
  buy_sell_imbalance numeric,
  unique_traders integer,
  price_change_1h numeric,
  price_change_6h numeric,
  price_change_24h numeric,
  token_age_hours numeric,
  pair_age_hours numeric,
  provider_name text not null,
  source_timestamp timestamptz,
  ingestion_timestamp timestamptz not null default now(),
  freshness_status text not null,
  provider_quality text,
  completeness_state numeric,
  unique(token_id, pair_id, observed_at, provider_name)
);
create index if not exists scanner_market_recent_idx on engine.scanner_market_snapshots(token_id, observed_at desc);

create table if not exists engine.scanner_enrichment_snapshots (
  enrichment_id bigint generated always as identity primary key,
  token_id uuid not null references engine.scanner_tokens(token_id) on delete cascade,
  observed_at timestamptz not null default now(),
  holder_count bigint,
  holder_growth numeric,
  top_holder_concentration numeric,
  whale_accumulation numeric,
  smart_money_accumulation numeric,
  large_transfers jsonb,
  active_addresses bigint,
  active_wallet_growth numeric,
  exchange_flows jsonb,
  liquidity_provider_changes jsonb,
  social_mention_velocity numeric,
  social_quality_score numeric,
  github_commit_activity numeric,
  contributor_count integer,
  developer_activity_score numeric,
  ecosystem_activity numeric,
  contract_security_status jsonb,
  liquidity_lock_status jsonb,
  token_unlock_schedule jsonb,
  token_unlock_risk_level text,
  provider_name text not null,
  provider_confidence numeric,
  source_timestamp timestamptz,
  ingestion_timestamp timestamptz not null default now()
);

create table if not exists engine.scanner_evaluations (
  evaluation_id bigint generated always as identity primary key,
  token_id uuid not null references engine.scanner_tokens(token_id) on delete cascade,
  pair_id uuid references engine.scanner_pairs(pair_id) on delete set null,
  evaluated_at timestamptz not null default now(),
  pre_rally_score integer not null check (pre_rally_score between 0 and 100),
  confidence_score integer not null check (confidence_score between 0 and 100),
  data_coverage_score integer not null check (data_coverage_score between 0 and 100),
  classification text not null check (classification in ('high_priority_watch','research_candidate','watchlist_candidate','neutral','avoid','insufficient_data')),
  category_scores jsonb not null default '{}'::jsonb,
  positive_signals jsonb not null default '[]'::jsonb,
  warning_flags jsonb not null default '[]'::jsonb,
  critical_flags jsonb not null default '[]'::jsonb,
  missing_data jsonb not null default '[]'::jsonb,
  freshness_status text not null,
  explanation text,
  diagnostic_explanation jsonb not null default '{}'::jsonb,
  scoring_model_version text not null,
  configuration_version text not null
);
create index if not exists scanner_eval_rank_idx on engine.scanner_evaluations(evaluated_at desc, pre_rally_score desc);
create index if not exists scanner_eval_token_idx on engine.scanner_evaluations(token_id, evaluated_at desc);

create table if not exists engine.scanner_watchlists (
  watchlist_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'Watchlist',
  created_at timestamptz not null default now(),
  unique(user_id, name)
);
create table if not exists engine.scanner_watchlist_tokens (
  watchlist_id uuid not null references engine.scanner_watchlists(watchlist_id) on delete cascade,
  token_id uuid not null references engine.scanner_tokens(token_id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key(watchlist_id, token_id)
);
create table if not exists engine.scanner_alert_preferences (
  preference_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade unique,
  score_threshold integer not null default 70 check(score_threshold between 0 and 100),
  confidence_threshold integer not null default 60 check(confidence_threshold between 0 and 100),
  preferred_chains jsonb not null default '[]'::jsonb,
  minimum_liquidity numeric,
  excluded_risks jsonb not null default '[]'::jsonb,
  cooldown_minutes integer not null default 60,
  notification_preferences jsonb not null default '{"in_app":true}'::jsonb,
  muted_tokens jsonb not null default '[]'::jsonb,
  muted_chains jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
create table if not exists engine.scanner_alert_history (
  alert_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token_id uuid not null references engine.scanner_tokens(token_id) on delete cascade,
  evaluation_id bigint references engine.scanner_evaluations(evaluation_id) on delete set null,
  alert_type text not null,
  dedup_key text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  delivery_status text not null default 'pending',
  unique(user_id, dedup_key)
);

create table if not exists engine.scanner_jobs (
  job_id uuid primary key default gen_random_uuid(),
  job_type text not null,
  idempotency_key text not null unique,
  status text not null,
  started_at timestamptz,
  finished_at timestamptz,
  attempts integer not null default 0,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table engine.scanner_watchlists enable row level security;
alter table engine.scanner_watchlist_tokens enable row level security;
alter table engine.scanner_alert_preferences enable row level security;
alter table engine.scanner_alert_history enable row level security;

drop policy if exists scanner_watchlists_owner_select on engine.scanner_watchlists;
create policy scanner_watchlists_owner_select on engine.scanner_watchlists for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists scanner_watchlists_owner_insert on engine.scanner_watchlists;
create policy scanner_watchlists_owner_insert on engine.scanner_watchlists for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists scanner_watchlists_owner_update on engine.scanner_watchlists;
create policy scanner_watchlists_owner_update on engine.scanner_watchlists for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists scanner_watchlists_owner_delete on engine.scanner_watchlists;
create policy scanner_watchlists_owner_delete on engine.scanner_watchlists for delete to authenticated using ((select auth.uid()) = user_id);

drop policy if exists scanner_watchlist_tokens_owner on engine.scanner_watchlist_tokens;
create policy scanner_watchlist_tokens_owner on engine.scanner_watchlist_tokens for all to authenticated
using (exists (select 1 from engine.scanner_watchlists w where w.watchlist_id=scanner_watchlist_tokens.watchlist_id and w.user_id=(select auth.uid())))
with check (exists (select 1 from engine.scanner_watchlists w where w.watchlist_id=scanner_watchlist_tokens.watchlist_id and w.user_id=(select auth.uid())));

drop policy if exists scanner_alert_preferences_owner on engine.scanner_alert_preferences;
create policy scanner_alert_preferences_owner on engine.scanner_alert_preferences for all to authenticated
using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id);

drop policy if exists scanner_alert_history_owner on engine.scanner_alert_history;
create policy scanner_alert_history_owner on engine.scanner_alert_history for select to authenticated using ((select auth.uid())=user_id);

comment on table engine.scanner_evaluations is 'Append-only pre-rally research score history. Not trading advice or an execution signal.';
