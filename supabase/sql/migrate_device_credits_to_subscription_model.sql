alter table if exists device_credits
  add column if not exists free_credits integer;

alter table if exists device_credits
  add column if not exists paid_credits integer;

alter table if exists device_credits
  add column if not exists updated_at timestamptz not null default now();

update device_credits
set
  free_credits = coalesce(free_credits, least(coalesce(credits, 100), 100)),
  paid_credits = coalesce(paid_credits, greatest(coalesce(credits, 100) - least(coalesce(credits, 100), 100), 0)),
  updated_at = now()
where free_credits is null or paid_credits is null;

alter table if exists device_credits
  alter column free_credits set not null;

alter table if exists device_credits
  alter column free_credits set default 100;

alter table if exists device_credits
  alter column paid_credits set not null;

alter table if exists device_credits
  alter column paid_credits set default 0;
