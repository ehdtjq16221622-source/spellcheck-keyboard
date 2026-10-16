-- Renewal credit grant and refund revoke, driven by App Store Server Notifications.
-- Both are idempotent and conservative: wallets that were moved or merged are skipped and
-- left to the app-driven sync, which already knows how to resolve them.

create or replace function public.grant_subscription_credits_on_renewal(
  p_original_txn text,
  p_product_id text,
  p_expires_ms bigint,
  p_amount integer,
  p_notification_id text default null
)
returns table (result text, applied boolean)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_count integer;
  v_device text;
  v_state text;
  v_now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  v_key text;
  v_applied boolean;
begin
  if nullif(trim(p_original_txn), '') is null or nullif(trim(p_product_id), '') is null
     or p_expires_ms is null or p_amount is null or p_amount < 0 or p_amount > 100000 then
    return query select 'invalid_input'::text, false;
    return;
  end if;
  -- A late or replayed notification for a finished cycle must never refill credits.
  if p_expires_ms <= v_now_ms then
    return query select 'cycle_not_current'::text, false;
    return;
  end if;
  if p_expires_ms > v_now_ms + 40::bigint * 86400000 then
    return query select 'cycle_too_far'::text, false;
    return;
  end if;

  select count(*) into v_count from public.device_subscriptions where purchase_token = p_original_txn;
  if v_count = 0 then
    return query select 'no_subscription'::text, false;
    return;
  end if;
  if v_count > 1 then
    return query select 'ambiguous_owner'::text, false;
    return;
  end if;
  select s.device_id, s.subscription_state into v_device, v_state
    from public.device_subscriptions s where s.purchase_token = p_original_txn;

  if v_state <> 'SUBSCRIPTION_STATE_ACTIVE' then
    return query select 'not_active'::text, false;
    return;
  end if;
  if not exists (select 1 from public.device_credits c where c.device_id = v_device) then
    return query select 'no_wallet'::text, false;
    return;
  end if;
  if exists (select 1 from public.credit_wallet_aliases a where a.source_wallet_id = v_device)
     or exists (select 1 from public.credit_device_aliases a where a.device_id = v_device) then
    return query select 'alias_wallet'::text, false;
    return;
  end if;

  v_key := p_original_txn || ':' || p_product_id || ':' || p_expires_ms::text;
  select r.applied into v_applied
    from public.reset_subscription_credits(
      v_device, p_amount, v_key,
      jsonb_build_object(
        'productId', p_product_id,
        'originalTransactionId', p_original_txn,
        'cycleKey', p_expires_ms::text,
        'environment', 'Production',
        'source', 'apple_notification_renewal',
        'notification_id', p_notification_id
      )
    ) r;
  return query select case when v_applied then 'granted' else 'already_granted' end::text, coalesce(v_applied, false);
end;
$function$;

create or replace function public.revoke_subscription_credits_on_refund(
  p_original_txn text,
  p_refunded_expires_ms bigint,
  p_notification_id text
)
returns table (result text, revoked integer)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_count integer;
  v_device text;
  v_sub integer;
  v_last_cycle bigint;
  v_key text;
  v_inserted integer;
begin
  if nullif(trim(p_original_txn), '') is null then
    return query select 'invalid_input'::text, 0;
    return;
  end if;
  select count(*) into v_count from public.device_subscriptions where purchase_token = p_original_txn;
  if v_count = 0 then
    return query select 'no_subscription'::text, 0;
    return;
  end if;
  if v_count > 1 then
    return query select 'ambiguous_owner'::text, 0;
    return;
  end if;
  select s.device_id into v_device from public.device_subscriptions s where s.purchase_token = p_original_txn;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_device, 0));
  select c.subscription_credits into v_sub from public.device_credits c where c.device_id = v_device for update;
  if not found then
    return query select 'no_wallet'::text, 0;
    return;
  end if;
  if coalesce(v_sub, 0) = 0 then
    return query select 'nothing_to_revoke'::text, 0;
    return;
  end if;

  -- Only a refund of the cycle that was last granted may take those credits back.
  select max(split_part(t.idempotency_key, ':', 3)::bigint) into v_last_cycle
    from public.credit_transactions t
    where t.device_id = v_device and t.transaction_type = 'subscription_monthly_grant'
      and t.idempotency_key like p_original_txn || ':%'
      and split_part(t.idempotency_key, ':', 3) ~ '^[0-9]{13}$';
  if p_refunded_expires_ms is not null and v_last_cycle is not null and p_refunded_expires_ms < v_last_cycle then
    return query select 'older_cycle_refund'::text, 0;
    return;
  end if;

  v_key := 'refund:' || p_original_txn || ':' || coalesce(nullif(trim(p_notification_id), ''), 'manual');
  insert into public.credit_transactions (device_id, transaction_type, idempotency_key, free_delta, paid_delta, metadata)
  values (v_device, 'subscription_refund_revoke', v_key, 0, 0, jsonb_build_object(
    'subscription_delta', -v_sub, 'subscription_credits_before', v_sub, 'subscription_credits_after', 0,
    'originalTransactionId', p_original_txn, 'refunded_cycle', p_refunded_expires_ms,
    'notification_id', p_notification_id))
  on conflict (transaction_type, idempotency_key) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    return query select 'already_revoked'::text, 0;
    return;
  end if;
  update public.device_credits set subscription_credits = 0, updated_at = now() where device_id = v_device;
  return query select 'revoked'::text, v_sub;
end;
$function$;

revoke all on function public.grant_subscription_credits_on_renewal(text, text, bigint, integer, text)
  from public, anon, authenticated;
grant execute on function public.grant_subscription_credits_on_renewal(text, text, bigint, integer, text) to service_role;
revoke all on function public.revoke_subscription_credits_on_refund(text, bigint, text)
  from public, anon, authenticated;
grant execute on function public.revoke_subscription_credits_on_refund(text, bigint, text) to service_role;
