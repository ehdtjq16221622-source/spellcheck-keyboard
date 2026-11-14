-- Android sign-up bonus: 500 free credits once per Google account.
-- iOS proves "one bonus per device" with Apple DeviceCheck; Android has no equivalent, so the
-- bonus is granted when a guest wallet is first linked to a Google account instead. The ledger
-- key 'google-signup:<subject>' is unique per transaction type, so one Google account can
-- never receive it twice, even across reinstalls, devices or wallets.

create or replace function public.grant_google_signup_bonus_once(
  p_wallet_id text,
  p_secret_hash text,
  p_google_sub text
) returns boolean
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_credential public.wallet_v2_credentials%rowtype;
  v_owner text;
  v_key text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  if p_google_sub is null or p_google_sub !~ '^google:[0-9A-Za-z_-]{1,255}$' then
    raise exception 'Invalid Google subject';
  end if;
  v_key := 'google-signup:' || p_google_sub;
  perform pg_advisory_xact_lock(hashtextextended(p_google_sub, 74891));

  select * into v_credential from public.wallet_v2_credentials
    where wallet_id = p_wallet_id for update;
  if not found or v_credential.secret_hash <> p_secret_hash or v_credential.state <> 'linked' then
    raise exception 'Wallet possession proof failed';
  end if;
  select apple_user_id into v_owner from public.device_credits
    where device_id = p_wallet_id for update;
  if not found or v_owner is distinct from p_google_sub then
    raise exception 'Wallet is not linked to this Google account';
  end if;

  if exists (select 1 from public.credit_transactions
      where transaction_type = 'install_bonus' and idempotency_key = v_key) then
    return false;
  end if;
  if exists (select 1 from public.credit_transactions
      where transaction_type in ('install_bonus', 'install_bonus_restore')
        and device_id = p_wallet_id) then
    return false;
  end if;
  if public.linked_apple_has_other_install_bonus(p_google_sub, p_wallet_id) then
    return false;
  end if;

  insert into public.credit_transactions (
    device_id, transaction_type, idempotency_key, free_delta, metadata
  ) values (
    p_wallet_id, 'install_bonus', v_key, 500,
    pg_catalog.jsonb_build_object('source', 'wallet_link_v2_google')
  );
  update public.device_credits
    set free_credits = free_credits + 500, updated_at = now()
    where device_id = p_wallet_id;
  return true;
end;
$function$;

revoke all on function public.grant_google_signup_bonus_once(text, text, text) from public, anon, authenticated;
grant execute on function public.grant_google_signup_bonus_once(text, text, text) to service_role;
