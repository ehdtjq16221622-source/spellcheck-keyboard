-- Preserve retry history and recover incomplete AI debits without client access.
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
    -- Keep each previous debit/refund pair addressable, including legacy retries.
    update public.credit_transactions
      set idempotency_key = 'ai-archived:' || v_usage.id::text,
          metadata = metadata || jsonb_build_object('request_id', p_request_id)
      where id = v_usage.id;
    update public.credit_transactions
      set idempotency_key = 'ai-archived:' || v_usage.id::text,
          metadata = metadata || jsonb_build_object('request_id', p_request_id)
      where transaction_type = 'server_ai_refund'
        and idempotency_key = p_request_id
        and metadata ->> 'usage_transaction_id' = v_usage.id::text;
  end if;
    insert into public.credit_transactions (
      device_id, transaction_type, idempotency_key, free_delta, paid_delta, metadata
    ) values (
      p_device_id, 'server_ai_usage', p_request_id,
      -v_deducted_free, -v_deducted_paid,
      jsonb_build_object('kind', p_kind, 'cost', v_cost,
        'subscription_delta', -v_deducted_subscription, 'refunded', false)
    );

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
  if not found then raise exception 'Credit wallet not found'; end if;
  if coalesce((v_usage.metadata ->> 'refunded')::boolean, false) then
    return query select coalesce(v_free, 0), coalesce(v_paid, 0) + coalesce(v_subscription, 0), coalesce(v_free, 0) + coalesce(v_paid, 0) + coalesce(v_subscription, 0); return;
  end if;
  v_refund_free := greatest(0, -v_usage.free_delta);
  v_refund_paid := greatest(0, -v_usage.paid_delta);
  v_refund_subscription := greatest(0, -coalesce((v_usage.metadata ->> 'subscription_delta')::integer, 0));
  v_free := coalesce(v_free, 0) + v_refund_free; v_paid := coalesce(v_paid, 0) + v_refund_paid; v_subscription := coalesce(v_subscription, 0) + v_refund_subscription;
  update device_credits set free_credits = v_free, paid_credits = v_paid, subscription_credits = v_subscription, updated_at = now() where device_id = p_device_id;
  update credit_transactions set free_delta = 0, paid_delta = 0, metadata = v_usage.metadata || jsonb_build_object('refunded', true, 'refunded_at', now(), 'charged_free', -v_usage.free_delta, 'charged_paid', -v_usage.paid_delta) where id = v_usage.id;
  insert into credit_transactions (device_id, transaction_type, idempotency_key, free_delta, paid_delta, metadata)
  values (p_device_id, 'server_ai_refund', p_request_id, v_refund_free, v_refund_paid, jsonb_build_object('usage_transaction_id', v_usage.id, 'subscription_credits', v_refund_subscription))
  on conflict (transaction_type, idempotency_key) do nothing;
  return query select v_free, v_paid + v_subscription, v_free + v_paid + v_subscription;
end; $function$
;


-- A recovery row is committed in the same transaction as the debit.
-- Only the service role and the database scheduler may access these records.
create table public.ai_credit_recovery (
  usage_transaction_id uuid primary key,
  device_id text not null,
  state text not null default 'pending' check (state in ('pending','completed','refunded')),
  recover_after timestamptz not null default (now() + interval '2 minutes'),
  retry_count integer not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.ai_credit_recovery enable row level security;
revoke all on public.ai_credit_recovery from public, anon, authenticated;
grant all on public.ai_credit_recovery to service_role;
create index ai_credit_recovery_pending_idx on public.ai_credit_recovery(recover_after)
  where state='pending';
create index ai_credit_recovery_terminal_idx on public.ai_credit_recovery(updated_at)
  where state<>'pending';

create function public.consume_ai_credit_attempt(p_device_id text, p_request_id text, p_kind text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_result record; v_usage_id uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_device_id,0));
  select * into v_result from public.consume_ai_credits(p_device_id,p_request_id,p_kind);
  if v_result.accepted then
    select id into strict v_usage_id from public.credit_transactions
      where transaction_type='server_ai_usage' and idempotency_key=p_request_id and device_id=p_device_id;
    if not v_result.already_processed then
      insert into public.ai_credit_recovery(usage_transaction_id,device_id)
        values(v_usage_id,p_device_id);
    end if;
  end if;
  return to_jsonb(v_result) || jsonb_build_object('usage_transaction_id',v_usage_id);
