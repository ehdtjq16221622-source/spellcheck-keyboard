-- Android: Google sign-in wallets and Google Play credit packs. NOT APPLIED YET (needs owner approval).
--
-- 1) Google accounts reuse the Apple wallet columns as a provider-neutral "account subject":
--      device_credits.apple_user_id / credit_wallet_sessions.apple_sub = 'google:' || <Google sub>
--    Every existing check (session owner = wallet owner, aliases, merges) keeps working unchanged.
--    Guards so the two namespaces can never collide:
--      * no wallet ID may start with 'google:' (legacy wallets used client-chosen IDs; checked
--        2026-11-14: 0 rows match), and
--      * a 'google:' subject may only own a V2 wallet.
--    NOT VALID + VALIDATE keeps the lock short; the scan is ~25k rows.
--
-- 2) Google Play packs use the same products and amounts as Apple (credit_pack_amount) and the same
--    account tokens (credit_pack_account_tokens, passed to Play Billing as obfuscatedAccountId).
--    Play order IDs ('GPA.…') do not fit the Apple tables' numeric transaction IDs, so they get their
--    own purchase/refund tables. The ledger reuses credit_pack_purchase / credit_pack_refund with the
--    key 'gp:' || order_id, which cannot collide with Apple's numeric keys.
--    Google has no refund reversal, so there is no reversal table.
--    The Sandbox limit (3 per wallet per 30 days) counts Apple and Google test purchases together.

alter table public.device_credits
  add constraint device_credits_no_google_wallet_id
  check (device_id not like 'google:%') not valid;
alter table public.device_credits validate constraint device_credits_no_google_wallet_id;

alter table public.device_credits
  add constraint device_credits_google_subject_v2_only
  check (apple_user_id is null or apple_user_id not like 'google:%' or device_id like 'v2:%') not valid;
alter table public.device_credits validate constraint device_credits_google_subject_v2_only;

create table if not exists public.credit_pack_google_purchases (
  order_id text primary key check (order_id ~ '^GPA\.[0-9A-Za-z.-]{1,124}$'),
  purchase_token_hash text not null unique check (purchase_token_hash ~ '^[0-9a-f]{64}$'),
  product_id text not null,
  environment text not null check (environment in ('Production', 'Sandbox')),
  wallet_id text not null references public.device_credits(device_id) on delete restrict,
  requested_wallet_id text not null,
  credits integer not null check (credits > 0),
  created_at timestamptz not null default now()
);
create index if not exists credit_pack_google_purchases_wallet_env_idx
  on public.credit_pack_google_purchases (wallet_id, environment, created_at);

-- A void can arrive before the purchase was ever claimed: wallet_id is then null and the row blocks
-- any later grant of that order.
create table if not exists public.credit_pack_google_refunds (
  order_id text primary key check (order_id ~ '^GPA\.[0-9A-Za-z.-]{1,124}$'),
  purchase_token_hash text check (purchase_token_hash ~ '^[0-9a-f]{64}$'),
  product_id text not null,
  environment text not null check (environment in ('Production', 'Sandbox')),
  wallet_id text references public.device_credits(device_id) on delete restrict,
  recovered integer not null default 0 check (recovered >= 0),
  shortfall integer not null default 0 check (shortfall >= 0),
  notification_id text,
  created_at timestamptz not null default now()
);

alter table public.credit_pack_google_purchases enable row level security;
alter table public.credit_pack_google_refunds enable row level security;
revoke all on public.credit_pack_google_purchases, public.credit_pack_google_refunds
  from public, anon, authenticated;
grant select on public.credit_pack_google_purchases, public.credit_pack_google_refunds to service_role;

-- result: granted | already_granted | refunded | sandbox_limit
create or replace function public.grant_google_credit_pack_once(
  p_wallet_id text,
  p_account_token uuid,
  p_order_id text,
  p_purchase_token_hash text,
  p_product_id text,
  p_environment text
) returns table (result text, credits integer, paid_credits integer)
language plpgsql security definer set search_path = '' as $$
declare
  v_amount integer := public.credit_pack_amount(p_product_id);
  v_wallet text;
  v_token_wallet text;
  v_paid integer;
  v_old public.credit_pack_google_purchases%rowtype;
  v_sandbox_count integer;
