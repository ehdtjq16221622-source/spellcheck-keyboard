-- Credit packs (one-time consumable purchases): com.kingboard.app.credits_7000 / credits_18000.
-- Owner decisions 2026-11-11:
--   * Sandbox (App Review, TestFlight) purchases are granted too, marked as Sandbox, at most
--     3 per wallet per 30 days, so a review purchase works but testers cannot farm credits.
--   * A wallet merged into another (credit_wallet_aliases) is followed to the wallet in use,
--     for grants, refunds and refund reversals alike.
-- Pack credits are paid credits: they never expire and are spent after free and subscription credits.
-- Only the credit_pack_purchase Edge Function (after verifying Apple's signed transaction, Apple's
-- current server record and the wallet's appAccountToken) and apple_notifications call these.

create table if not exists public.credit_pack_account_tokens (
  wallet_id text primary key references public.device_credits(device_id) on delete restrict,
  account_token uuid not null unique default gen_random_uuid(),
  created_at timestamptz not null default now()
);

create table if not exists public.credit_pack_purchases (
  transaction_id text primary key check (transaction_id ~ '^[0-9]{1,128}$'),
  original_transaction_id text not null check (original_transaction_id ~ '^[0-9]{1,128}$'),
  product_id text not null,
  environment text not null check (environment in ('Production', 'Sandbox')),
  wallet_id text not null references public.device_credits(device_id) on delete restrict,
  requested_wallet_id text not null,
  credits integer not null check (credits > 0),
  created_at timestamptz not null default now()
);
create index if not exists credit_pack_purchases_wallet_env_idx
  on public.credit_pack_purchases (wallet_id, environment, created_at);

-- A refund can arrive before the app ever claimed the purchase: wallet_id is then null and the
-- row blocks any later grant of that transaction.
create table if not exists public.credit_pack_refunds (
  transaction_id text primary key check (transaction_id ~ '^[0-9]{1,128}$'),
  product_id text not null,
  environment text not null check (environment in ('Production', 'Sandbox')),
  wallet_id text references public.device_credits(device_id) on delete restrict,
  recovered integer not null default 0 check (recovered >= 0),
  shortfall integer not null default 0 check (shortfall >= 0),
  notification_id text,
  created_at timestamptz not null default now()
);

create table if not exists public.credit_pack_refund_reversals (
  transaction_id text primary key references public.credit_pack_refunds(transaction_id) on delete restrict,
  product_id text not null,
  wallet_id text references public.device_credits(device_id) on delete restrict,
  restored integer not null check (restored >= 0),
  notification_id text,
  created_at timestamptz not null default now()
);

alter table public.credit_pack_account_tokens enable row level security;
alter table public.credit_pack_purchases enable row level security;
alter table public.credit_pack_refunds enable row level security;
alter table public.credit_pack_refund_reversals enable row level security;
revoke all on public.credit_pack_account_tokens, public.credit_pack_purchases,
  public.credit_pack_refunds, public.credit_pack_refund_reversals from public, anon, authenticated;
-- New sb_secret_ service keys need explicit table grants (no implicit service_role bypass of GRANT).
grant select, insert on public.credit_pack_account_tokens to service_role;
grant select on public.credit_pack_purchases, public.credit_pack_refunds,
  public.credit_pack_refund_reversals to service_role;

create or replace function public.credit_pack_amount(p_product_id text)
returns integer language sql immutable set search_path = '' as $$
  select case p_product_id
    when 'com.kingboard.app.credits_7000' then 7000
    when 'com.kingboard.app.credits_18000' then 18000
    else null end
$$;

-- Follows merged wallets to the one in use. Aliases never chain today (checked 2026-11-11), but
-- up to 5 hops are followed; a loop or a longer chain is an error rather than a guess.
create or replace function public.credit_pack_canonical_wallet(p_wallet_id text)
returns text language plpgsql stable set search_path = '' as $$
declare
  v_wallet text := p_wallet_id;
  v_next text;
begin
  for i in 1..6 loop
    select a.canonical_wallet_id into v_next from public.credit_wallet_aliases a
      where a.source_wallet_id = v_wallet;
    if v_next is null then return v_wallet; end if;
    v_wallet := v_next;
    v_next := null;
  end loop;
  raise exception 'wallet_alias_chain_too_long';
end;
$$;

-- Returns the wallet's appAccountToken, creating it once. The app passes this UUID to StoreKit so
-- Apple's signed transaction names the wallet that started the purchase.
create or replace function public.credit_pack_account_token(p_wallet_id text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_wallet text;
  v_token uuid;
begin
  if p_wallet_id is null or length(p_wallet_id) not between 1 and 512 then
    raise exception 'invalid_wallet';
  end if;
  v_wallet := public.credit_pack_canonical_wallet(p_wallet_id);
  if not exists (select 1 from public.device_credits c where c.device_id = v_wallet) then
    raise exception 'wallet_not_found';
  end if;
  insert into public.credit_pack_account_tokens (wallet_id) values (v_wallet)
    on conflict (wallet_id) do nothing;
  select t.account_token into v_token from public.credit_pack_account_tokens t where t.wallet_id = v_wallet;
  return v_token;
end;
$$;

-- result: granted | already_granted | refunded | sandbox_limit
create or replace function public.grant_credit_pack_once(
  p_wallet_id text,
  p_account_token uuid,
  p_transaction_id text,
  p_original_transaction_id text,
  p_product_id text,
  p_environment text
) returns table (result text, credits integer, paid_credits integer)
language plpgsql security definer set search_path = '' as $$
declare
  v_amount integer := public.credit_pack_amount(p_product_id);
  v_wallet text;
  v_token_wallet text;
  v_paid integer;
  v_old public.credit_pack_purchases%rowtype;
  v_sandbox_count integer;
begin
  if v_amount is null then raise exception 'unknown_product'; end if;
  if p_environment not in ('Production', 'Sandbox') then raise exception 'invalid_environment'; end if;
  if p_transaction_id is null or p_transaction_id !~ '^[0-9]{1,128}$'
     or p_original_transaction_id is null or p_original_transaction_id !~ '^[0-9]{1,128}$' then
    raise exception 'invalid_transaction_id';
  end if;
  if p_wallet_id is null or length(p_wallet_id) not between 1 and 512 or p_account_token is null then
    raise exception 'invalid_wallet';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('credit_pack:' || p_transaction_id, 0));

  v_wallet := public.credit_pack_canonical_wallet(p_wallet_id);
  -- The token Apple signed must belong to this wallet (or to a wallet since merged into it).
  select t.wallet_id into v_token_wallet from public.credit_pack_account_tokens t
    where t.account_token = p_account_token;
  if v_token_wallet is null or public.credit_pack_canonical_wallet(v_token_wallet) <> v_wallet then
    raise exception 'account_binding_mismatch';
  end if;

  if exists (select 1 from public.credit_pack_refunds r where r.transaction_id = p_transaction_id)
     and not exists (select 1 from public.credit_pack_refund_reversals v where v.transaction_id = p_transaction_id) then
    return query select 'refunded'::text, 0, null::integer;
    return;
  end if;

  select * into v_old from public.credit_pack_purchases p where p.transaction_id = p_transaction_id;
  if found then
    if public.credit_pack_canonical_wallet(v_old.wallet_id) <> v_wallet or v_old.product_id <> p_product_id then
      raise exception 'transaction_wallet_or_product_mismatch';
    end if;
    select c.paid_credits into v_paid from public.device_credits c where c.device_id = v_wallet;
    return query select 'already_granted'::text, v_old.credits, v_paid;
    return;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wallet:' || v_wallet, 0));
  if p_environment = 'Sandbox' then
    select count(*) into v_sandbox_count from public.credit_pack_purchases p
      where p.wallet_id = v_wallet and p.environment = 'Sandbox' and p.created_at > now() - interval '30 days';
    if v_sandbox_count >= 3 then
      return query select 'sandbox_limit'::text, 0, null::integer;
      return;
    end if;
  end if;

  select c.paid_credits into v_paid from public.device_credits c where c.device_id = v_wallet for update;
  if not found then raise exception 'wallet_not_found'; end if;
  if v_paid > 2147483647 - v_amount then raise exception 'credit_overflow'; end if;

  insert into public.credit_pack_purchases (transaction_id, original_transaction_id, product_id, environment,
    wallet_id, requested_wallet_id, credits)
  values (p_transaction_id, p_original_transaction_id, p_product_id, p_environment, v_wallet, p_wallet_id, v_amount);
  -- The ledger's unique (type, key) is a second guard: a duplicate aborts the whole transaction.
  insert into public.credit_transactions (device_id, transaction_type, idempotency_key, free_delta, paid_delta, metadata)
  values (v_wallet, 'credit_pack_purchase', p_transaction_id, 0, v_amount, pg_catalog.jsonb_build_object(
    'product_id', p_product_id, 'environment', p_environment,
    'original_transaction_id', p_original_transaction_id, 'requested_wallet_id', p_wallet_id));
  update public.device_credits set paid_credits = v_paid + v_amount, updated_at = now() where device_id = v_wallet;
  return query select 'granted'::text, v_amount, v_paid + v_amount;
end;
$$;

-- Apple REFUND for a pack. Takes back up to the pack's credits from paid credits (never below 0,
-- never from free or subscription credits) and records any shortfall. A refund for a purchase that
-- was never claimed is recorded so it can never be granted later.
-- result: recovered | recorded_unclaimed | already_refunded
create or replace function public.refund_credit_pack_once(
  p_transaction_id text,
  p_product_id text,
  p_environment text,
  p_notification_id text default null
) returns table (result text, recovered integer, shortfall integer)
language plpgsql security definer set search_path = '' as $$
declare
  v_amount integer := public.credit_pack_amount(p_product_id);
  v_purchase public.credit_pack_purchases%rowtype;
  v_refund public.credit_pack_refunds%rowtype;
  v_wallet text;
  v_paid integer;
  v_recovered integer;
