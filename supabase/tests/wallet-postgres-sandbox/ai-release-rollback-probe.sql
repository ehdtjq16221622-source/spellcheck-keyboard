-- Run only as a single transaction. All probe data is rolled back.
begin;
do $probe$
declare
  v_wallet text := 'v2:release-probe:' || gen_random_uuid()::text;
  v_request text := gen_random_uuid()::text;
  v_first jsonb;
  v_retry jsonb;
  v_result jsonb;
  v_balance integer;
  v_refunds integer;
begin
  insert into public.device_credits(device_id,free_credits,subscription_credits,paid_credits,last_reset_date)
    values(v_wallet,3,4,100,current_date);
  v_first := public.consume_ai_credit_attempt(v_wallet,v_request,'correct');
  if not (v_first->>'accepted')::boolean or (v_first->>'credits_remaining')::integer <> 97 then
    raise exception 'Probe debit mismatch';
  end if;
  v_retry := public.consume_ai_credit_attempt(v_wallet,v_request,'correct');
  if not (v_retry->>'already_processed')::boolean or
    v_first->>'usage_transaction_id' <> v_retry->>'usage_transaction_id' then
    raise exception 'Probe duplicate debit mismatch';
  end if;
  perform public.refund_ai_credit_attempt(v_wallet,(v_first->>'usage_transaction_id')::uuid);
  v_retry := public.consume_ai_credit_attempt(v_wallet,v_request,'correct');
  if v_first->>'usage_transaction_id' = v_retry->>'usage_transaction_id' then
    raise exception 'Probe retry identity mismatch';
  end if;
  -- A delayed callback belonging to the first attempt must not refund the second.
  perform public.refund_ai_credit_attempt(v_wallet,(v_first->>'usage_transaction_id')::uuid);
  select free_credits+subscription_credits+paid_credits into v_balance
    from public.device_credits where device_id=v_wallet;
  if v_balance <> 97 then raise exception 'Probe stale refund changed balance'; end if;
  perform public.refund_ai_credit_attempt(v_wallet,(v_retry->>'usage_transaction_id')::uuid);
  select count(*) into v_refunds from public.credit_transactions
    where device_id=v_wallet and transaction_type='server_ai_refund';
  if v_refunds <> 2 then raise exception 'Probe refund ledger mismatch'; end if;
  v_first := public.consume_ai_credit_attempt(v_wallet,gen_random_uuid()::text,'translate');
  if not public.complete_ai_credit_attempt(v_wallet,(v_first->>'usage_transaction_id')::uuid) then
    raise exception 'Probe completion failed';
  end if;
  v_result := public.refund_ai_credit_attempt(v_wallet,(v_first->>'usage_transaction_id')::uuid);
  if (v_result->>'refunded')::boolean then raise exception 'Probe refunded successful work'; end if;
  select free_credits+subscription_credits+paid_credits into v_balance
    from public.device_credits where device_id=v_wallet;
  if v_balance <> 87 then raise exception 'Probe final balance mismatch'; end if;
end;
$probe$;
rollback;
