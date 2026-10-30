-- Owner policy 2026-10-30: merge legacy wallets automatically (free credits summed, negatives as zero).
-- Applied to production 2026-10-30 via Management API.
CREATE OR REPLACE FUNCTION public.reconcile_wallet_merge_free(p_source text, p_destination text, p_source_free integer, p_destination_free integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 v_result bigint;
begin
 if exists(select 1 from public.credit_transactions where device_id in(p_source,p_destination)
   and transaction_type='server_ai_usage' and created_at>now()-interval '5 minutes'
   and coalesce((metadata->>'refunded')::boolean,false)=false) then
   raise exception 'Recent AI usage must settle before wallet merge';
 end if;
 -- Owner policy 2026-10-30: merge free credits as-is; negative balances count as zero.
 v_result:=greatest(p_destination_free,0)::bigint+greatest(p_source_free,0);
 if v_result>2147483647 then raise exception 'Free balance would overflow'; end if;
 return v_result::integer;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.merge_linked_apple_subject_wallets_once(p_apple_sub text, p_request_id text, p_token_hash text)
 RETURNS TABLE(decision text, canonical_wallet_id text, free_credits_remaining integer, paid_credits_remaining integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_existing public.credit_wallet_merge_operations%rowtype;
  v_source public.device_credits%rowtype;
  v_destination public.device_credits%rowtype;
  v_destination_id text;
  v_free integer;
  v_paid integer;
  v_session_wallet text;
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
  -- Owner policy 2026-10-30: negative balances count as zero.
  if greatest(v_destination.paid_credits, 0) > 2147483647 - greatest(v_source.paid_credits, 0) then
    raise exception 'Paid balance would overflow';
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

  v_free := public.reconcile_wallet_merge_free(p_apple_sub, v_destination_id,
    v_source.free_credits, v_destination.free_credits);
  v_paid := greatest(v_source.paid_credits, 0) + greatest(v_destination.paid_credits, 0);

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

CREATE OR REPLACE FUNCTION public.merge_verified_legacy_wallet_v2_once(p_source_wallet_id text, p_apple_sub text, p_session_token_hash text, p_request_id text, p_verified_subscription_token text DEFAULT NULL::text, p_verified_product_id text DEFAULT NULL::text)
 RETURNS TABLE(decision text, canonical_wallet_id text, free_credits_remaining integer, paid_credits_remaining integer, subscription_credits_remaining integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_existing public.credit_legacy_merge_operations%rowtype;
  v_source public.device_credits%rowtype;
  v_destination public.device_credits%rowtype;
  v_destination_id text;
  v_free integer;
  v_paid integer;
  v_subscription integer;
  v_grant jsonb;
  v_destination_grant jsonb;
  v_source_purchase public.device_subscriptions%rowtype;
  v_destination_purchase public.device_subscriptions%rowtype;
  v_has_source_purchase boolean := false;
  v_has_destination_purchase boolean := false;
begin
  if p_source_wallet_id is null or length(p_source_wallet_id) = 0
     or length(p_source_wallet_id) > 512 or p_source_wallet_id like 'v2:%'
     or p_apple_sub is null or p_apple_sub <> btrim(p_apple_sub)
     or length(p_apple_sub) = 0 or length(p_apple_sub) > 512
     or p_session_token_hash is null or p_session_token_hash !~ '^[0-9a-f]{64}$'
     or p_request_id is null or p_request_id <> btrim(p_request_id)
     or length(p_request_id) = 0 or length(p_request_id) > 128 then
    raise exception 'Invalid legacy wallet merge proof';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_apple_sub, 74891));
  select d.device_id into v_destination_id from public.device_credits d
    where d.apple_user_id = p_apple_sub;
  if not found then raise exception 'Apple wallet does not exist'; end if;
  perform 1 from public.credit_wallet_sessions s
    where s.token_hash = p_session_token_hash and s.wallet_id = v_destination_id
      and s.apple_sub = p_apple_sub and s.revoked_at is null and s.expires_at > now();
  if not found then raise exception 'Active Apple wallet session required'; end if;
  perform 1 from public.credit_protected_wallets where wallet_id = v_destination_id;
  if not found then raise exception 'Apple wallet session must be activated'; end if;

  select * into v_existing from public.credit_legacy_merge_operations
    where source_wallet_id = p_source_wallet_id for update;
  if found then
    if v_existing.apple_sub <> p_apple_sub or v_existing.request_id <> p_request_id
       or v_existing.canonical_wallet_id <> v_destination_id then
      raise exception 'Legacy wallet was already merged with another request';
    end if;
    select * into v_destination from public.device_credits
      where device_id = v_destination_id for update;
    if not found then raise exception 'Apple wallet missing'; end if;
    return query select 'already_merged'::text, v_destination_id,
      v_destination.free_credits, v_destination.paid_credits,
      v_destination.subscription_credits;
    return;
  end if;

  perform 1 from public.device_credits d
    where d.device_id in (p_source_wallet_id, v_destination_id)
    order by d.device_id for update;
  select * into v_destination from public.device_credits
    where device_id = v_destination_id;
  if not found then raise exception 'Apple wallet missing'; end if;
  select * into v_source from public.device_credits
    where device_id = p_source_wallet_id;
  if not found then
    return query select 'no_source'::text, v_destination_id,
      v_destination.free_credits, v_destination.paid_credits,
      v_destination.subscription_credits;
    return;
  end if;
  if v_source.apple_user_id is not null then
    if v_source.apple_user_id = p_apple_sub then
      return query select 'already_linked'::text, v_destination_id,
        v_destination.free_credits, v_destination.paid_credits,
        v_destination.subscription_credits;
      return;
    end if;
    raise exception 'Legacy wallet belongs to another Apple account';
  end if;
  -- Owner policy 2026-10-30: negative free/paid balances count as zero.
  if v_source.subscription_credits < 0 or v_destination.subscription_credits < 0
     or greatest(v_source.paid_credits, 0) > 2147483647 - greatest(v_destination.paid_credits, 0)
     or v_source.subscription_credits > 2147483647 - v_destination.subscription_credits then
    raise exception 'Wallet balance requires review';
  end if;

  select * into v_source_purchase from public.device_subscriptions
    where device_id = p_source_wallet_id for update;
  v_has_source_purchase := found;
  select * into v_destination_purchase from public.device_subscriptions
    where device_id = v_destination_id for update;
  v_has_destination_purchase := found;

  if v_source.subscription_credits > 0 or v_has_source_purchase then
    if nullif(btrim(p_verified_subscription_token), '') is null
       or nullif(btrim(p_verified_product_id), '') is null then
      raise exception 'Legacy subscription requires Apple verification';
    end if;
    if v_source.subscription_credits > 0 then
      select t.metadata into v_grant from public.credit_transactions t
        where t.device_id = p_source_wallet_id
          and t.transaction_type = 'subscription_monthly_grant'
        order by t.created_at desc limit 1 for update;
      if not found
         or v_grant->>'originalTransactionId' is distinct from p_verified_subscription_token
         or v_grant->>'productId' is distinct from p_verified_product_id
         or coalesce((v_grant->>'subscription_credits')::integer, 0)
              < v_source.subscription_credits then
        raise exception 'Legacy subscription ledger does not match Apple verification';
      end if;
    end if;

    if v_has_source_purchase and (
       v_source_purchase.purchase_token <> p_verified_subscription_token
       or v_source_purchase.product_id <> p_verified_product_id) then
      raise exception 'Legacy subscription mapping does not match Apple verification';
    end if;

    if v_destination.subscription_credits > 0 then
      select t.metadata into v_destination_grant from public.credit_transactions t
        where t.device_id = v_destination_id
          and t.transaction_type = 'subscription_monthly_grant'
        order by t.created_at desc limit 1 for update;
      if not found
         or v_destination_grant->>'originalTransactionId' is distinct from p_verified_subscription_token
         or v_destination_grant->>'productId' is distinct from p_verified_product_id
         or coalesce((v_destination_grant->>'subscription_credits')::integer, 0)
              < v_destination.subscription_credits then
        raise exception 'Apple subscription ledger requires review';
      end if;
    end if;

    if v_has_destination_purchase and (
       v_destination_purchase.purchase_token <> p_verified_subscription_token
       or v_destination_purchase.product_id <> p_verified_product_id) then
      raise exception 'Apple wallet has a different subscription purchase';
    end if;
  end if;

  if exists (
    select 1 from public.credit_transactions t
    where t.device_id = p_source_wallet_id and t.transaction_type = 'server_ai_usage'
      and t.created_at > now() - interval '5 minutes'
      and coalesce((t.metadata ->> 'refunded')::boolean, false) = false
  ) then
    raise exception 'Recent AI usage must settle before wallet merge';
  end if;
  if exists (select 1 from public.credit_legacy_merge_operations where apple_sub = p_apple_sub) then
    raise exception 'Another legacy wallet was already merged into this Apple account';
  end if;

  v_free := public.reconcile_wallet_merge_free(p_source_wallet_id, v_destination_id,
    v_source.free_credits, v_destination.free_credits);
  v_paid := greatest(v_source.paid_credits, 0) + greatest(v_destination.paid_credits, 0);
  v_subscription := v_source.subscription_credits + v_destination.subscription_credits;

  update public.device_credits set free_credits = v_free, paid_credits = v_paid,
    subscription_credits = v_subscription, updated_at = now()
    where device_id = v_destination_id;
  update public.device_credits set free_credits = 0, paid_credits = 0,
    subscription_credits = 0, updated_at = now()
    where device_id = p_source_wallet_id;

  insert into public.credit_transactions (
    device_id, transaction_type, idempotency_key, free_delta, paid_delta, metadata
  ) values (
    v_destination_id, 'legacy_wallet_merge', 'legacy-merge:' || p_request_id,
    v_free - v_destination.free_credits, v_paid - v_destination.paid_credits,
    jsonb_build_object(
      'source_wallet_id', p_source_wallet_id,
      'request_id', p_request_id,
      'subscription_delta', v_source.subscription_credits,
      'subscription_credits_after', v_subscription,
      'source_before', jsonb_build_object(
        'free', v_source.free_credits, 'paid', v_source.paid_credits,
        'subscription', v_source.subscription_credits
      ),
      'destination_before', jsonb_build_object(
        'free', v_destination.free_credits, 'paid', v_destination.paid_credits,
        'subscription', v_destination.subscription_credits
      )
    )
  );

  if v_has_source_purchase then
    if not v_has_destination_purchase then
      update public.device_subscriptions set device_id = v_destination_id, updated_at = now()
        where device_id = p_source_wallet_id;
    else
      delete from public.device_subscriptions where device_id = p_source_wallet_id;
    end if;
  end if;

  insert into public.credit_wallet_aliases (source_wallet_id, canonical_wallet_id, apple_sub)
    values (p_source_wallet_id, v_destination_id, p_apple_sub);
  insert into public.credit_protected_wallets (wallet_id)
    values (p_source_wallet_id) on conflict (wallet_id) do nothing;
  insert into public.credit_legacy_merge_operations (
    source_wallet_id, apple_sub, request_id, canonical_wallet_id,
    source_before, destination_before, free_after, paid_after
  ) values (
    p_source_wallet_id, p_apple_sub, p_request_id, v_destination_id,
    jsonb_build_object('free', v_source.free_credits, 'paid', v_source.paid_credits,
                       'subscription', v_source.subscription_credits),
    jsonb_build_object('free', v_destination.free_credits, 'paid', v_destination.paid_credits,
                       'subscription', v_destination.subscription_credits),
    v_free, v_paid
  );
  return query select 'merged'::text, v_destination_id, v_free, v_paid, v_subscription;
end;
$function$;

-- One-time server-side merge of legacy Apple-subject wallets into their canonical
-- Apple wallets (owner request 2026-10-30). Mirrors merge_linked_apple_subject_wallets_once
-- without a live client session. Subscription-bearing wallets are skipped: they need
-- Apple verification through wallet_link_v2. Callable only by postgres.
create or replace function public.admin_batch_merge_linked_apple_subjects(p_limit integer, p_dry_run boolean default true)
returns table(outcome text, wallets integer, free_moved bigint, paid_moved bigint)
language plpgsql
security definer
set search_path to ''
as $function$
declare
  r record;
  v_source public.device_credits%rowtype;
  v_destination public.device_credits%rowtype;
  v_free integer;
  v_paid integer;
  v_request_id text;
  v_outcome text;
  v_counts jsonb := '{}'::jsonb;
  v_free_moved bigint := 0;
  v_paid_moved bigint := 0;
begin
  for r in
    select d.device_id as apple_sub, c.device_id as destination_id
    from public.device_credits d
    join public.device_credits c on c.apple_user_id = d.device_id and c.device_id <> d.device_id
    where d.apple_user_id is null
      and not exists (select 1 from public.credit_wallet_aliases a where a.source_wallet_id = d.device_id)
      and not exists (select 1 from public.credit_wallet_merge_operations m where m.apple_sub = d.device_id)
    order by d.device_id
    limit p_limit
  loop
    begin
      perform pg_advisory_xact_lock(hashtextextended(r.apple_sub, 74892));
      perform 1 from public.device_credits x
        where x.device_id in (r.apple_sub, r.destination_id) order by x.device_id for update;
      select * into v_source from public.device_credits where device_id = r.apple_sub;
      select * into v_destination from public.device_credits where device_id = r.destination_id;
      if v_source.apple_user_id is not null or v_destination.apple_user_id is distinct from r.apple_sub then
        v_outcome := 'skipped_ownership_changed';
      elsif v_source.subscription_credits <> 0
         or exists (select 1 from public.device_subscriptions s where s.device_id = r.apple_sub) then
        v_outcome := 'skipped_subscription_needs_apple_check';
      elsif exists (select 1 from public.credit_wallet_merge_operations m where m.apple_sub = r.apple_sub)
         or exists (select 1 from public.credit_wallet_aliases a where a.source_wallet_id = r.apple_sub) then
        v_outcome := 'skipped_already_merged';
      else
        v_free := public.reconcile_wallet_merge_free(r.apple_sub, r.destination_id,
          v_source.free_credits, v_destination.free_credits);
        if greatest(v_destination.paid_credits, 0) > 2147483647 - greatest(v_source.paid_credits, 0) then
          raise exception 'Paid balance would overflow';
        end if;
        v_paid := greatest(v_source.paid_credits, 0) + greatest(v_destination.paid_credits, 0);
        v_request_id := 'linked-merge:auto-v1:' || encode(extensions.digest(r.apple_sub, 'sha256'), 'hex');
        if not p_dry_run then
          update public.device_credits set free_credits = v_free, paid_credits = v_paid, updated_at = now()
            where device_id = r.destination_id;
          update public.device_credits set free_credits = 0, paid_credits = 0, updated_at = now()
            where device_id = r.apple_sub;
          insert into public.credit_wallet_aliases (source_wallet_id, canonical_wallet_id, apple_sub)
            values (r.apple_sub, r.destination_id, r.apple_sub);
          insert into public.credit_protected_wallets (wallet_id)
            values (r.apple_sub), (r.destination_id) on conflict (wallet_id) do nothing;
          insert into public.credit_wallet_merge_operations (
            apple_sub, request_id, source_wallet_id, canonical_wallet_id,
            source_before, destination_before, free_after, paid_after
          ) values (
            r.apple_sub, v_request_id, r.apple_sub, r.destination_id,
            jsonb_build_object('free', v_source.free_credits, 'paid', v_source.paid_credits,
                               'subscription', v_source.subscription_credits, 'batch', 'admin_20261030'),
            jsonb_build_object('free', v_destination.free_credits, 'paid', v_destination.paid_credits,
                               'subscription', v_destination.subscription_credits),
            v_free, v_paid
          );
        end if;
        v_outcome := case when p_dry_run then 'would_merge' else 'merged' end;
        v_free_moved := v_free_moved + (v_free - greatest(v_destination.free_credits, 0));
        v_paid_moved := v_paid_moved + (v_paid - greatest(v_destination.paid_credits, 0));
      end if;
    exception when others then
      v_outcome := case when sqlerrm = 'Recent AI usage must settle before wallet merge'
        then 'skipped_recent_usage' else 'failed:' || left(sqlerrm, 60) end;
    end;
    v_counts := jsonb_set(v_counts, array[v_outcome], to_jsonb(coalesce((v_counts->>v_outcome)::int, 0) + 1));
  end loop;
  return query select k, v::int, case when k in ('merged','would_merge') then v_free_moved end,
    case when k in ('merged','would_merge') then v_paid_moved end
    from jsonb_each_text(v_counts) as e(k, v);
end;
$function$;
revoke all on function public.admin_batch_merge_linked_apple_subjects(integer, boolean) from public, anon, authenticated, service_role;
