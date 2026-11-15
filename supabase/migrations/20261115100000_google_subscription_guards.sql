-- Android subscriptions: fixes found in the 2026-11-15 pre-launch review. NOT APPLIED YET.
-- Same signature as 20261114110000, so the Edge functions keep calling it the same way.
--
-- 1) Resubscribe after a full expiry. Google issues a brand-new purchase token with no
--    linkedPurchaseToken, so the old rule ("token change requires review") blocked every returning
--    subscriber. A verified active token may now replace the wallet's token when the stored
--    subscription has lapsed (state EXPIRED, or its expiry is in the past).
-- 2) Plan changes must not refill credits for free. Google lets a client change plans with no
--    charge (WITH_TIME_PRORATION, WITHOUT_PRORATION) or re-sign-up a canceled subscription, and
--    each one issues a new token = a new cycle key. While the wallet's paid period is still
--    running, a linked replacement therefore:
--      * never lowers the balance,
--      * tops up to (new plan credits - credits already used in this paid period) only when the
--        new token starts a full new period (expiry at least 27 days away = CHARGE_FULL_PRICE),
--      * otherwise keeps the balance as it is; the new plan's credits arrive at the next renewal.
--    Usage is carried in the grant row (period_used_carry), so repeated changes cannot add up.
-- 3) A linked token that belongs to another wallet is refused (one payment, one wallet).
-- 4) Account hold / pause / expiry report an expiry in the past. The stale check now applies to
--    ACTIVE syncs only, so those states are recorded and the final expiry can clear credits.
-- 5) A non-active record for a token the wallet no longer uses (the old token after a plan
--    change) raises 'not the current Google subscription', which callers ignore quietly.

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
  v_linked_owner text;
  v_current_token text;
  v_current_state text;
  v_current_expiry bigint;
  v_grant_owner text;
  v_free integer;
  v_paid integer;
  v_subscription integer;
  v_applied boolean := false;
  v_replaces_linked boolean := false;
  v_replaces_lapsed boolean := false;
  v_period_running boolean := false;
  v_now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  v_last jsonb;
  v_used integer := 0;
  v_grant integer;
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
  if p_linked_purchase_token is not null then
    select s.device_id into v_linked_owner from public.device_subscriptions s
      where s.purchase_token = p_linked_purchase_token for update;
    if v_linked_owner is not null and v_linked_owner <> p_device_id then
      raise exception 'Google subscription owner transfer requires review';
    end if;
  end if;

  select s.purchase_token, s.subscription_state, s.expiry_time_millis
    into v_current_token, v_current_state, v_current_expiry
    from public.device_subscriptions s where s.device_id = p_device_id for update;
  if v_current_token is not null and v_current_token <> p_purchase_token then
    if p_state <> 'SUBSCRIPTION_STATE_ACTIVE' then
      raise exception 'not the current Google subscription';
    elsif p_linked_purchase_token is not null and v_current_token = p_linked_purchase_token then
      v_replaces_linked := true;
      v_period_running := v_current_state <> 'SUBSCRIPTION_STATE_EXPIRED'
        and v_current_expiry is not null and v_current_expiry > v_now_ms;
    elsif v_current_state = 'SUBSCRIPTION_STATE_EXPIRED' or v_current_expiry is null or v_current_expiry <= v_now_ms then
      v_replaces_lapsed := true;
    else
      raise exception 'Google subscription token change requires review';
    end if;
  end if;
  if p_state = 'SUBSCRIPTION_STATE_ACTIVE' and not v_replaces_linked and not v_replaces_lapsed
     and v_current_expiry is not null and p_expiry_time_millis < v_current_expiry then
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
      select c.subscription_credits into v_subscription from public.device_credits c
        where c.device_id = p_device_id for update;
      if not found then raise exception 'wallet_not_found'; end if;
      v_subscription := coalesce(v_subscription, 0);
      v_grant := p_amount;
      if v_replaces_linked and v_period_running then
        -- Credits already used in the running paid period, from the old token's latest grant.
        select t.metadata into v_last from public.credit_transactions t
          where t.device_id = p_device_id and t.transaction_type = 'subscription_monthly_grant'
            and left(t.idempotency_key, length(v_current_token) + 1) = v_current_token || ':'
          order by t.created_at desc limit 1;
        if v_last is not null and (v_last->>'subscription_credits') ~ '^[0-9]{1,9}$' then
          v_used := greatest(0, (v_last->>'subscription_credits')::integer - v_subscription);
          if (v_last->>'period_used_carry') ~ '^[0-9]{1,9}$' then
            v_used := v_used + (v_last->>'period_used_carry')::integer;
          end if;
          v_used := least(v_used, 1000000);
        end if;
        if p_expiry_time_millis >= v_now_ms + 27 * 86400000::bigint then
          v_grant := greatest(v_subscription, p_amount - v_used);
        else
          v_grant := v_subscription;
        end if;
      end if;
      update public.device_credits set subscription_credits = v_grant, updated_at = now()
        where device_id = p_device_id;
      insert into public.credit_transactions (device_id, transaction_type, idempotency_key, free_delta, paid_delta, metadata)
      values (p_device_id, 'subscription_monthly_grant', p_cycle_key, 0, 0,
        coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('subscription_credits', v_grant,
          'plan_credits', p_amount, 'period_used_carry', v_used, 'subscription_credits_before', v_subscription,
          'resets_at_billing_cycle', true, 'provider', 'google_play',
          'replaced_linked_purchase', v_replaces_linked, 'replaced_lapsed_purchase', v_replaces_lapsed));
      -- A plan change that kept the balance is recorded (so the cycle is settled) but is not a new grant.
      v_applied := not (v_replaces_linked and v_period_running) or v_grant > v_subscription;
    end if;
  end if;

  select c.free_credits, c.paid_credits, c.subscription_credits into v_free, v_paid, v_subscription
    from public.device_credits c where c.device_id = p_device_id;
  return query select v_applied, coalesce(v_free, 0), coalesce(v_paid, 0) + coalesce(v_subscription, 0),
    coalesce(v_free, 0) + coalesce(v_paid, 0) + coalesce(v_subscription, 0);
end;
$$;

revoke all on function public.sync_google_subscription_v2_once(text, text, text, text, text, bigint, text, text, integer, jsonb)
  from public, anon, authenticated;
grant execute on function public.sync_google_subscription_v2_once(text, text, text, text, text, bigint, text, text, integer, jsonb)
  to service_role;
