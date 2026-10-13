-- Production trial only. Send this entire file as ONE SQL request.
-- Expected error: LINKED_BONUS_RACE_ALL_ASSERTIONS_PASSED_ROLLBACK
-- Do not run without separate approval; the final exception aborts the transaction.
begin;
set local lock_timeout = '500ms';
set local statement_timeout = '15s';

do $$
begin
  if to_regprocedure('public.linked_apple_has_other_install_bonus(text,text)') is not null
     or md5(pg_get_functiondef('public.reserve_guest_install_bonus(text,text)'::regprocedure))
        <> 'cf187c073b7858b594766135c676fc56'
     or md5(pg_get_functiondef('public.confirm_guest_install_bonus_devicecheck(text,text,uuid)'::regprocedure))
        <> '544614d70908ee6701a30c143bb30b3f'
     or md5(pg_get_functiondef('public.complete_guest_install_bonus_guarded(text,text,uuid)'::regprocedure))
        <> 'd4bc3ce6625394e67b8537ed6c4836db' then
    raise exception 'LIVE_BONUS_FUNCTIONS_CHANGED_STOP';
  end if;
  perform pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);
end;
$$;

-- Exact contents of 20261013071028_handle_linked_guest_bonus_race.sql begin.
-- Apply before deploying the matching wallet_link_v2 bundle.
-- A guest can become Apple-linked while a concurrent install-bonus request
-- waits for DeviceCheck. Keep the original wallet proof and device lock.
create or replace function public.linked_apple_has_other_install_bonus(
  p_apple_sub text, p_wallet_id text
) returns boolean language sql security invoker set search_path = '' as $$
  select exists (
    select 1 from (
      select d.device_id as wallet_id from public.device_credits d
        where d.apple_user_id = p_apple_sub
      union
      select a.source_wallet_id from public.credit_wallet_aliases a
        where a.apple_sub = p_apple_sub
      union
      select l.wallet_id from public.wallet_v2_link_attempts l
        where l.apple_sub = p_apple_sub
      union
      select p_apple_sub
    ) owned
    join public.credit_transactions t on t.device_id = owned.wallet_id
    where owned.wallet_id <> p_wallet_id
      and t.transaction_type in ('install_bonus', 'install_bonus_restore')
  );
$$;

create or replace function public.reserve_guest_install_bonus(
  p_wallet_id text, p_secret_hash text
) returns text language plpgsql security definer set search_path = '' as $$
declare
  v_credential public.wallet_v2_credentials%rowtype;
  v_owner text;
  v_state text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  select * into v_credential from public.wallet_v2_credentials
    where wallet_id = p_wallet_id for update;
  if not found or v_credential.secret_hash <> p_secret_hash
     or v_credential.state not in ('pending', 'active', 'linked') then
    raise exception 'Wallet possession proof failed';
  end if;
  select apple_user_id into v_owner from public.device_credits
    where device_id = p_wallet_id for update;
  if not found or (v_credential.state = 'linked') <> (v_owner is not null) then
    raise exception 'Guest wallet ownership changed';
  end if;
  if exists (select 1 from public.credit_transactions
      where transaction_type in ('install_bonus', 'install_bonus_restore')
        and device_id = p_wallet_id) then
    return 'granted';
  end if;
  if v_owner is not null and public.linked_apple_has_other_install_bonus(v_owner, p_wallet_id) then
    return 'account_bonus_exists';
  end if;
  insert into public.guest_install_bonus_claims(wallet_id, state)
    values (p_wallet_id, 'pending') on conflict (wallet_id) do nothing;
  select state into v_state from public.guest_install_bonus_claims
    where wallet_id = p_wallet_id;
  return v_state;
end;
$$;