begin
  if v_amount is null then raise exception 'unknown_product'; end if;
  if p_environment not in ('Production', 'Sandbox') then raise exception 'invalid_environment'; end if;
  if p_order_id is null or p_order_id !~ '^GPA\.[0-9A-Za-z.-]{1,124}$'
     or p_purchase_token_hash is null or p_purchase_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_transaction_id';
  end if;
  if p_wallet_id is null or length(p_wallet_id) not between 1 and 512 or p_account_token is null then
    raise exception 'invalid_wallet';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('credit_pack:gp:' || p_order_id, 0));

  v_wallet := public.credit_pack_canonical_wallet(p_wallet_id);
  select t.wallet_id into v_token_wallet from public.credit_pack_account_tokens t
    where t.account_token = p_account_token;
  if v_token_wallet is null or public.credit_pack_canonical_wallet(v_token_wallet) <> v_wallet then
    raise exception 'account_binding_mismatch';
  end if;

  if exists (select 1 from public.credit_pack_google_refunds r where r.order_id = p_order_id) then
    return query select 'refunded'::text, 0, null::integer;
    return;
  end if;

  select * into v_old from public.credit_pack_google_purchases p where p.order_id = p_order_id;
  if found then
    if public.credit_pack_canonical_wallet(v_old.wallet_id) <> v_wallet or v_old.product_id <> p_product_id
       or v_old.purchase_token_hash <> p_purchase_token_hash then
      raise exception 'transaction_wallet_or_product_mismatch';
    end if;
    select c.paid_credits into v_paid from public.device_credits c where c.device_id = v_wallet;
    return query select 'already_granted'::text, v_old.credits, v_paid;
    return;
  end if;
  -- The same purchase token under another order ID would be a second grant for one payment.
  if exists (select 1 from public.credit_pack_google_purchases p where p.purchase_token_hash = p_purchase_token_hash) then
    raise exception 'transaction_wallet_or_product_mismatch';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wallet:' || v_wallet, 0));
  if p_environment = 'Sandbox' then
    select (select count(*) from public.credit_pack_purchases p
              where p.wallet_id = v_wallet and p.environment = 'Sandbox' and p.created_at > now() - interval '30 days')
         + (select count(*) from public.credit_pack_google_purchases g
              where g.wallet_id = v_wallet and g.environment = 'Sandbox' and g.created_at > now() - interval '30 days')
      into v_sandbox_count;
    if v_sandbox_count >= 3 then
      return query select 'sandbox_limit'::text, 0, null::integer;
      return;
    end if;
  end if;

  select c.paid_credits into v_paid from public.device_credits c where c.device_id = v_wallet for update;
  if not found then raise exception 'wallet_not_found'; end if;
  if v_paid > 2147483647 - v_amount then raise exception 'credit_overflow'; end if;

  insert into public.credit_pack_google_purchases (order_id, purchase_token_hash, product_id, environment,
    wallet_id, requested_wallet_id, credits)
  values (p_order_id, p_purchase_token_hash, p_product_id, p_environment, v_wallet, p_wallet_id, v_amount);
  insert into public.credit_transactions (device_id, transaction_type, idempotency_key, free_delta, paid_delta, metadata)
  values (v_wallet, 'credit_pack_purchase', 'gp:' || p_order_id, 0, v_amount, pg_catalog.jsonb_build_object(
    'store', 'google_play', 'product_id', p_product_id, 'environment', p_environment,
    'requested_wallet_id', p_wallet_id));
  update public.device_credits set paid_credits = v_paid + v_amount, updated_at = now() where device_id = v_wallet;
  return query select 'granted'::text, v_amount, v_paid + v_amount;
end;
$$;

