-- Review before executing. Submit this entire file in ONE execute_sql request.
-- The final intentional exception rolls back the temporary migration and all fake rows.
begin;
set local lock_timeout = '1s';
set local statement_timeout = '10s';

-- Exact migration under test, kept inside the transaction.
alter table public.wallet_v2_credentials
  add column bonus_failure_reason text
    check (bonus_failure_reason in (
      'no_device_token', 'lock_busy', 'devicecheck_unavailable',
      'device_already_marked', 'claim_needs_review'
    )),
  add column bonus_reason_recorded_at timestamptz;

create or replace function public.record_guest_bonus_outcome(
  p_wallet_id text, p_secret_hash text, p_reason text
) returns text language plpgsql security definer set search_path = '' as $$
declare
  v_credential public.wallet_v2_credentials%rowtype;
  v_status text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  if p_reason is not null and p_reason not in (
    'no_device_token', 'lock_busy', 'devicecheck_unavailable',
    'device_already_marked', 'claim_needs_review'
  ) then raise exception 'Invalid bonus reason'; end if;
  select * into v_credential from public.wallet_v2_credentials
    where wallet_id = p_wallet_id for update;
  if not found or v_credential.secret_hash <> p_secret_hash
     or v_credential.state not in ('pending', 'active') then
    raise exception 'Wallet possession proof failed';
  end if;
  if exists (select 1 from public.credit_transactions
      where device_id = p_wallet_id
        and transaction_type in ('install_bonus', 'install_bonus_restore')) then
    p_reason := null;
    v_status := 'complete';
  elsif p_reason = 'device_already_marked' then
    v_status := 'complete';
  elsif p_reason = 'claim_needs_review' or p_reason is null then
    p_reason := 'claim_needs_review';
    v_status := 'needs_review';
  else
    v_status := 'verification_pending';
  end if;
  update public.wallet_v2_credentials
    set bonus_failure_reason = p_reason, bonus_reason_recorded_at = now()
    where wallet_id = p_wallet_id;
  return v_status;
end;
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
     or v_credential.state not in ('pending', 'active') then
    raise exception 'Wallet possession proof failed';
  end if;
  select apple_user_id into v_owner from public.device_credits
    where device_id = p_wallet_id for update;
  if not found or v_owner is not null then raise exception 'Guest wallet required'; end if;
  if exists (select 1 from public.credit_transactions
      where transaction_type in ('install_bonus', 'install_bonus_restore')
        and device_id = p_wallet_id) then
    return 'granted';
  end if;
  insert into public.guest_install_bonus_claims(wallet_id, state)
    values (p_wallet_id, 'pending') on conflict (wallet_id) do nothing;
  select state into v_state from public.guest_install_bonus_claims
    where wallet_id = p_wallet_id;
  return v_state;
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
     or v_credential.state not in ('pending', 'active') then
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
  if not found or v_owner is not null then raise exception 'Guest wallet required'; end if;
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

revoke all on function public.record_guest_bonus_outcome(text, text, text)
  from public, anon, authenticated;
grant execute on function public.record_guest_bonus_outcome(text, text, text)
  to service_role;

do $test$
declare
  v_secret text := repeat(md5(gen_random_uuid()::text), 2);
  v_restore_secret text := repeat(md5(gen_random_uuid()::text), 2);
  v_reason_secret text := repeat(md5(gen_random_uuid()::text), 2);
  v_linked_secret text := repeat(md5(gen_random_uuid()::text), 2);
  v_wallet text;
  v_restore_wallet text;
  v_reason_wallet text;
  v_linked_wallet text;
  v_lock uuid := gen_random_uuid();
begin
  perform set_config('request.jwt.claim.role', 'service_role', true);
  v_wallet := public.register_guest_wallet_v2(v_secret, 0);
  v_restore_wallet := public.register_guest_wallet_v2(v_restore_secret, 0);
  v_reason_wallet := public.register_guest_wallet_v2(v_reason_secret, 0);
  v_linked_wallet := public.register_guest_wallet_v2(v_linked_secret, 0);

  if not public.acquire_guest_bonus_devicecheck_lock(v_lock) then
    raise exception 'P0_TEST_LOCK_BUSY';
  end if;
  if public.reserve_guest_install_bonus(v_wallet, v_secret) <> 'pending'
     or not public.confirm_guest_install_bonus_devicecheck(v_wallet, v_secret, v_lock)
     or not public.complete_guest_install_bonus_guarded(v_wallet, v_secret, v_lock)
     or public.complete_guest_install_bonus_guarded(v_wallet, v_secret, v_lock) then
    raise exception 'P0_TEST_NORMAL_GRANT_FAILED';
  end if;
  if (select free_credits from public.device_credits where device_id = v_wallet) <> 500
     or (select count(*) from public.credit_transactions
           where device_id = v_wallet and transaction_type = 'install_bonus') <> 1
     or public.reserve_guest_install_bonus(v_wallet, v_secret) <> 'granted' then
    raise exception 'P0_TEST_DUPLICATE_GRANT';
  end if;

  insert into public.credit_transactions
    (device_id, transaction_type, idempotency_key, free_delta)
    values (v_restore_wallet, 'install_bonus_restore', 'p0-test:' || v_restore_wallet, 500);
  update public.device_credits set free_credits = 500 where device_id = v_restore_wallet;
  if public.reserve_guest_install_bonus(v_restore_wallet, v_restore_secret) <> 'granted'
     or public.complete_guest_install_bonus_guarded(v_restore_wallet, v_restore_secret, v_lock)
     or (select free_credits from public.device_credits where device_id = v_restore_wallet) <> 500
     or (select count(*) from public.credit_transactions
           where device_id = v_restore_wallet and transaction_type = 'install_bonus') <> 0 then
    raise exception 'P0_TEST_RESTORE_DUPLICATE';
  end if;

  if public.record_guest_bonus_outcome(v_reason_wallet, v_reason_secret, 'lock_busy') <> 'verification_pending'
     or (select bonus_failure_reason from public.wallet_v2_credentials where wallet_id = v_reason_wallet) <> 'lock_busy'
     or public.record_guest_bonus_outcome(v_reason_wallet, v_reason_secret, 'no_device_token') <> 'verification_pending'
     or public.record_guest_bonus_outcome(v_reason_wallet, v_reason_secret, 'devicecheck_unavailable') <> 'verification_pending'
     or public.record_guest_bonus_outcome(v_reason_wallet, v_reason_secret, 'device_already_marked') <> 'complete'
     or public.record_guest_bonus_outcome(v_reason_wallet, v_reason_secret, 'claim_needs_review') <> 'needs_review'
     or (select bonus_failure_reason from public.wallet_v2_credentials where wallet_id = v_reason_wallet) <> 'claim_needs_review'
     or public.record_guest_bonus_outcome(v_wallet, v_secret, 'lock_busy') <> 'complete'
     or (select bonus_failure_reason from public.wallet_v2_credentials where wallet_id = v_wallet) is not null then
    raise exception 'P0_TEST_REASON_STATUS';
  end if;

  update public.device_credits set apple_user_id = 'p0-test-only' where device_id = v_linked_wallet;
  begin
    perform public.reserve_guest_install_bonus(v_linked_wallet, v_linked_secret);
    raise exception 'P0_TEST_LINKED_WALLET_NOT_BLOCKED';
  exception when raise_exception then
    if sqlerrm <> 'Guest wallet required' then raise; end if;
  end;

  raise exception 'P0_TEST_ALL_ASSERTIONS_PASSED_ROLLBACK';
end;
$test$;
