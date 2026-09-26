-- Additive, disabled-by-default wallet linking primitives. These never touch
-- legacy wallets and do not grant installation credits.
create table if not exists public.wallet_v2_credentials (
  wallet_id text primary key references public.device_credits(device_id) on delete restrict,
  secret_hash text not null unique check (secret_hash ~ '^[0-9a-f]{64}$'),
  state text not null default 'pending' check (state in ('pending', 'active', 'linked')),
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  linked_at timestamptz
);

create table if not exists public.wallet_v2_link_attempts (
  wallet_id text not null references public.wallet_v2_credentials(wallet_id) on delete restrict,
  idempotency_key text not null,
  apple_sub text not null,
  decision text not null check (decision in ('linked', 'apple_existing_unmerged')),
  canonical_wallet_id text not null,
  created_at timestamptz not null default now(),
  primary key (wallet_id, idempotency_key)
);

create index if not exists wallet_v2_link_attempts_apple_sub_idx
  on public.wallet_v2_link_attempts (apple_sub, created_at desc);

alter table public.wallet_v2_credentials enable row level security;
alter table public.wallet_v2_link_attempts enable row level security;
revoke all on public.wallet_v2_credentials from public, anon, authenticated;
revoke all on public.wallet_v2_link_attempts from public, anon, authenticated;

create or replace function public.register_guest_wallet_v2(p_secret_hash text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wallet_id text := 'v2:' || gen_random_uuid()::text;
begin
  if p_secret_hash is null or p_secret_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid wallet secret verifier';
  end if;

  insert into public.device_credits (
    device_id, credits, free_credits, paid_credits, subscription_credits, last_reset_date
  ) values (v_wallet_id, 0, 0, 0, 0, current_date);
  insert into public.wallet_v2_credentials (wallet_id, secret_hash)
  values (v_wallet_id, p_secret_hash);
  return v_wallet_id;
end;
$$;

create or replace function public.activate_guest_wallet_v2(
  p_wallet_id text,
  p_secret_hash text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_credential public.wallet_v2_credentials%rowtype;
begin
  select * into v_credential from public.wallet_v2_credentials
    where wallet_id = p_wallet_id for update;
  if not found or v_credential.secret_hash <> p_secret_hash then
    raise exception 'Wallet possession proof failed';
  end if;
  if v_credential.state <> 'pending' then return false; end if;

  update public.wallet_v2_credentials
    set state = 'active', activated_at = now()
    where wallet_id = p_wallet_id;
  return true;
end;
$$;

-- Caller must verify the Apple JWT and pass its verified `sub`, never a
-- client-provided Apple ID. This function is one Postgres transaction.
create or replace function public.link_apple_wallet_v2(
  p_wallet_id text,
  p_secret_hash text,
  p_apple_sub text,
  p_idempotency_key text
)
returns table (decision text, canonical_wallet_id text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_credential public.wallet_v2_credentials%rowtype;
  v_attempt public.wallet_v2_link_attempts%rowtype;
  v_source_owner text;
  v_apple_wallet_id text;
  v_decision text;
  v_canonical text;
begin
  if p_apple_sub is null or p_apple_sub <> btrim(p_apple_sub)
     or length(p_apple_sub) = 0 or length(p_apple_sub) > 512 then
    raise exception 'Invalid Apple subject';
  end if;
  if p_idempotency_key is null or p_idempotency_key <> btrim(p_idempotency_key)
     or length(p_idempotency_key) = 0 or length(p_idempotency_key) > 128 then
    raise exception 'Invalid idempotency key';
  end if;

  -- Serialize attempts for the same Apple subject, including the case where
  -- no Apple wallet row exists yet.
  perform pg_advisory_xact_lock(hashtextextended(p_apple_sub, 74891));
  select * into v_credential from public.wallet_v2_credentials
    where wallet_id = p_wallet_id for update;
  if not found or v_credential.secret_hash <> p_secret_hash
     or v_credential.state = 'pending' then
    raise exception 'Wallet possession proof failed';
  end if;

  select * into v_attempt from public.wallet_v2_link_attempts
    where wallet_id = p_wallet_id and idempotency_key = p_idempotency_key;
  if found then
    if v_attempt.apple_sub <> p_apple_sub then
      raise exception 'Idempotency key belongs to another Apple subject';
    end if;
    return query select v_attempt.decision, v_attempt.canonical_wallet_id;
    return;
  end if;

  select apple_user_id into v_source_owner from public.device_credits
    where device_id = p_wallet_id for update;
  if not found then raise exception 'Wallet row missing'; end if;
  if v_source_owner is not null and v_source_owner <> p_apple_sub then
    raise exception 'Wallet already linked to another Apple subject';
  end if;

  select device_id into v_apple_wallet_id from public.device_credits
    where apple_user_id = p_apple_sub for update;
  if found and v_apple_wallet_id <> p_wallet_id then
    -- Do not combine, delete, or silently discard the guest balance. The app
    -- can sign in to the existing Apple wallet separately; guest stays intact.
    v_decision := 'apple_existing_unmerged';
    v_canonical := v_apple_wallet_id;
  else
    update public.device_credits
      set apple_user_id = p_apple_sub, updated_at = now()
      where device_id = p_wallet_id;
    update public.wallet_v2_credentials
      set state = 'linked', linked_at = coalesce(linked_at, now())
      where wallet_id = p_wallet_id;
    v_decision := 'linked';
    v_canonical := p_wallet_id;
  end if;

  insert into public.wallet_v2_link_attempts (
    wallet_id, idempotency_key, apple_sub, decision, canonical_wallet_id
  ) values (p_wallet_id, p_idempotency_key, p_apple_sub, v_decision, v_canonical);
  return query select v_decision, v_canonical;
end;
$$;

revoke all on function public.register_guest_wallet_v2(text) from public, anon, authenticated;
revoke all on function public.activate_guest_wallet_v2(text, text) from public, anon, authenticated;
revoke all on function public.link_apple_wallet_v2(text, text, text, text) from public, anon, authenticated;
grant execute on function public.register_guest_wallet_v2(text) to service_role;
grant execute on function public.activate_guest_wallet_v2(text, text) to service_role;
grant execute on function public.link_apple_wallet_v2(text, text, text, text) to service_role;
