-- Slow AI request log for the service monitor (Telegram alert). Only requests
-- slower than the threshold are inserted, and no wallet or text is stored.
create table if not exists public.ai_slow_requests (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('correct')),
  duration_ms integer not null check (duration_ms >= 0),
  outcome text not null check (outcome in ('ok', 'error')),
  created_at timestamptz not null default now()
);
create index if not exists ai_slow_requests_created_at_idx
  on public.ai_slow_requests (created_at);

alter table public.ai_slow_requests enable row level security;
revoke all on table public.ai_slow_requests from public, anon, authenticated;
grant select, insert, delete on table public.ai_slow_requests to service_role;
grant usage on sequence public.ai_slow_requests_id_seq to service_role;
