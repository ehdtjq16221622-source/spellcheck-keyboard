-- Revenue ledger for Telegram alerts: the price the store reported, once per transaction and event.
-- Amounts are milliunits of `currency` (Apple's unit); refunds are stored negative.
create table if not exists public.revenue_events (
  id bigserial primary key,
  store text not null check (store in ('app_store', 'google_play')),
  environment text not null check (environment in ('Production', 'Sandbox')),
  category text not null check (category in ('subscription', 'credit_pack', 'lifetime')),
  kind text not null check (kind in ('purchase', 'refund', 'refund_reversal')),
  product_id text not null,
  transaction_id text not null,
  amount_milli bigint not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  occurred_at timestamptz not null,
  source text not null,
  created_at timestamptz not null default now(),
  unique (store, transaction_id, kind)
);

alter table public.revenue_events enable row level security;
revoke all on table public.revenue_events from public, anon, authenticated;
grant select, insert on table public.revenue_events to service_role;
grant usage, select on sequence public.revenue_events_id_seq to service_role;

create index if not exists revenue_events_month_idx
  on public.revenue_events (environment, occurred_at);

-- Records one event (a repeat is ignored) and returns this KST month's Production totals per currency.
create or replace function public.record_revenue_event(
  p_store text, p_environment text, p_category text, p_kind text, p_product_id text,
  p_transaction_id text, p_amount_milli bigint, p_currency text, p_occurred_at timestamptz, p_source text
)
returns table(inserted boolean, month_totals jsonb, since timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inserted boolean;
  v_month_start timestamptz := pg_catalog.date_trunc('month', pg_catalog.now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul';
begin
  if p_amount_milli is null or p_amount_milli < 0 then raise exception 'invalid_amount'; end if;
  insert into public.revenue_events (
    store, environment, category, kind, product_id, transaction_id, amount_milli, currency, occurred_at, source
  ) values (
    p_store, p_environment, p_category, p_kind, p_product_id, p_transaction_id,
    case when p_kind = 'refund' then -p_amount_milli else p_amount_milli end,
    p_currency, p_occurred_at, p_source
  ) on conflict (store, transaction_id, kind) do nothing;
  v_inserted := found;
  return query
    select v_inserted,
      coalesce((select pg_catalog.jsonb_object_agg(t.currency, t.total) from (
        select e.currency, sum(e.amount_milli) as total from public.revenue_events e
        where e.environment = 'Production' and e.occurred_at >= v_month_start
        group by e.currency) t), '{}'::jsonb),
      (select min(e.created_at) from public.revenue_events e);
end;
$$;

revoke execute on function public.record_revenue_event(text, text, text, text, text, text, bigint, text, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.record_revenue_event(text, text, text, text, text, text, bigint, text, timestamptz, text)
  to service_role;
