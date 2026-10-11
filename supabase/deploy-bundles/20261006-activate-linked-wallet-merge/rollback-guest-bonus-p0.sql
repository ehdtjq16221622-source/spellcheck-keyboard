-- Run only after redeploying the exact pre-P0 wallet_link_v2 v48 bundle.
-- Retain the install_bonus_restore guard in the existing bonus RPCs: reverting
-- that guard could allow a restored wallet to receive another 500 on retry.
begin;
revoke all on function public.record_guest_bonus_outcome(text, text, text)
  from public, anon, authenticated, service_role;
drop function public.record_guest_bonus_outcome(text, text, text);
alter table public.wallet_v2_credentials
  drop column bonus_failure_reason,
  drop column bonus_reason_recorded_at;
commit;