end $$;

create function public.complete_ai_credit_attempt(p_device_id text,p_usage_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_state text;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_device_id,0));
  select state into v_state from public.ai_credit_recovery
    where usage_transaction_id=p_usage_id and device_id=p_device_id for update;
  if not found then
    -- Completed recovery records expire; the durable usage row still proves ownership.
    return exists(select 1 from public.credit_transactions where id=p_usage_id
      and device_id=p_device_id and transaction_type='server_ai_usage'
      and not coalesce((metadata->>'refunded')::boolean,false));
  end if;
  if v_state='refunded' then return false; end if;
  update public.ai_credit_recovery set state='completed',updated_at=now()
    where usage_transaction_id=p_usage_id;
  return true;
end $$;

create function public.refund_ai_credit_attempt(p_device_id text,p_usage_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_key text; v_state text; v_result record;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_device_id,0));
  select r.state,t.idempotency_key into v_state,v_key
    from public.ai_credit_recovery r join public.credit_transactions t on t.id=r.usage_transaction_id
    where r.usage_transaction_id=p_usage_id and r.device_id=p_device_id and t.device_id=p_device_id
    for update of r,t;
  if not found then raise exception 'AI usage attempt not found'; end if;
  -- Another invocation may already have completed the same request successfully.
  if v_state='completed' then
    return (select jsonb_build_object('free_credits_remaining',free_credits,
      'paid_credits_remaining',paid_credits+subscription_credits,
      'credits_remaining',free_credits+paid_credits+subscription_credits,
      'refunded',false) from public.device_credits where device_id=p_device_id);
  end if;
  select * into v_result from public.refund_ai_credits(p_device_id,v_key);
  update public.ai_credit_recovery set state='refunded',updated_at=now()
    where usage_transaction_id=p_usage_id;
  return to_jsonb(v_result) || jsonb_build_object('refunded',true);
end $$;

create function public.recover_pending_ai_credits()
returns integer language plpgsql security definer set search_path='' as $$
declare v_item record; v_count integer:=0;
begin
  -- All paths take the wallet lock before row locks to avoid lock-order deadlocks.
  for v_item in select usage_transaction_id,device_id from public.ai_credit_recovery
    where state='pending' and recover_after<=now() order by recover_after limit 100
  loop
    begin
      perform public.refund_ai_credit_attempt(v_item.device_id,v_item.usage_transaction_id);
      v_count:=v_count+1;
    exception when others then
      update public.ai_credit_recovery set retry_count=retry_count+1,
        recover_after=now()+interval '1 minute',updated_at=now()
        where usage_transaction_id=v_item.usage_transaction_id and state='pending';
      raise warning 'AI refund recovery deferred for attempt % (SQLSTATE %)',v_item.usage_transaction_id,SQLSTATE;
    end;
  end loop;
  -- Pending recovery is never deleted, even during a prolonged outage.
  delete from public.ai_credit_recovery where state<>'pending' and updated_at<now()-interval '30 days';
  return v_count;
end $$;

revoke all on function public.consume_ai_credit_attempt(text,text,text) from public,anon,authenticated;
revoke all on function public.complete_ai_credit_attempt(text,uuid) from public,anon,authenticated;
revoke all on function public.refund_ai_credit_attempt(text,uuid) from public,anon,authenticated;
revoke all on function public.recover_pending_ai_credits() from public,anon,authenticated;
grant execute on function public.consume_ai_credit_attempt(text,text,text) to service_role;
grant execute on function public.complete_ai_credit_attempt(text,uuid) to service_role;
grant execute on function public.refund_ai_credit_attempt(text,uuid) to service_role;
grant execute on function public.recover_pending_ai_credits() to service_role;

select cron.schedule('kingboard-ai-refund-recovery','* * * * *',
  'select public.recover_pending_ai_credits()');
