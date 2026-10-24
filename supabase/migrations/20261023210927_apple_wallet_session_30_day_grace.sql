-- Rotation only: normal API authorization still rejects expired tokens.
-- CREATE OR REPLACE preserves the existing owner and execute grants.
create or replace function public.rotate_apple_wallet_session(
  p_old_hash text,
  p_new_hash text,
  p_expires_at timestamptz
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old public.credit_wallet_sessions%rowtype;
  v_new public.credit_wallet_sessions%rowtype;
begin
  if p_old_hash is null or p_old_hash !~ '^[0-9a-f]{64}$'
     or p_new_hash is null or p_new_hash !~ '^[0-9a-f]{64}$'
     or p_old_hash = p_new_hash then
    raise exception 'Invalid session rotation';
  end if;
  select * into v_old from public.credit_wallet_sessions
    where token_hash = p_old_hash for update;
  if not found then raise exception 'Session is not active'; end if;
  if v_old.rotated_to_hash = p_new_hash then
    select * into v_new from public.credit_wallet_sessions
      where token_hash = p_new_hash;
    if found and v_new.wallet_id = v_old.wallet_id
       and v_new.apple_sub = v_old.apple_sub
       and v_new.revoked_at is null and v_new.expires_at > now() then
      return v_old.wallet_id;
    end if;
    raise exception 'Rotated session is unavailable';
  end if;
  if v_old.revoked_at is not null or v_old.expires_at <= now() - interval '30 days' then
    raise exception 'Session is not active';
  end if;
  if p_expires_at <= now() or p_expires_at > now() + interval '30 days' then
    raise exception 'Invalid session expiry';
  end if;
  if not exists (
    select 1 from public.device_credits
    where device_id = v_old.wallet_id and apple_user_id = v_old.apple_sub
  ) then
    raise exception 'Session wallet is no longer linked';
  end if;
  insert into public.credit_wallet_sessions
    (token_hash, wallet_id, apple_sub, expires_at)
    values (p_new_hash, v_old.wallet_id, v_old.apple_sub, p_expires_at);
  update public.credit_wallet_sessions
    set revoked_at = now(), rotated_to_hash = p_new_hash
    where token_hash = p_old_hash;
  return v_old.wallet_id;
end;
$$;
