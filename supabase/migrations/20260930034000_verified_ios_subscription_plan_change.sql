-- Keep the existing atomic sync and allow a plan change only after the Edge
-- function has confirmed the new product against Apple's current status.
create or replace function public.sync_ios_subscription_once(
  p_device_id text,
  p_product_id text,
  p_purchase_token text,
  p_state text,
  p_expiry_time_millis bigint,
  p_order_id text,
  p_cycle_key text,
  p_amount integer,
  p_metadata jsonb default '{}'::jsonb
)
returns table (
  applied boolean,
  free_credits_remaining integer,
  paid_credits_remaining integer,
  credits_remaining integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner text;
  v_current_token text;
  v_current_product text;
  v_current_expiry bigint;
  v_grant_owner text;
  v_free integer;
  v_paid integer;
  v_subscription integer;
  v_applied boolean := false;
begin
  if nullif(trim(p_device_id), '') is null or length(p_device_id) > 512
    or nullif(trim(p_product_id), '') is null or length(p_product_id) > 256
    or nullif(trim(p_purchase_token), '') is null or length(p_purchase_token) > 512
    or nullif(trim(p_state), '') is null or length(p_state) > 128
    or p_amount is null or p_amount < 0 or p_amount > 100000 then
    raise exception 'invalid subscription input';
  end if;
  if p_state = 'SUBSCRIPTION_STATE_ACTIVE'
    and (nullif(trim(p_cycle_key), '') is null or length(p_cycle_key) > 512) then
    raise exception 'active subscription requires a cycle key';
  end if;
  if p_state = 'SUBSCRIPTION_STATE_ACTIVE' and p_expiry_time_millis is null then
    raise exception 'active subscription requires an expiry';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('ios-token:' || p_purchase_token, 0));
  perform pg_advisory_xact_lock(hashtextextended('wallet:' || p_device_id, 0));

  select device_id into v_owner
    from public.device_subscriptions
    where purchase_token = p_purchase_token for update;
  if v_owner is not null and v_owner <> p_device_id then
    raise exception 'subscription owner transfer requires review';
  end if;
  select purchase_token, product_id, expiry_time_millis
    into v_current_token, v_current_product, v_current_expiry
    from public.device_subscriptions
    where device_id = p_device_id for update;
  if v_current_token is not null and v_current_token <> p_purchase_token then
    raise exception 'subscription token change requires review';
  end if;
  if v_current_product is not null and v_current_product <> p_product_id
    and (p_state <> 'SUBSCRIPTION_STATE_ACTIVE'
      or p_metadata->>'apple_current_product_verified' is distinct from 'true') then
    raise exception 'subscription plan change requires Apple current-status verification';
  end if;
  if v_current_expiry is not null and
    (p_expiry_time_millis is null or p_expiry_time_millis < v_current_expiry) then
    raise exception 'stale subscription transaction';
  end if;

  insert into public.device_subscriptions (
    device_id, product_id, purchase_token, subscription_state,
    expiry_time_millis, latest_order_id, last_cycle_key,
    last_verified_at, updated_at
  ) values (
    p_device_id, p_product_id, p_purchase_token, p_state,
    p_expiry_time_millis, p_order_id, p_cycle_key, now(), now()
  ) on conflict (device_id) do update set
    product_id = excluded.product_id,
    subscription_state = excluded.subscription_state,
    expiry_time_millis = excluded.expiry_time_millis,
    latest_order_id = excluded.latest_order_id,
    last_cycle_key = excluded.last_cycle_key,
    last_verified_at = now(), updated_at = now();

  if p_state = 'SUBSCRIPTION_STATE_ACTIVE' then
    select device_id into v_grant_owner
      from public.credit_transactions
      where transaction_type = 'subscription_monthly_grant'
        and idempotency_key = p_cycle_key for update;
    if v_grant_owner is not null and v_grant_owner <> p_device_id and not exists (
      select 1 from public.credit_wallet_aliases a
        where a.source_wallet_id = v_grant_owner
          and a.canonical_wallet_id = p_device_id
    ) then
      raise exception 'subscription cycle belongs to another wallet';
    end if;

    if v_grant_owner is null then
      insert into public.device_credits (
        device_id, free_credits, paid_credits, subscription_credits, last_reset_date
      ) values (p_device_id, 0, 0, 0, current_date)
      on conflict (device_id) do nothing;
      update public.device_credits
        set subscription_credits = p_amount, updated_at = now()
        where device_id = p_device_id;
      insert into public.credit_transactions (
        device_id, transaction_type, idempotency_key,
        free_delta, paid_delta, metadata
      ) values (
        p_device_id, 'subscription_monthly_grant', p_cycle_key,
        0, 0, coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object(
          'subscription_credits', p_amount,
          'resets_at_billing_cycle', true
        )
      );
      v_applied := true;
    end if;
  end if;

  select c.free_credits, c.paid_credits, c.subscription_credits
    into v_free, v_paid, v_subscription
    from public.device_credits c where c.device_id = p_device_id;
  return query select v_applied, coalesce(v_free, 0),
    coalesce(v_paid, 0) + coalesce(v_subscription, 0),
    coalesce(v_free, 0) + coalesce(v_paid, 0) + coalesce(v_subscription, 0);
end;
$$;

revoke all on function public.sync_ios_subscription_once(text, text, text, text, bigint, text, text, integer, jsonb)
  from public, anon, authenticated;
grant execute on function public.sync_ios_subscription_once(text, text, text, text, bigint, text, text, integer, jsonb)
  to service_role;
