-- Review before executing. Run this whole file as one SQL request.
-- The snapshot is data-only; the original live function definitions are in live-v48-bonus-rpcs.sql.
begin isolation level repeatable read;
set local lock_timeout = '3s';
create schema ops_backup authorization postgres;
revoke all on schema ops_backup from public, anon, authenticated, service_role;

create table ops_backup.wallet_v2_credentials_pre_p0 as
  select * from public.wallet_v2_credentials;
create table ops_backup.guest_install_bonus_claims_pre_p0 as
  select * from public.guest_install_bonus_claims;
revoke all on all tables in schema ops_backup from public, anon, authenticated, service_role;

do $check$
begin
  if has_schema_privilege('anon', 'ops_backup', 'USAGE')
     or has_schema_privilege('authenticated', 'ops_backup', 'USAGE')
     or has_schema_privilege('service_role', 'ops_backup', 'USAGE')
     or has_table_privilege('anon', 'ops_backup.wallet_v2_credentials_pre_p0', 'SELECT')
     or has_table_privilege('authenticated', 'ops_backup.wallet_v2_credentials_pre_p0', 'SELECT')
     or has_table_privilege('anon', 'ops_backup.guest_install_bonus_claims_pre_p0', 'SELECT')
     or has_table_privilege('authenticated', 'ops_backup.guest_install_bonus_claims_pre_p0', 'SELECT') then
    raise exception 'Backup schema grants are too broad';
  end if;
  if (select count(*) from ops_backup.wallet_v2_credentials_pre_p0)
       <> (select count(*) from public.wallet_v2_credentials)
     or (select count(*) from ops_backup.guest_install_bonus_claims_pre_p0)
       <> (select count(*) from public.guest_install_bonus_claims) then
    raise exception 'Backup row counts changed during snapshot';
  end if;
end;
$check$;
commit;

-- Counts and privileges only; never select secret_hash or raw wallet IDs for reporting.
select 'wallet_v2_credentials' as table_name, count(*) as backed_up_rows
  from ops_backup.wallet_v2_credentials_pre_p0
union all
select 'guest_install_bonus_claims', count(*)
  from ops_backup.guest_install_bonus_claims_pre_p0;