begin
  if v_amount is null then raise exception 'unknown_product'; end if;
  if p_environment not in ('Production', 'Sandbox') then raise exception 'invalid_environment'; end if;
  if p_transaction_id is null or p_transaction_id !~ '^[0-9]{1,128}$' then raise exception 'invalid_transaction_id'; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('credit_pack:' || p_transaction_id, 0));

  select * into v_refund from public.credit_pack_refunds r where r.transaction_id = p_transaction_id;
  if found then
    -- A second refund after a reversal needs a person: the credits may already be restored and spent.
    if exists (select 1 from public.credit_pack_refund_reversals v where v.transaction_id = p_transaction_id) then
      raise exception 'refund_after_reversal_requires_review';
    end if;
    return query select 'already_refunded'::text, v_refund.recovered, v_refund.shortfall;
    return;
  end if;

  select * into v_purchase from public.credit_pack_purchases p where p.transaction_id = p_transaction_id;
  if not found then
    insert into public.credit_pack_refunds (transaction_id, product_id, environment, notification_id)
      values (p_transaction_id, p_product_id, p_environment, p_notification_id);
    return query select 'recorded_unclaimed'::text, 0, 0;
    return;
  end if;
  if v_purchase.product_id <> p_product_id then raise exception 'transaction_product_mismatch'; end if;

  v_wallet := public.credit_pack_canonical_wallet(v_purchase.wallet_id);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wallet:' || v_wallet, 0));
  select c.paid_credits into v_paid from public.device_credits c where c.device_id = v_wallet for update;
  if not found then raise exception 'wallet_not_found'; end if;
  v_recovered := least(greatest(v_paid, 0), v_purchase.credits);

  insert into public.credit_pack_refunds (transaction_id, product_id, environment, wallet_id, recovered, shortfall, notification_id)
    values (p_transaction_id, p_product_id, p_environment, v_wallet, v_recovered, v_purchase.credits - v_recovered, p_notification_id);
  insert into public.credit_transactions (device_id, transaction_type, idempotency_key, free_delta, paid_delta, metadata)
  values (v_wallet, 'credit_pack_refund', p_transaction_id, 0, -v_recovered, pg_catalog.jsonb_build_object(
    'product_id', p_product_id, 'environment', p_environment, 'shortfall', v_purchase.credits - v_recovered,
    'notification_id', p_notification_id));
  update public.device_credits set paid_credits = v_paid - v_recovered, updated_at = now() where device_id = v_wallet;
  return query select 'recovered'::text, v_recovered, v_purchase.credits - v_recovered;
