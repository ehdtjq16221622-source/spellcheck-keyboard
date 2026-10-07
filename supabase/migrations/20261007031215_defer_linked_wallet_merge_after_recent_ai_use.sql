-- Defer authenticated Apple-wallet merges while either wallet has unsettled AI use.
create or replace function public.merge_linked_apple_subject_wallets_once(
  p_apple_sub text,
  p_request_id text,
  p_token_hash text
)
returns table (
  decision text,
  canonical_wallet_id text,
  free_credits_remaining integer,
  paid_credits_remaining integer
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_existing public.credit_wallet_merge_operations%rowtype;
  v_source public.device_credits%rowtype;
  v_destination public.device_credits%rowtype;
  v_destination_id text;
  v_free integer;
  v_paid integer;
  v_session_wallet text;
  v_recorded_free_use boolean;
begin
  if p_apple_sub is null or p_apple_sub <> btrim(p_apple_sub)
     or length(p_apple_sub) = 0 or length(p_apple_sub) > 512 then
    raise exception 'Invalid Apple subject';
  end if;
  if p_request_id is null or p_request_id <> btrim(p_request_id)
     or length(p_request_id) = 0 or length(p_request_id) > 128 then
    raise exception 'Invalid merge request ID';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Valid wallet session required';
  end if;
  select s.wallet_id into v_session_wallet from public.credit_wallet_sessions s
    where s.token_hash = p_token_hash and s.apple_sub = p_apple_sub
      and s.revoked_at is null and s.expires_at > now();
  if not found then raise exception 'Active Apple wallet session required'; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_apple_sub, 74892));
  select * into v_existing from public.credit_wallet_merge_operations
    where apple_sub = p_apple_sub for update;
  if found then
    if v_existing.request_id <> p_request_id
       or v_session_wallet <> v_existing.canonical_wallet_id then
      raise exception 'Apple subject was already merged with another request ID';
    end if;
    return query select 'already_merged'::text, v_existing.canonical_wallet_id,
      v_existing.free_after, v_existing.paid_after;
    return;
  end if;

  select d.device_id into v_destination_id from public.device_credits d
    where d.apple_user_id = p_apple_sub;
  if not found then raise exception 'Apple wallet is not linked'; end if;
  if v_destination_id = p_apple_sub then
    raise exception 'Apple subject already uses its only canonical wallet';
  end if;
  if v_session_wallet <> v_destination_id then
    raise exception 'Active Apple wallet session required';
  end if;

  perform 1 from public.device_credits d
    where d.device_id in (p_apple_sub, v_destination_id)
    order by d.device_id for update;
  select * into v_source from public.device_credits
    where device_id = p_apple_sub;
  if not found then raise exception 'Second wallet does not exist'; end if;
  select * into v_destination from public.device_credits
    where device_id = v_destination_id;
  if not found then raise exception 'Canonical wallet disappeared'; end if;
  if v_source.apple_user_id is not null
     or v_destination.apple_user_id <> p_apple_sub then
    raise exception 'Wallet ownership changed during merge';
  end if;
  if v_source.subscription_credits <> 0 then
    raise exception 'Second wallet subscription requires transaction review';
  end if;
  if exists (
    select 1 from public.device_subscriptions
    where device_id = p_apple_sub
  ) then
    raise exception 'Second wallet purchase mapping requires transaction review';
  end if;
  if v_source.free_credits < 0 or v_destination.free_credits < 0
     or v_source.paid_credits < 0 or v_destination.paid_credits < 0 then
    raise exception 'Negative balance requires review';
  end if;
  if v_destination.paid_credits > 2147483647 - v_source.paid_credits then
    raise exception 'Paid balance would overflow';
  end if;
  if v_source.free_credits > 0 and exists (
    select 1 from public.credit_transactions t
    where t.device_id = p_apple_sub
      and t.transaction_type = 'server_ai_refund'
      and t.free_delta > 0
  ) then
    raise exception 'Second wallet refund credits require transaction review';
  end if;
  if exists (
    select 1 from public.credit_transactions t
    where t.device_id in (p_apple_sub, v_destination_id)
      and t.transaction_type = 'server_ai_usage'
      and t.created_at > now() - interval '5 minutes'
      and coalesce((t.metadata ->> 'refunded')::boolean, false) = false
  ) then
    raise exception 'Recent AI usage must settle before wallet merge';
  end if;

  select exists (
    select 1 from public.credit_transactions t
    where t.device_id in (p_apple_sub, v_destination_id) and t.free_delta < 0
  ) into v_recorded_free_use;
  v_free := case when v_recorded_free_use then v_destination.free_credits
    else greatest(v_source.free_credits, v_destination.free_credits) end;
  v_paid := v_source.paid_credits + v_destination.paid_credits;

  update public.device_credits
    set free_credits = v_free, paid_credits = v_paid, updated_at = now()
    where device_id = v_destination_id;
  update public.device_credits
    set free_credits = 0, paid_credits = 0, updated_at = now()
    where device_id = p_apple_sub;
  insert into public.credit_wallet_aliases
    (source_wallet_id, canonical_wallet_id, apple_sub)
    values (p_apple_sub, v_destination_id, p_apple_sub);
  insert into public.credit_protected_wallets (wallet_id)
    values (p_apple_sub), (v_destination_id)
    on conflict (wallet_id) do nothing;
  insert into public.credit_wallet_merge_operations (
    apple_sub, request_id, source_wallet_id, canonical_wallet_id,
    source_before, destination_before, free_after, paid_after
  ) values (
    p_apple_sub, p_request_id, p_apple_sub, v_destination_id,
    jsonb_build_object('free', v_source.free_credits, 'paid', v_source.paid_credits,
                       'subscription', v_source.subscription_credits),
    jsonb_build_object('free', v_destination.free_credits, 'paid', v_destination.paid_credits,
                       'subscription', v_destination.subscription_credits),
    v_free, v_paid
  );
  return query select 'merged'::text, v_destination_id, v_free, v_paid;
end;
$function$;
