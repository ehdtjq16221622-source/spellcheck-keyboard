-- Owner policy 2026-11-06: subscription credits end when the subscription expires.
-- Called by apple_notifications on EXPIRED / GRACE_PERIOD_EXPIRED (final expiry, not billing retry).
-- Leftovers of subscriptions that expired before this date were converted to paid credits
-- (ledger type subscription_credit_conversion) and are never touched here.
create or replace function public.expire_subscription_credits(
  p_original_txn text,
  p_expired_ms bigint,
  p_notification_id text default null
)
returns table (result text, cleared integer)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_device text;
  v_state text;
  v_expiry bigint;
  v_sub integer;
  v_now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  v_key text;
  v_inserted text;
begin
  if nullif(trim(p_original_txn), '') is null or length(p_original_txn) > 512 or p_expired_ms is null then
    return query select 'invalid_input'::text, 0;
    return;
  end if;
  -- Same lock as the iOS sync RPC, so a resubscribe in flight cannot interleave.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ios-token:' || p_original_txn, 0));

  select s.device_id, s.subscription_state, s.expiry_time_millis into v_device, v_state, v_expiry
    from public.device_subscriptions s where s.purchase_token = p_original_txn for update;
  if v_device is null then
    return query select 'no_subscription'::text, 0;
    return;
  end if;
  if v_state <> 'SUBSCRIPTION_STATE_EXPIRED' or v_expiry is null or v_expiry > v_now_ms then
    return query select 'not_expired'::text, 0;
    return;
  end if;
  -- A late notification for an older cycle must not clear a newer (resubscribed) cycle.
  if v_expiry <> p_expired_ms then
    return query select 'cycle_mismatch'::text, 0;
    return;
  end if;
  if exists (
    select 1 from public.credit_transactions t
    where t.transaction_type = 'subscription_monthly_grant'
      and t.idempotency_key like p_original_txn || ':%'
      and split_part(t.idempotency_key, ':', 3) ~ '^[0-9]+$'
      and split_part(t.idempotency_key, ':', 3)::bigint > p_expired_ms
  ) then
    return query select 'renewed'::text, 0;
    return;
  end if;
  if exists (select 1 from public.credit_wallet_aliases a where a.source_wallet_id = v_device) then
    return query select 'alias_wallet'::text, 0;
    return;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wallet:' || v_device, 0));
  select c.subscription_credits into v_sub from public.device_credits c where c.device_id = v_device for update;
  if v_sub is null then
    return query select 'no_wallet'::text, 0;
    return;
  end if;
  if v_sub <= 0 then
    return query select 'nothing_to_clear'::text, 0;
    return;
  end if;

  v_key := p_original_txn || ':' || p_expired_ms::text;
  insert into public.credit_transactions (device_id, transaction_type, idempotency_key, free_delta, paid_delta, metadata)
  values (v_device, 'subscription_expiry_clear', v_key, 0, 0, jsonb_build_object(
    'subscription_delta', -v_sub,
    'subscription_credits_before', v_sub,
    'subscription_credits_after', 0,
    'originalTransactionId', p_original_txn,
    'expired_cycle', p_expired_ms,
    'notification_id', p_notification_id))
  on conflict (transaction_type, idempotency_key) do nothing
  returning id::text into v_inserted;
  if v_inserted is null then
    return query select 'already_cleared'::text, 0;
    return;
  end if;

  update public.device_credits set subscription_credits = 0, updated_at = now() where device_id = v_device;
  return query select 'cleared'::text, v_sub;
end;
$function$;

revoke all on function public.expire_subscription_credits(text, bigint, text) from public, anon, authenticated;
grant execute on function public.expire_subscription_credits(text, bigint, text) to service_role;
