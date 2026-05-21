-- Fresh schema for credits.

create table if not exists device_credits (
  device_id       text primary key,
  free_credits    integer not null default 100,
  paid_credits    integer not null default 0,
  last_reset_date date not null default current_date,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table device_credits disable row level security;

alter table device_credits alter column free_credits set default 100;
