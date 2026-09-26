-- Additive only. Deploy this before switching the AdMob SSV callback.
create or replace function public.grant_ad_credits_once(
  p_device_id text,
  p_amount integer,
  p_transaction_id text,
  p_metadata jsonb default '{}'::jsonb
)
returns table (applied boolean, paid_credits_remaining integer)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_paid integer;
  v_existing public.credit_transactions%rowtype;
  v_inserted integer;
begin
  if p_device_id is null or p_device_id <> btrim(p_device_id)
     or length(p_device_id) = 0 or length(p_device_id) > 512 then
    raise exception 'Invalid device ID';
  end if;
  if p_amount is null or p_amount not in (100, 200) then
    raise exception 'Invalid ad reward amount';
  end if;
  if p_transaction_id is null or p_transaction_id <> btrim(p_transaction_id)
     or length(p_transaction_id) = 0 or length(p_transaction_id) > 512 then
    raise exception 'Invalid AdMob transaction ID';
  end if;

  select * into v_existing from public.credit_transactions as t
    where t.transaction_type = 'admob_ssv'
      and t.idempotency_key = p_transaction_id;
  if found then
    if v_existing.device_id <> p_device_id or v_existing.paid_delta <> p_amount then
      raise exception 'AdMob transaction ID reused with different details';
    end if;
    select coalesce(d.paid_credits, 0) into v_paid
      from public.device_credits as d where d.device_id = p_device_id;
    return query select false, coalesce(v_paid, 0);
    return;
  end if;

  -- A verified callback must not lose its reward if the app has not yet
  -- created a wallet. Create only the earned ad balance, never an install bonus.
  insert into public.device_credits (
    device_id, credits, free_credits, paid_credits, subscription_credits, last_reset_date
  ) values (p_device_id, 0, 0, 0, 0, current_date)
    on conflict (device_id) do nothing;

  select d.paid_credits into v_paid
    from public.device_credits as d
    where d.device_id = p_device_id
    for update;
  if not found then raise exception 'Ad reward wallet could not be locked'; end if;

  insert into public.credit_transactions (
    device_id, transaction_type, idempotency_key,
    free_delta, paid_delta, metadata
  ) values (
    p_device_id, 'admob_ssv', p_transaction_id,
    0, p_amount, coalesce(p_metadata, '{}'::jsonb)
  ) on conflict (transaction_type, idempotency_key) do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted = 0 then
    select * into v_existing from public.credit_transactions as t
      where t.transaction_type = 'admob_ssv'
        and t.idempotency_key = p_transaction_id;
    if not found or v_existing.device_id <> p_device_id
       or v_existing.paid_delta <> p_amount then
      raise exception 'AdMob transaction ID reused with different details';
    end if;
    return query select false, v_paid;
    return;
  end if;

  if v_paid > 2147483647 - p_amount then
    raise exception 'Paid credit balance would overflow';
  end if;
  update public.device_credits as d
    set paid_credits = d.paid_credits + p_amount,
        updated_at = now()
    where d.device_id = p_device_id;
  return query select true, v_paid + p_amount;
end;
$$;

revoke all on function public.grant_ad_credits_once(text, integer, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.grant_ad_credits_once(text, integer, text, jsonb)
  to service_role;
