-- Apply before deploying the matching wallet_link_v2 bundle. Service role only.
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

-- Keep the existing proof, ownership, and row locks; a restored wallet is
-- terminal even if its DeviceCheck claim is missing.
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
