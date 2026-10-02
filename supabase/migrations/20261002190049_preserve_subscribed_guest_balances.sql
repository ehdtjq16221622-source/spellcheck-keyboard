-- Isolated canary RPC: preserve both subscription balances without changing
-- the existing transfer RPC or its purchase-token uniqueness behavior.
create table if not exists public.credit_v2_subscription_transfer_grants (
  guest_wallet_id text primary key,
  canonical_wallet_id text not null,
  purchase_token text not null,
  request_id text not null,
  subscription_credits_moved integer not null check (subscription_credits_moved >= 0),
  source_grant_key text not null unique,
  created_at timestamptz not null default now()
);
alter table public.credit_v2_subscription_transfer_grants enable row level security;
revoke all on table public.credit_v2_subscription_transfer_grants from public, anon, authenticated;
grant select, insert, update, delete on table public.credit_v2_subscription_transfer_grants to service_role;

create or replace function public.merge_verified_v2_subscribed_guest_preserving_once(
  p_guest_wallet_id text, p_guest_secret_hash text, p_apple_sub text,
  p_session_token_hash text, p_request_id text, p_purchase_token text
)
returns table (decision text, canonical_wallet_id text,
               free_credits_remaining integer, paid_credits_remaining integer)
language plpgsql security definer set search_path = '' as $$
declare
  v_destination_id text;
  v_source_subscription integer;
  v_destination public.device_credits%rowtype;
  v_source_purchase public.device_subscriptions%rowtype;
  v_destination_purchase public.device_subscriptions%rowtype;
  v_previous public.credit_v2_subscription_transfer_grants%rowtype;
  v_grant public.credit_transactions%rowtype;
  v_destination_evidence bigint;
  v_merge record;
