-- Prepare a guest's install bonus before marking the device as used.
-- This remains unused until WALLET_DEVICECHECK_BONUS_ENABLED is enabled.
create table if not exists public.guest_install_bonus_claims (
  wallet_id text primary key references public.wallet_v2_credentials(wallet_id) on delete restrict,
  state text not null check (state in ('pending', 'granted')),
  created_at timestamptz not null default now(),
  granted_at timestamptz
);

alter table public.guest_install_bonus_claims enable row level security;
revoke all on public.guest_install_bonus_claims from public, anon, authenticated;

create or replace function public.reserve_guest_install_bonus(
  p_wallet_id text, p_secret_hash text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_credential public.wallet_v2_credentials%rowtype;
  v_owner text;
  v_state text;
begin
  select * into v_credential from public.wallet_v2_credentials
    where wallet_id = p_wallet_id for update;
  if not found or v_credential.secret_hash <> p_secret_hash
     or v_credential.state <> 'pending' then
    raise exception 'Wallet possession proof failed';
  end if;
  select apple_user_id into v_owner from public.device_credits
    where device_id = p_wallet_id for update;
  if not found or v_owner is not null then
    raise exception 'Guest wallet required';
  end if;
  if exists (select 1 from public.credit_transactions
      where transaction_type = 'install_bonus' and device_id = p_wallet_id) then
    return 'granted';
  end if;
  insert into public.guest_install_bonus_claims (wallet_id, state)
    values (p_wallet_id, 'pending') on conflict (wallet_id) do nothing;
  select state into v_state from public.guest_install_bonus_claims
    where wallet_id = p_wallet_id;
  return v_state;
end;
$$;

create or replace function public.complete_guest_install_bonus(
  p_wallet_id text, p_secret_hash text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_credential public.wallet_v2_credentials%rowtype;
  v_state text;
  v_owner text;
begin
  select * into v_credential from public.wallet_v2_credentials
    where wallet_id = p_wallet_id for update;
  if not found or v_credential.secret_hash <> p_secret_hash then
    raise exception 'Wallet possession proof failed';
  end if;
  select state into v_state from public.guest_install_bonus_claims
    where wallet_id = p_wallet_id for update;
  if not found or v_state = 'granted' then return false; end if;
  if v_credential.state <> 'pending' then
    raise exception 'Pending guest wallet required';
  end if;
  select apple_user_id into v_owner from public.device_credits
    where device_id = p_wallet_id for update;
  if not found or v_owner is not null then
    raise exception 'Guest wallet required';
  end if;

  insert into public.credit_transactions (
    device_id, transaction_type, idempotency_key, free_delta, metadata
  ) values (
    p_wallet_id, 'install_bonus', p_wallet_id, 500,
    jsonb_build_object('source', 'wallet_link_v2_devicecheck')
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

revoke all on function public.reserve_guest_install_bonus(text, text)
  from public, anon, authenticated;
revoke all on function public.complete_guest_install_bonus(text, text)
  from public, anon, authenticated;
grant execute on function public.reserve_guest_install_bonus(text, text)
  to service_role;
grant execute on function public.complete_guest_install_bonus(text, text)
  to service_role;
