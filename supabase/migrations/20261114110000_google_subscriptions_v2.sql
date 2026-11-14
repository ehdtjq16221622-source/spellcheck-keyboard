-- Android subscriptions on the current plans (com.kingboard.app.monthly_basic / premium / pro / max),
-- same credits and the same cycle rules as iOS. NOT APPLIED YET (needs owner approval).
--
-- Differences from sync_ios_subscription_once, all because of how Google Play works:
--   * An upgrade, downgrade or resubscribe issues a NEW purchase token whose linkedPurchaseToken is the
--     old one. The wallet's row may move to the new token only when Google said it is linked to the
--     token the wallet already has, and the new token is verified active.
--   * Cycle keys are '<purchaseToken>:<productId>:<expiryMillis>' (numeric expiry, like iOS), so the
--     shared expiry check in expire_subscription_credits can tell a renewed cycle from an expired one.
-- The old Android plans (kingboard_monthly_500 / 1000) and sync_google_subscription_once stay as they
-- are for the old app.

create or replace function public.sync_google_subscription_v2_once(
  p_device_id text,
  p_product_id text,
  p_purchase_token text,
  p_linked_purchase_token text,
  p_state text,
  p_expiry_time_millis bigint,
  p_order_id text,
  p_cycle_key text,
  p_amount integer,
  p_metadata jsonb default '{}'::jsonb
) returns table (applied boolean, free_credits_remaining integer, paid_credits_remaining integer, credits_remaining integer)
language plpgsql security definer set search_path = '' as $$
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
  v_replaces_linked boolean := false;
begin
  if nullif(trim(p_device_id), '') is null or length(p_device_id) > 512
    or p_product_id is null or p_product_id !~ '^com\.kingboard\.app\.monthly_(basic|premium|pro|max)$'
    or nullif(trim(p_purchase_token), '') is null or length(p_purchase_token) > 512 or position(':' in p_purchase_token) > 0
    or (p_linked_purchase_token is not null and (length(p_linked_purchase_token) > 512 or p_linked_purchase_token = p_purchase_token))
    or p_state not in ('SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD', 'SUBSCRIPTION_STATE_ON_HOLD',
                       'SUBSCRIPTION_STATE_PAUSED', 'SUBSCRIPTION_STATE_EXPIRED')
    or p_amount is null or p_amount < 0 or p_amount > 100000 then
    raise exception 'invalid Google subscription input';
  end if;
  if p_state = 'SUBSCRIPTION_STATE_ACTIVE' and (p_expiry_time_millis is null
      or p_cycle_key is distinct from (p_purchase_token || ':' || p_product_id || ':' || p_expiry_time_millis::text)
      or p_metadata->>'google_purchase_verified' is distinct from 'true') then
    raise exception 'active Google subscription requires a verified cycle';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('google-token:' || p_purchase_token, 0));
  if p_linked_purchase_token is not null then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('google-token:' || p_linked_purchase_token, 0));
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wallet:' || p_device_id, 0));

  select s.device_id into v_owner from public.device_subscriptions s
    where s.purchase_token = p_purchase_token for update;
  if v_owner is not null and v_owner <> p_device_id then
    raise exception 'Google subscription owner transfer requires review';
  end if;

  select s.purchase_token, s.product_id, s.expiry_time_millis
    into v_current_token, v_current_product, v_current_expiry
    from public.device_subscriptions s where s.device_id = p_device_id for update;
  if v_current_token is not null and v_current_token <> p_purchase_token then
    if p_linked_purchase_token is null or v_current_token <> p_linked_purchase_token
       or p_state <> 'SUBSCRIPTION_STATE_ACTIVE' then
      raise exception 'Google subscription token change requires review';
    end if;
    v_replaces_linked := true;
  end if;
  if not v_replaces_linked and v_current_expiry is not null and
     (p_expiry_time_millis is null or p_expiry_time_millis < v_current_expiry) then
    raise exception 'stale Google subscription transaction';
  end if;

  insert into public.device_subscriptions (device_id, product_id, purchase_token, subscription_state,
    expiry_time_millis, latest_order_id, last_cycle_key, last_verified_at, updated_at)
  values (p_device_id, p_product_id, p_purchase_token, p_state, p_expiry_time_millis, p_order_id,
    case when p_state = 'SUBSCRIPTION_STATE_ACTIVE' then p_cycle_key else null end, now(), now())
  on conflict (device_id) do update set
    purchase_token = excluded.purchase_token,
    product_id = excluded.product_id,
    subscription_state = excluded.subscription_state,
    expiry_time_millis = excluded.expiry_time_millis,
    latest_order_id = excluded.latest_order_id,
    last_cycle_key = coalesce(excluded.last_cycle_key, public.device_subscriptions.last_cycle_key),
    last_verified_at = now(), updated_at = now();

  if p_state = 'SUBSCRIPTION_STATE_ACTIVE' then
    select t.device_id into v_grant_owner from public.credit_transactions t
      where t.transaction_type = 'subscription_monthly_grant' and t.idempotency_key = p_cycle_key for update;
    if v_grant_owner is not null and v_grant_owner <> p_device_id and not exists (
      select 1 from public.credit_wallet_aliases a
        where a.source_wallet_id = v_grant_owner and a.canonical_wallet_id = p_device_id) then
      raise exception 'subscription cycle belongs to another wallet';
    end if;
    if v_grant_owner is null then
      update public.device_credits set subscription_credits = p_amount, updated_at = now()
        where device_id = p_device_id;
      if not found then raise exception 'wallet_not_found'; end if;
      insert into public.credit_transactions (device_id, transaction_type, idempotency_key, free_delta, paid_delta, metadata)
      values (p_device_id, 'subscription_monthly_grant', p_cycle_key, 0, 0,
        coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('subscription_credits', p_amount,
          'resets_at_billing_cycle', true, 'provider', 'google_play',
          'replaced_linked_purchase', v_replaces_linked));
      v_applied := true;
    end if;
  end if;

  select c.free_credits, c.paid_credits, c.subscription_credits into v_free, v_paid, v_subscription
    from public.device_credits c where c.device_id = p_device_id;
  return query select v_applied, coalesce(v_free, 0), coalesce(v_paid, 0) + coalesce(v_subscription, 0),
    coalesce(v_free, 0) + coalesce(v_paid, 0) + coalesce(v_subscription, 0);
end;
$$;

-- Final expiry of a Google subscription: same policy as Apple (subscription credits end), under the
-- Google token lock so a renewal sync in flight cannot interleave.
create or replace function public.expire_google_subscription_credits(
  p_purchase_token text,
  p_expired_ms bigint,
  p_notification_id text default null
) returns table (result text, cleared integer)
language plpgsql security definer set search_path = '' as $$
begin
  if nullif(trim(p_purchase_token), '') is null or length(p_purchase_token) > 512 then
    return query select 'invalid_input'::text, 0;
    return;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('google-token:' || p_purchase_token, 0));
  return query select * from public.expire_subscription_credits(p_purchase_token, p_expired_ms, p_notification_id);
end;
$$;

revoke all on function public.sync_google_subscription_v2_once(text, text, text, text, text, bigint, text, text, integer, jsonb)
  from public, anon, authenticated;
revoke all on function public.expire_google_subscription_credits(text, bigint, text) from public, anon, authenticated;
grant execute on function public.sync_google_subscription_v2_once(text, text, text, text, text, bigint, text, text, integer, jsonb)
  to service_role;
grant execute on function public.expire_google_subscription_credits(text, bigint, text) to service_role;
