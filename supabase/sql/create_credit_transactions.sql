-- Idempotency ledger for credit grants.
-- Apply this before deploying reward_ad / sync_subscription functions.

create table if not exists credit_transactions (
  id uuid primary key default gen_random_uuid(),
  device_id text not null,
  transaction_type text not null,
  idempotency_key text not null,
  free_delta integer not null default 0,
  paid_delta integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (transaction_type, idempotency_key)
);

create index if not exists credit_transactions_device_created_idx
  on credit_transactions (device_id, created_at desc);

create index if not exists credit_transactions_type_created_idx
  on credit_transactions (transaction_type, created_at desc);

alter table credit_transactions disable row level security;
