-- Referral policy as shown in the app: up to 5 rewarded invites per account, 100 credits for each side.
-- Before this the server allowed 10 invites and gave the inviter 200 (1 referral was completed under the old values).
begin;
alter table public.referrals alter column inviter_reward set default 100;
alter table public.referrals alter column invitee_reward set default 100;
-- Not yet completed invites follow the new amounts too.
update public.referrals set inviter_reward = 100 where status <> 'completed' and inviter_reward <> 100;
CREATE OR REPLACE FUNCTION public.register_referral(p_invitee_id text, p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_code text := upper(trim(p_code));
  v_inviter_id text;
  v_existing public.referrals%rowtype;
  v_count integer;
  v_created public.referrals%rowtype;
begin
  if p_invitee_id is null or length(trim(p_invitee_id)) = 0 then
    raise exception 'LOGIN_REQUIRED';
  end if;

  if not exists (
    select 1
    from public.device_credits
    where device_id = p_invitee_id
      and apple_user_id = p_invitee_id
  ) then
    raise exception 'LOGIN_REQUIRED';
  end if;

  select owner_id
    into v_inviter_id
  from public.referral_codes
  where code = v_code
  for update;

  if v_inviter_id is null then
    raise exception 'INVALID_CODE';
  end if;

  if v_inviter_id = p_invitee_id then
    raise exception 'SELF_REFERRAL';
  end if;

  select *
    into v_existing
  from public.referrals
  where invitee_id = p_invitee_id;

  if found then
    return jsonb_build_object(
      'registered', true,
      'already_registered', true,
      'status', v_existing.status,
      'referral_code', v_existing.referral_code
    );
  end if;

  select count(*)
    into v_count
  from public.referrals
  where inviter_id = v_inviter_id;

  if v_count >= 5 then
    raise exception 'INVITE_LIMIT_REACHED';
  end if;

  insert into public.referrals (
    inviter_id,
    invitee_id,
    referral_code
  )
  values (
    v_inviter_id,
    p_invitee_id,
    v_code
  )
  returning * into v_created;

  return jsonb_build_object(
    'registered', true,
    'already_registered', false,
    'status', v_created.status,
    'referral_code', v_created.referral_code
  );
end;
$function$;
commit;
