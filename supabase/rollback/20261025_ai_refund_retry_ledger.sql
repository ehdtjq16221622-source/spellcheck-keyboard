-- First redeploy the previous correct/translate sources. Keep all recovery and ledger history.
-- Retry outstanding refunds before disabling the schedule.
select public.recover_pending_ai_credits();
select cron.unschedule('kingboard-ai-refund-recovery');
-- Archived ledger pairs must be retained. Restoring the old consume function alone
-- would reintroduce history loss on future retries; use only as an emergency rollback.
CREATE OR REPLACE FUNCTION public.consume_ai_credits(p_device_id text, p_request_id text, p_kind text)
 RETURNS TABLE(accepted boolean, already_processed boolean, free_credits_remaining integer, paid_credits_remaining integer, credits_remaining integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_cost integer;
  v_free integer;
  v_paid integer;
  v_subscription integer;
  v_deducted_free integer;
  v_deducted_subscription integer;
  v_deducted_paid integer;
  v_usage public.credit_transactions%rowtype;
  v_usage_exists boolean := false;
  v_refunded boolean;
begin
  if p_device_id is null or length(trim(p_device_id)) = 0 or length(p_device_id) > 512 then
    raise exception 'invalid device id';
  end if;
  if p_request_id is null or length(trim(p_request_id)) = 0 or length(p_request_id) > 128 then
    raise exception 'invalid request id';
  end if;

  v_cost := case p_kind
    when 'correct' then 10
    when 'formal' then 30
    when 'translate' then 20
    else null
  end;
  if v_cost is null then
    raise exception 'invalid AI credit kind';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_device_id, 0));

  -- Do not turn an unregistered legacy identifier into a zero-credit wallet.
  -- Lock an existing row so it cannot disappear before the normal debit path.
  if left(p_device_id, 3) <> 'v2:' then
    perform 1 from public.device_credits d where d.device_id = p_device_id for update;
    if not found then
      return query select false, false, 0, 0, 0;
      return;
    end if;
  end if;

  select t.* into v_usage
    from public.credit_transactions as t
    where t.transaction_type = 'server_ai_usage'
      and t.idempotency_key = p_request_id
    for update;
  v_usage_exists := found;

  if v_usage_exists and v_usage.device_id <> p_device_id then
    raise exception 'request id belongs to another device';
  end if;

  if v_usage_exists then
    v_refunded := coalesce((v_usage.metadata ->> 'refunded')::boolean, false);
    if not v_refunded then
      select d.free_credits, d.paid_credits, d.subscription_credits
        into v_free, v_paid, v_subscription
        from public.device_credits as d
        where d.device_id = p_device_id;
      return query select true, true, coalesce(v_free, 0),
        coalesce(v_paid, 0) + coalesce(v_subscription, 0),
        coalesce(v_free, 0) + coalesce(v_paid, 0) + coalesce(v_subscription, 0);
      return;
    end if;
  end if;

  insert into public.device_credits (
    device_id, free_credits, paid_credits, subscription_credits, last_reset_date
  ) values (p_device_id, 0, 0, 0, current_date)
  on conflict (device_id) do nothing;

  select d.free_credits, d.paid_credits, d.subscription_credits
    into v_free, v_paid, v_subscription
    from public.device_credits as d
    where d.device_id = p_device_id
    for update;

  if coalesce(v_free, 0) + coalesce(v_subscription, 0) + coalesce(v_paid, 0) < v_cost then
    begin
      insert into public.credit_transactions (
        device_id, transaction_type, idempotency_key, free_delta, paid_delta, metadata
      ) values (
        p_device_id, 'ai_blocked', p_request_id, 0, 0,
        jsonb_build_object('kind', p_kind, 'cost', v_cost,
          'balance', coalesce(v_free, 0) + coalesce(v_subscription, 0) + coalesce(v_paid, 0))
      ) on conflict (transaction_type, idempotency_key) do nothing;
    exception when others then
      null;
    end;
    return query select false, false, coalesce(v_free, 0),
      coalesce(v_paid, 0) + coalesce(v_subscription, 0),
      coalesce(v_free, 0) + coalesce(v_paid, 0) + coalesce(v_subscription, 0);
    return;
  end if;

  v_deducted_free := least(v_free, v_cost);
  v_deducted_subscription := least(v_subscription, v_cost - v_deducted_free);
  v_deducted_paid := v_cost - v_deducted_free - v_deducted_subscription;
  v_free := v_free - v_deducted_free;
  v_subscription := v_subscription - v_deducted_subscription;
  v_paid := v_paid - v_deducted_paid;

  update public.device_credits as d
    set free_credits = v_free,
        subscription_credits = v_subscription,
        paid_credits = v_paid,
        updated_at = now()
    where d.device_id = p_device_id;

  if v_usage_exists then
    update public.credit_transactions as t
      set free_delta = -v_deducted_free,
          paid_delta = -v_deducted_paid,
          metadata = jsonb_build_object('kind', p_kind, 'cost', v_cost,
            'subscription_delta', -v_deducted_subscription, 'refunded', false)
      where t.id = v_usage.id;
  else
    insert into public.credit_transactions (
      device_id, transaction_type, idempotency_key, free_delta, paid_delta, metadata
    ) values (
      p_device_id, 'server_ai_usage', p_request_id,
      -v_deducted_free, -v_deducted_paid,
      jsonb_build_object('kind', p_kind, 'cost', v_cost,
        'subscription_delta', -v_deducted_subscription, 'refunded', false)
    );
  end if;

  return query select true, false, v_free, v_paid + v_subscription,
    v_free + v_paid + v_subscription;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.refund_ai_credits(p_device_id text, p_request_id text)
 RETURNS TABLE(free_credits_remaining integer, paid_credits_remaining integer, credits_remaining integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_usage credit_transactions%rowtype; v_free integer; v_paid integer; v_subscription integer;
  v_refund_free integer; v_refund_paid integer; v_refund_subscription integer;
begin
  if p_device_id is null or length(trim(p_device_id)) = 0 or length(p_device_id) > 512 then raise exception 'invalid device id'; end if;
  if p_request_id is null or length(trim(p_request_id)) = 0 or length(p_request_id) > 128 then raise exception 'invalid request id'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_device_id, 0));
  select * into v_usage from credit_transactions where transaction_type = 'server_ai_usage' and idempotency_key = p_request_id for update;
  if not found or v_usage.device_id <> p_device_id then raise exception 'AI usage record not found'; end if;
  select free_credits, paid_credits, subscription_credits into v_free, v_paid, v_subscription from device_credits where device_id = p_device_id for update;
  if coalesce((v_usage.metadata ->> 'refunded')::boolean, false) then
    return query select coalesce(v_free, 0), coalesce(v_paid, 0) + coalesce(v_subscription, 0), coalesce(v_free, 0) + coalesce(v_paid, 0) + coalesce(v_subscription, 0); return;
  end if;
  v_refund_free := greatest(0, -v_usage.free_delta);
  v_refund_paid := greatest(0, -v_usage.paid_delta);
  v_refund_subscription := greatest(0, -coalesce((v_usage.metadata ->> 'subscription_delta')::integer, 0));
  v_free := coalesce(v_free, 0) + v_refund_free; v_paid := coalesce(v_paid, 0) + v_refund_paid; v_subscription := coalesce(v_subscription, 0) + v_refund_subscription;
  update device_credits set free_credits = v_free, paid_credits = v_paid, subscription_credits = v_subscription, updated_at = now() where device_id = p_device_id;
  update credit_transactions set free_delta = 0, paid_delta = 0, metadata = v_usage.metadata || jsonb_build_object('refunded', true, 'refunded_at', now()) where id = v_usage.id;
  insert into credit_transactions (device_id, transaction_type, idempotency_key, free_delta, paid_delta, metadata)
  values (p_device_id, 'server_ai_refund', p_request_id, v_refund_free, v_refund_paid, jsonb_build_object('usage_transaction_id', v_usage.id, 'subscription_credits', v_refund_subscription))
  on conflict (transaction_type, idempotency_key) do nothing;
  return query select v_free, v_paid + v_subscription, v_free + v_paid + v_subscription;
end; $function$
;
