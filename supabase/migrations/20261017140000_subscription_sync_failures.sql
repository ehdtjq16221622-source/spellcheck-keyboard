-- Every failed or rejected iOS subscription sync, one row per attempt. The Telegram alert is still sent once a day per wallet and failure type; this table keeps all of them so affected wallets can be found.
create table if not exists public.subscription_sync_failures (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  audit_id text,
  environment text,
  stage text,
  failure_code text,
  product text,
  source text,
  wallet_fingerprint text,
  requested_wallet_id text,
  resolved_wallet_id text
);
create index if not exists subscription_sync_failures_created_at_idx on public.subscription_sync_failures (created_at desc);
create index if not exists subscription_sync_failures_wallet_idx on public.subscription_sync_failures (resolved_wallet_id, created_at desc);
alter table public.subscription_sync_failures enable row level security;
revoke all on public.subscription_sync_failures from anon, authenticated;
grant all on public.subscription_sync_failures to service_role;

alter table public.subscription_sync_failures add column if not exists detail jsonb;
