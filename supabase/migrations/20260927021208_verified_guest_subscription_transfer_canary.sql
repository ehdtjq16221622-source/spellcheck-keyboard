-- Canary-only: transfer a proven guest purchase and its remaining credits in
-- the same transaction as the existing verified guest wallet merge.
create table if not exists public.credit_v2_subscription_transfers (
  guest_wallet_id text primary key references public.device_credits(device_id) on delete restrict,
  canonical_wallet_id text not null references public.device_credits(device_id) on delete restrict,
  purchase_token text not null unique,
  request_id text not null unique,
  subscription_credits_moved integer not null,
  created_at timestamptz not null default now()
);

alter table public.credit_v2_subscription_transfers enable row level security;
revoke all on public.credit_v2_subscription_transfers from public, anon, authenticated;

create or replace function public.merge_verified_v2_subscribed_guest_once(
  p_guest_wallet_id text,
  p_guest_secret_hash text,
  p_apple_sub text,
  p_session_token_hash text,
  p_request_id text,
  p_purchase_token text
)
returns table (decision text, canonical_wallet_id text,
               free_credits_remaining integer, paid_credits_remaining integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_destination_id text;
  v_source_subscription integer;
  v_destination_subscription integer;
  v_purchase public.device_subscriptions%rowtype;
  v_previous public.credit_v2_subscription_transfers%rowtype;
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
  select * into v_previous from public.credit_v2_subscription_transfers
    where guest_wallet_id = p_guest_wallet_id for update;
  if found then
    if v_previous.canonical_wallet_id <> v_destination_id
       or v_previous.purchase_token <> p_purchase_token
       or v_previous.request_id <> p_request_id then
      raise exception 'Subscription was transferred by another request';
    end if;
    select * into v_merge from public.merge_verified_v2_guest_wallet_once(
      p_guest_wallet_id, p_guest_secret_hash, p_apple_sub,
      p_session_token_hash, p_request_id);
    return query select 'already_merged'::text, v_destination_id,
      v_merge.free_credits_remaining,
      v_merge.paid_credits_remaining + v_previous.subscription_credits_moved;
    return;
  end if;

  perform 1 from public.wallet_v2_credentials c
    where c.wallet_id = p_guest_wallet_id and c.secret_hash = p_guest_secret_hash
      and c.state = 'active' for update;
  if not found then raise exception 'Guest wallet possession proof failed'; end if;
  perform 1 from public.credit_wallet_sessions s
    where s.token_hash = p_session_token_hash and s.wallet_id = v_destination_id
      and s.apple_sub = p_apple_sub and s.revoked_at is null and s.expires_at > now();
  if not found then raise exception 'Active Apple wallet session required'; end if;
  perform 1 from public.device_credits d
    where d.device_id in (p_guest_wallet_id, v_destination_id)
    order by d.device_id for update;
  select d.subscription_credits into v_source_subscription
    from public.device_credits d where d.device_id = p_guest_wallet_id;
  select d.subscription_credits into v_destination_subscription
    from public.device_credits d where d.device_id = v_destination_id;
  if v_source_subscription is null or v_source_subscription < 0
     or v_destination_subscription is null or v_destination_subscription <> 0 then
    raise exception 'Subscription balance requires review';
  end if;
  if exists (select 1 from public.device_subscriptions
             where device_id = v_destination_id) then
    raise exception 'Apple wallet already has a purchase';
  end if;
  select * into v_purchase from public.device_subscriptions
    where device_id = p_guest_wallet_id and purchase_token = p_purchase_token
    for update;
  if not found or v_purchase.subscription_state <> 'SUBSCRIPTION_STATE_ACTIVE'
     or v_purchase.expiry_time_millis is null
     or v_purchase.expiry_time_millis <= extract(epoch from now()) * 1000 then
    raise exception 'Active guest purchase required';
  end if;

  update public.device_credits set subscription_credits = v_source_subscription,
    updated_at = now() where device_id = v_destination_id;
  update public.device_credits set subscription_credits = 0,
    updated_at = now() where device_id = p_guest_wallet_id;
  update public.device_subscriptions set device_id = v_destination_id,
    updated_at = now() where device_id = p_guest_wallet_id;

  select * into v_merge from public.merge_verified_v2_guest_wallet_once(
    p_guest_wallet_id, p_guest_secret_hash, p_apple_sub,
    p_session_token_hash, p_request_id);
  update public.credit_v2_guest_merge_operations
    set source_before = jsonb_set(source_before, '{subscription}',
      to_jsonb(v_source_subscription))
    where guest_wallet_id = p_guest_wallet_id;
  insert into public.credit_v2_subscription_transfers (
    guest_wallet_id, canonical_wallet_id, purchase_token, request_id,
    subscription_credits_moved
  ) values (
    p_guest_wallet_id, v_destination_id, p_purchase_token, p_request_id,
    v_source_subscription
  );
  return query select v_merge.decision, v_destination_id,
    v_merge.free_credits_remaining,
    v_merge.paid_credits_remaining + v_source_subscription;
end;
$$;

revoke all on function public.merge_verified_v2_subscribed_guest_once(text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.merge_verified_v2_subscribed_guest_once(text, text, text, text, text, text)
  to service_role;
