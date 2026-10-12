-- Stage 1: attach an unprotected legacy wallet to one verified Apple subject.
-- No protection or session policy changes are made in this migration.
create schema if not exists wallet_ops;
revoke all on schema wallet_ops from public, anon, authenticated;

create table wallet_ops.legacy_apple_link_events (
  event_id bigint generated always as identity primary key,
  wallet_fingerprint text not null,
  apple_fingerprint text not null,
  linked_at timestamptz not null default clock_timestamp(),
  free_credits integer not null,
  paid_credits integer not null,
  subscription_credits integer not null
);
alter table wallet_ops.legacy_apple_link_events enable row level security;
revoke all on wallet_ops.legacy_apple_link_events from public, anon, authenticated;
revoke all on all sequences in schema wallet_ops from public, anon, authenticated;

create or replace function public.claim_unprotected_legacy_apple_wallet(
  p_device_id text,
  p_apple_sub text
)
returns table (
  decision text,
  free_credits integer,
  paid_credits integer,
  subscription_credits integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wallet public.device_credits%rowtype;
  v_existing_apple_id text;
  v_updated integer;
begin
  if p_device_id is null or p_apple_sub is null or
     length(p_device_id) = 0 or length(p_device_id) > 512 or
     length(p_apple_sub) = 0 or length(p_apple_sub) > 512 or
     left(p_device_id, 3) = 'v2:' then
    return query select 'protected'::text, 0, 0, 0;
    return;
  end if;

  -- Serialize claims for the same Apple subject without a global lock.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_apple_sub, 0));
  select d.* into v_wallet
  from public.device_credits d
  where d.device_id = p_device_id
  for update;
  if not found then
    return query select 'missing'::text, 0, 0, 0;
    return;
  end if;

  if exists (select 1 from public.credit_protected_wallets p
             where p.wallet_id in (p_device_id, p_apple_sub)) or
     exists (select 1 from public.credit_wallet_aliases a
             where a.source_wallet_id in (p_device_id, p_apple_sub)) then
    return query select 'protected'::text, 0, 0, 0;
    return;
  end if;

  if v_wallet.apple_user_id is not null and v_wallet.apple_user_id <> p_apple_sub then
    return query select 'other_owner'::text, 0, 0, 0;
    return;
  end if;

  select d.device_id into v_existing_apple_id
  from public.device_credits d where d.apple_user_id = p_apple_sub;
  if v_existing_apple_id is not null and v_existing_apple_id <> p_device_id then
    return query select 'apple_existing'::text, 0, 0, 0;
    return;
  end if;

  begin
    update public.device_credits d
    set apple_user_id = p_apple_sub
    where d.device_id = p_device_id and d.apple_user_id is null;
    get diagnostics v_updated = row_count;
  exception when unique_violation then
    return query select 'apple_existing'::text, 0, 0, 0;
    return;
  end;

  if v_updated = 0 then
    select d.* into v_wallet from public.device_credits d where d.device_id = p_device_id;
    if v_wallet.apple_user_id = p_apple_sub then
      return query select 'already_linked'::text,
        v_wallet.free_credits, v_wallet.paid_credits, v_wallet.subscription_credits;
    else
      return query select 'other_owner'::text, 0, 0, 0;
    end if;
    return;
  end if;

  select d.* into v_wallet from public.device_credits d where d.device_id = p_device_id;
  insert into wallet_ops.legacy_apple_link_events (
    wallet_fingerprint, apple_fingerprint,
    free_credits, paid_credits, subscription_credits
  ) values (
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_device_id, 'UTF8')), 'hex'),
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_apple_sub, 'UTF8')), 'hex'),
    v_wallet.free_credits, v_wallet.paid_credits, v_wallet.subscription_credits
  );

  return query select 'linked'::text,
    v_wallet.free_credits, v_wallet.paid_credits, v_wallet.subscription_credits;
end;
$$;

revoke all on function public.claim_unprotected_legacy_apple_wallet(text, text)
  from public, anon, authenticated;
grant execute on function public.claim_unprotected_legacy_apple_wallet(text, text)
  to service_role;

