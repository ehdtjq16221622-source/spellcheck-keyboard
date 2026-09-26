-- Register one wallet per locally persisted secret. The edge function chooses
-- either the new-install bonus or a zero-bonus post-logout wallet.
create or replace function public.register_guest_wallet_v2(
  p_secret_hash text,
  p_initial_bonus integer
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wallet_id text;
begin
  if p_secret_hash is null or p_secret_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid wallet secret verifier';
  end if;
  if p_initial_bonus not in (0, 500) or p_initial_bonus is null then
    raise exception 'Invalid installation credit amount';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_secret_hash, 74901));
  select wallet_id into v_wallet_id from public.wallet_v2_credentials
    where secret_hash = p_secret_hash;
  if found then return v_wallet_id; end if;

  v_wallet_id := 'v2:' || gen_random_uuid()::text;
  insert into public.device_credits (
    device_id, credits, free_credits, paid_credits, subscription_credits, last_reset_date
  ) values (v_wallet_id, p_initial_bonus, p_initial_bonus, 0, 0, current_date);
  insert into public.wallet_v2_credentials (wallet_id, secret_hash)
    values (v_wallet_id, p_secret_hash);
  if p_initial_bonus > 0 then
    insert into public.credit_transactions (
      device_id, transaction_type, idempotency_key, free_delta, metadata
    ) values (
      v_wallet_id, 'install_bonus', v_wallet_id, p_initial_bonus,
      jsonb_build_object('source', 'wallet_link_v2')
    );
  end if;
  return v_wallet_id;
end;
$$;

revoke all on function public.register_guest_wallet_v2(text, integer)
  from public, anon, authenticated;
grant execute on function public.register_guest_wallet_v2(text, integer)
  to service_role;