create or replace function public.confirm_guest_install_bonus_devicecheck(
  p_wallet_id text, p_secret_hash text, p_lock_owner uuid
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_state text;
  v_owner text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  perform 1 from public.guest_bonus_devicecheck_lock
    where singleton and owner = p_lock_owner and expires_at > now() for update;
  if not found then raise exception 'Device verification lock lost'; end if;
  select state into v_state from public.wallet_v2_credentials
    where wallet_id = p_wallet_id and secret_hash = p_secret_hash
      and state in ('pending', 'active', 'linked') for update;
  if not found then raise exception 'Wallet possession proof failed'; end if;
  select apple_user_id into v_owner from public.device_credits
    where device_id = p_wallet_id for update;
  if not found or (v_state = 'linked') <> (v_owner is not null) then
    raise exception 'Guest wallet ownership changed';
  end if;
  update public.guest_install_bonus_claims
    set verification_confirmed_at = coalesce(verification_confirmed_at, now())
    where wallet_id = p_wallet_id and state = 'pending';
  return found;
end;
$$;

create or replace function public.complete_guest_install_bonus_guarded(
  p_wallet_id text, p_secret_hash text, p_lock_owner uuid
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_credential public.wallet_v2_credentials%rowtype;
  v_state text;
  v_confirmed timestamptz;
  v_owner text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  perform 1 from public.guest_bonus_devicecheck_lock
    where singleton and owner = p_lock_owner and expires_at > now() for update;
  if not found then raise exception 'Device verification lock lost'; end if;
  select * into v_credential from public.wallet_v2_credentials
    where wallet_id = p_wallet_id for update;
  if not found or v_credential.secret_hash <> p_secret_hash
     or v_credential.state not in ('pending', 'active', 'linked') then
    raise exception 'Wallet possession proof failed';
  end if;
  if exists (select 1 from public.credit_transactions
      where transaction_type in ('install_bonus', 'install_bonus_restore')
        and device_id = p_wallet_id) then return false; end if;
  select state, verification_confirmed_at into v_state, v_confirmed
    from public.guest_install_bonus_claims
    where wallet_id = p_wallet_id for update;
  if not found or v_state = 'granted' then return false; end if;
  if v_state <> 'pending' or v_confirmed is null then
    raise exception 'Confirmed device verification required';
  end if;
  select apple_user_id into v_owner from public.device_credits
    where device_id = p_wallet_id for update;
  if not found or (v_credential.state = 'linked') <> (v_owner is not null) then
    raise exception 'Guest wallet ownership changed';
  end if;
  if v_owner is not null and public.linked_apple_has_other_install_bonus(v_owner, p_wallet_id) then
    return false;
  end if;
  insert into public.credit_transactions (
    device_id, transaction_type, idempotency_key, free_delta, metadata
  ) values (
    p_wallet_id, 'install_bonus', p_wallet_id, 500,
    pg_catalog.jsonb_build_object('source', 'wallet_link_v2_devicecheck')
  );
  update public.device_credits
    set free_credits = free_credits + 500, updated_at = now()
    where device_id = p_wallet_id;
  update public.guest_install_bonus_claims
    set state = 'granted', granted_at = now()
    where wallet_id = p_wallet_id;
  return true;
end;
$$;

revoke all on function public.linked_apple_has_other_install_bonus(text, text)
  from public, anon, authenticated;
grant execute on function public.linked_apple_has_other_install_bonus(text, text)
  to service_role;
revoke all on function public.reserve_guest_install_bonus(text, text)
  from public, anon, authenticated;
revoke all on function public.confirm_guest_install_bonus_devicecheck(text, text, uuid)
  from public, anon, authenticated;
revoke all on function public.complete_guest_install_bonus_guarded(text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.reserve_guest_install_bonus(text, text) to service_role;
grant execute on function public.confirm_guest_install_bonus_devicecheck(text, text, uuid) to service_role;
grant execute on function public.complete_guest_install_bonus_guarded(text, text, uuid) to service_role;
-- Exact migration contents end.

do $$
declare
  v_wallet_a text := 'codex_linked_bonus_trial_' || replace(gen_random_uuid()::text, '-', '');
  v_wallet_b text := 'codex_linked_bonus_trial_' || replace(gen_random_uuid()::text, '-', '');
  v_apple_a text := 'codex_linked_bonus_trial_apple_' || replace(gen_random_uuid()::text, '-', '');
  v_apple_b text := 'codex_linked_bonus_trial_apple_' || replace(gen_random_uuid()::text, '-', '');
  v_secret_a text := md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text);
  v_secret_b text := md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text);
  v_status text;
  v_wrong_proof_rejected boolean := false;
  v_function regprocedure;
begin
  insert into public.device_credits
    (device_id, credits, free_credits, paid_credits, subscription_credits, apple_user_id)
    values (v_wallet_a, 0, 0, 0, 0, v_apple_a),
           (v_wallet_b, 0, 0, 0, 0, v_apple_b),
           (v_apple_b, 0, 0, 0, 0, null);
  insert into public.wallet_v2_credentials (wallet_id, secret_hash, state)
    values (v_wallet_a, v_secret_a, 'linked'),
           (v_wallet_b, v_secret_b, 'linked');

  select public.reserve_guest_install_bonus(v_wallet_a, v_secret_a) into v_status;
  if v_status is distinct from 'pending' then
    raise exception 'TRIAL_LINKED_WALLET_RESERVE_FAILED';
  end if;
  insert into public.credit_transactions
    (device_id, transaction_type, idempotency_key, free_delta, metadata)
    values (v_wallet_a, 'install_bonus_restore', v_wallet_a, 500, '{}'::jsonb);
  select public.reserve_guest_install_bonus(v_wallet_a, v_secret_a) into v_status;
  if v_status is distinct from 'granted' then
    raise exception 'TRIAL_OWN_RESTORE_GUARD_FAILED';
  end if;

  insert into public.credit_transactions
    (device_id, transaction_type, idempotency_key, free_delta, metadata)
    values (v_apple_b, 'install_bonus_restore', v_apple_b, 500, '{}'::jsonb);
  select public.reserve_guest_install_bonus(v_wallet_b, v_secret_b) into v_status;
  if v_status is distinct from 'account_bonus_exists' then
    raise exception 'TRIAL_OTHER_APPLE_WALLET_GUARD_FAILED';
  end if;
  if exists (select 1 from public.guest_install_bonus_claims where wallet_id = v_wallet_b)
     or exists (select 1 from public.credit_transactions
                where device_id = v_wallet_b and transaction_type = 'install_bonus') then
    raise exception 'TRIAL_DUPLICATE_BONUS_CREATED';
  end if;

  begin
    perform public.reserve_guest_install_bonus(v_wallet_b, repeat('0', 64));
  exception when raise_exception then
    if sqlerrm = 'Wallet possession proof failed' then
      v_wrong_proof_rejected := true;
    else
      raise;
    end if;
  end;
  if not v_wrong_proof_rejected then
    raise exception 'TRIAL_WRONG_PROOF_ACCEPTED';
  end if;

  for v_function in select unnest(array[
    'public.linked_apple_has_other_install_bonus(text,text)'::regprocedure,
    'public.reserve_guest_install_bonus(text,text)'::regprocedure,
    'public.confirm_guest_install_bonus_devicecheck(text,text,uuid)'::regprocedure,
    'public.complete_guest_install_bonus_guarded(text,text,uuid)'::regprocedure
  ]) loop
    if has_function_privilege('anon', v_function::oid, 'EXECUTE')
       or has_function_privilege('authenticated', v_function::oid, 'EXECUTE')
       or not has_function_privilege('service_role', v_function::oid, 'EXECUTE') then
      raise exception 'TRIAL_FUNCTION_PERMISSION_FAILED';
    end if;
  end loop;

  raise exception 'LINKED_BONUS_RACE_ALL_ASSERTIONS_PASSED_ROLLBACK';
end;
$$;