end;
$$;

-- Apple REFUND_REVERSED for a pack: gives back exactly what the refund took.
-- result: restored | already_restored. Raises refund_not_found_retry when the reversal arrives
-- before the refund, so the webhook fails and Apple redelivers it later.
create or replace function public.reverse_credit_pack_refund_once(
  p_transaction_id text,
  p_product_id text,
  p_environment text,
  p_notification_id text default null
) returns table (result text, restored integer)
language plpgsql security definer set search_path = '' as $$
declare
  v_refund public.credit_pack_refunds%rowtype;
  v_reversal public.credit_pack_refund_reversals%rowtype;
  v_wallet text;
  v_paid integer;
begin
  if public.credit_pack_amount(p_product_id) is null then raise exception 'unknown_product'; end if;
  if p_environment not in ('Production', 'Sandbox') then raise exception 'invalid_environment'; end if;
  if p_transaction_id is null or p_transaction_id !~ '^[0-9]{1,128}$' then raise exception 'invalid_transaction_id'; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('credit_pack:' || p_transaction_id, 0));
  select * into v_refund from public.credit_pack_refunds r where r.transaction_id = p_transaction_id;
  if not found then raise exception 'refund_not_found_retry'; end if;
  if v_refund.product_id <> p_product_id then raise exception 'transaction_product_mismatch'; end if;
  select * into v_reversal from public.credit_pack_refund_reversals v where v.transaction_id = p_transaction_id;
  if found then
    return query select 'already_restored'::text, v_reversal.restored;
    return;
  end if;

  v_wallet := null;
  if v_refund.wallet_id is not null and v_refund.recovered > 0 then
    v_wallet := public.credit_pack_canonical_wallet(v_refund.wallet_id);
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wallet:' || v_wallet, 0));
    select c.paid_credits into v_paid from public.device_credits c where c.device_id = v_wallet for update;
    if not found then raise exception 'wallet_not_found'; end if;
    if v_paid > 2147483647 - v_refund.recovered then raise exception 'credit_overflow'; end if;
    insert into public.credit_transactions (device_id, transaction_type, idempotency_key, free_delta, paid_delta, metadata)
    values (v_wallet, 'credit_pack_refund_reversal', p_transaction_id, 0, v_refund.recovered, pg_catalog.jsonb_build_object(
      'product_id', p_product_id, 'environment', p_environment, 'notification_id', p_notification_id));
    update public.device_credits set paid_credits = v_paid + v_refund.recovered, updated_at = now() where device_id = v_wallet;
  end if;
  insert into public.credit_pack_refund_reversals (transaction_id, product_id, wallet_id, restored, notification_id)
    values (p_transaction_id, p_product_id, coalesce(v_wallet, v_refund.wallet_id), v_refund.recovered, p_notification_id);
  return query select 'restored'::text, v_refund.recovered;
end;
$$;

revoke all on function public.credit_pack_amount(text) from public, anon, authenticated;
revoke all on function public.credit_pack_canonical_wallet(text) from public, anon, authenticated;
revoke all on function public.credit_pack_account_token(text) from public, anon, authenticated;
revoke all on function public.grant_credit_pack_once(text, uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.refund_credit_pack_once(text, text, text, text) from public, anon, authenticated;
revoke all on function public.reverse_credit_pack_refund_once(text, text, text, text) from public, anon, authenticated;
grant execute on function public.credit_pack_amount(text) to service_role;
grant execute on function public.credit_pack_canonical_wallet(text) to service_role;
grant execute on function public.credit_pack_account_token(text) to service_role;
grant execute on function public.grant_credit_pack_once(text, uuid, text, text, text, text) to service_role;
grant execute on function public.refund_credit_pack_once(text, text, text, text) to service_role;
grant execute on function public.reverse_credit_pack_refund_once(text, text, text, text) to service_role;