begin
  if p_guest_wallet_id is null or p_guest_wallet_id !~ '^v2:[0-9a-f-]{36}$'
     or p_guest_secret_hash is null or p_guest_secret_hash !~ '^[0-9a-f]{64}$'
     or p_session_token_hash is null or p_session_token_hash !~ '^[0-9a-f]{64}$'
     or p_apple_sub is null or p_apple_sub <> btrim(p_apple_sub)
     or length(p_apple_sub) = 0 or length(p_apple_sub) > 512
     or p_request_id is null or p_request_id <> btrim(p_request_id)
     or length(p_request_id) = 0 or length(p_request_id) > 128
     or p_purchase_token is null or length(btrim(p_purchase_token)) = 0
     or length(p_purchase_token) > 512 then
    raise exception 'Invalid subscription transfer proof';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_apple_sub, 74891));
  perform pg_advisory_xact_lock(hashtextextended('ios-token:' || p_purchase_token, 0));
  select d.device_id into v_destination_id from public.device_credits d
    where d.apple_user_id = p_apple_sub;
  if not found or v_destination_id = p_guest_wallet_id then
    raise exception 'Existing Apple wallet required';
  end if;
  perform 1 from public.wallet_v2_credentials c
    where c.wallet_id = p_guest_wallet_id and c.secret_hash = p_guest_secret_hash
      and c.state in ('active', 'linked') for update;
  if not found then raise exception 'Guest wallet possession proof failed'; end if;
  perform 1 from public.credit_wallet_sessions s
    where s.token_hash = p_session_token_hash and s.wallet_id = v_destination_id
      and s.apple_sub = p_apple_sub and s.revoked_at is null and s.expires_at > now();
  if not found then raise exception 'Active Apple wallet session required'; end if;
  perform 1 from public.credit_protected_wallets where wallet_id = v_destination_id;
  if not found then raise exception 'Apple wallet session must be activated'; end if;
  perform 1 from public.device_credits d
    where d.device_id in (p_guest_wallet_id, v_destination_id)
    order by d.device_id for update;
  select * into v_destination from public.device_credits where device_id = v_destination_id;
  select * into v_previous from public.credit_v2_subscription_transfer_grants
    where guest_wallet_id = p_guest_wallet_id for update;
  if found then
    if v_previous.canonical_wallet_id <> v_destination_id
       or v_previous.purchase_token <> p_purchase_token
       or v_previous.request_id <> p_request_id then
      raise exception 'Subscription was transferred by another request';
    end if;
    return query select 'already_merged'::text, v_destination_id,
      v_destination.free_credits,
      v_destination.paid_credits + v_destination.subscription_credits;
    return;
  end if;

  select d.subscription_credits into v_source_subscription
    from public.device_credits d where d.device_id = p_guest_wallet_id;
  if v_source_subscription is null or v_source_subscription < 0
     or v_destination.subscription_credits < 0
     or v_source_subscription::bigint + v_destination.subscription_credits > 2147483647 then
    raise exception 'Subscription balance requires review';
  end if;
  select * into v_destination_purchase from public.device_subscriptions
    where device_id = v_destination_id for update;
  select * into v_source_purchase from public.device_subscriptions
    where device_id = p_guest_wallet_id and purchase_token = p_purchase_token for update;
  if not found or v_source_purchase.expiry_time_millis is null
     or v_source_purchase.expiry_time_millis <= 0 then
    raise exception 'Verified guest purchase required';
  end if;
  if v_destination_purchase.device_id is not null and
     (v_destination_purchase.purchase_token <> p_purchase_token or
      v_destination_purchase.product_id is distinct from v_source_purchase.product_id) then
    raise exception 'Apple wallet already has a different purchase';
  end if;
  select * into v_grant from public.credit_transactions t
    where t.device_id = p_guest_wallet_id and t.transaction_type = 'subscription_monthly_grant'
    order by t.created_at desc, t.id desc limit 1 for update;
  if not found or coalesce(v_grant.idempotency_key, '') = ''
     or v_grant.metadata->>'originalTransactionId' is distinct from p_purchase_token
     or v_grant.metadata->>'productId' is distinct from v_source_purchase.product_id
     or coalesce((v_grant.metadata->>'subscription_credits')::bigint, 0) < v_source_subscription
     or exists (select 1 from public.credit_v2_subscription_transfer_grants t
       where t.source_grant_key = v_grant.idempotency_key) then
    raise exception 'Subscription grant provenance requires review';
  end if;

  select coalesce(sum(amount), 0) into v_destination_evidence from (
    select (t.metadata->>'subscription_credits')::bigint as amount
      from public.credit_transactions t
      where t.device_id = v_destination_id and t.transaction_type = 'subscription_monthly_grant'
    union all
    select t.subscription_credits_moved::bigint from public.credit_v2_subscription_transfers t
      where t.canonical_wallet_id = v_destination_id
    union all
    select t.subscription_credits_moved::bigint from public.credit_v2_subscription_transfer_grants t
      where t.canonical_wallet_id = v_destination_id
  ) evidence;
  if v_destination_evidence < v_destination.subscription_credits then
    raise exception 'Apple subscription ledger requires review';
  end if;

  update public.device_credits
    set subscription_credits = v_destination.subscription_credits + v_source_subscription,
        updated_at = now() where device_id = v_destination_id;
  update public.device_credits set subscription_credits = 0, updated_at = now()
    where device_id = p_guest_wallet_id;
  if v_destination_purchase.device_id is null then
    update public.device_subscriptions set device_id = v_destination_id, updated_at = now()
      where device_id = p_guest_wallet_id;
  else
    delete from public.device_subscriptions where device_id = p_guest_wallet_id;
  end if;
  select * into v_merge from public.merge_verified_v2_guest_wallet_once(
    p_guest_wallet_id, p_guest_secret_hash, p_apple_sub, p_session_token_hash, p_request_id);
  update public.credit_v2_guest_merge_operations
    set source_before = jsonb_set(source_before, '{subscription}', to_jsonb(v_source_subscription)),
        destination_before = jsonb_set(destination_before, '{subscription}',
          to_jsonb(v_destination.subscription_credits))
    where guest_wallet_id = p_guest_wallet_id;
  insert into public.credit_v2_subscription_transfer_grants (
    guest_wallet_id, canonical_wallet_id, purchase_token, request_id,
    subscription_credits_moved, source_grant_key
  ) values (p_guest_wallet_id, v_destination_id, p_purchase_token, p_request_id,
            v_source_subscription, v_grant.idempotency_key);
  return query select v_merge.decision, v_destination_id, v_merge.free_credits_remaining,
    v_merge.paid_credits_remaining + v_destination.subscription_credits + v_source_subscription;
end;
$$;
revoke all on function public.merge_verified_v2_subscribed_guest_preserving_once(text,text,text,text,text,text)
  from public, anon, authenticated;
grant execute on function public.merge_verified_v2_subscribed_guest_preserving_once(text,text,text,text,text,text)
  to service_role;
