create table if not exists device_subscriptions (
  device_id            text primary key,
  product_id           text not null,
  purchase_token       text not null,
  subscription_state   text not null,
  expiry_time_millis   bigint,
  latest_order_id      text,
  last_cycle_key       text,
  last_verified_at     timestamptz not null default now(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create unique index if not exists device_subscriptions_purchase_token_idx
  on device_subscriptions (purchase_token);

alter table device_subscriptions disable row level security;
