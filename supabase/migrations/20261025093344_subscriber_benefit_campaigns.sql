-- Public marketing copy only. No claim tokens, recipient IDs, or entitlements.
create table public.subscriber_benefit_campaigns (
  id text primary key check (length(id) between 1 and 80),
  app_name text not null check (length(app_name) between 1 and 80),
  title text not null check (length(title) between 1 and 120),
  body text not null check (length(body) between 1 and 1200),
  app_url text not null check (app_url ~ '^https://apps[.]apple[.]com/'),
  is_active boolean not null default false,
  starts_at timestamptz,
  ends_at timestamptz,
  updated_at timestamptz not null default now(),
  check (ends_at is null or starts_at is null or ends_at>starts_at)
);
alter table public.subscriber_benefit_campaigns enable row level security;
revoke all on public.subscriber_benefit_campaigns from public,anon,authenticated;
grant all on public.subscriber_benefit_campaigns to service_role;
-- Intentionally no campaign rows: the popup remains off until a future app is ready.