-- Google voided purchase (refund, chargeback, or canceled order) for a pack. Same recovery rule as
-- Apple: up to the pack's credits from paid credits, never below 0, shortfall recorded.
-- result: recovered | recorded_unclaimed | already_refunded
create or replace function public.refund_google_credit_pack_once(
  p_order_id text,
  p_purchase_token_hash text,
  p_product_id text,
  p_environment text,
  p_notification_id text default null
) returns table (result text, recovered integer, shortfall integer)
language plpgsql security definer set search_path = '' as $$
declare
  v_amount integer := public.credit_pack_amount(p_product_id);
  v_purchase public.credit_pack_google_purchases%rowtype;
  v_refund public.credit_pack_google_refunds%rowtype;
  v_wallet text;
  v_paid integer;
  v_recovered integer;
begin
  if v_amount is null then raise exception 'unknown_product'; end if;
  if p_environment not in ('Production', 'Sandbox') then raise exception 'invalid_environment'; end if;
  if p_order_id is null or p_order_id !~ '^GPA\.[0-9A-Za-z.-]{1,124}$' then raise exception 'invalid_transaction_id'; end if;
  if p_purchase_token_hash is not null and p_purchase_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_transaction_id';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('credit_pack:gp:' || p_order_id, 0));

  select * into v_refund from public.credit_pack_google_refunds r where r.order_id = p_order_id;
  if found then
    return query select 'already_refunded'::text, v_refund.recovered, v_refund.shortfall;
    return;
  end if;

  select * into v_purchase from public.credit_pack_google_purchases p where p.order_id = p_order_id;
  if not found then
    insert into public.credit_pack_google_refunds (order_id, purchase_token_hash, product_id, environment, notification_id)
      values (p_order_id, p_purchase_token_hash, p_product_id, p_environment, p_notification_id);
    return query select 'recorded_unclaimed'::text, 0, 0;
    return;
  end if;
  if v_purchase.product_id <> p_product_id then raise exception 'transaction_product_mismatch'; end if;

  v_wallet := public.credit_pack_canonical_wallet(v_purchase.wallet_id);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wallet:' || v_wallet, 0));
  select c.paid_credits into v_paid from public.device_credits c where c.device_id = v_wallet for update;
  if not found then raise exception 'wallet_not_found'; end if;
  v_recovered := least(greatest(v_paid, 0), v_purchase.credits);

  insert into public.credit_pack_google_refunds (order_id, purchase_token_hash, product_id, environment, wallet_id,
    recovered, shortfall, notification_id)
    values (p_order_id, v_purchase.purchase_token_hash, p_product_id, p_environment, v_wallet, v_recovered,
      v_purchase.credits - v_recovered, p_notification_id);
  insert into public.credit_transactions (device_id, transaction_type, idempotency_key, free_delta, paid_delta, metadata)
  values (v_wallet, 'credit_pack_refund', 'gp:' || p_order_id, 0, -v_recovered, pg_catalog.jsonb_build_object(
    'store', 'google_play', 'product_id', p_product_id, 'environment', p_environment,
    'shortfall', v_purchase.credits - v_recovered, 'notification_id', p_notification_id));
  update public.device_credits set paid_credits = v_paid - v_recovered, updated_at = now() where device_id = v_wallet;
  return query select 'recovered'::text, v_recovered, v_purchase.credits - v_recovered;
end;
$$;

-- The wallet an account token was issued to (followed through merges), for server-side grants from
-- Google's real-time notifications (pending purchases completed while the app was closed).
create or replace function public.credit_pack_wallet_for_account_token(p_account_token uuid)
returns text language sql stable security definer set search_path = '' as $$
  select public.credit_pack_canonical_wallet(t.wallet_id)
    from public.credit_pack_account_tokens t where t.account_token = p_account_token
$$;

revoke all on function public.grant_google_credit_pack_once(text, uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.refund_google_credit_pack_once(text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.credit_pack_wallet_for_account_token(uuid) from public, anon, authenticated;
grant execute on function public.grant_google_credit_pack_once(text, uuid, text, text, text, text) to service_role;
grant execute on function public.refund_google_credit_pack_once(text, text, text, text, text) to service_role;
grant execute on function public.credit_pack_wallet_for_account_token(uuid) to service_role;
