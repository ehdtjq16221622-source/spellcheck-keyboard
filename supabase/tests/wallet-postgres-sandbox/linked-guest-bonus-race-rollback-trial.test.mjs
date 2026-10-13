import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'

const migration = readFileSync(new URL('../../migrations/20261013071028_handle_linked_guest_bonus_race.sql', import.meta.url), 'utf8')
const rollback = readFileSync(new URL('../../sql/rollback_linked_guest_bonus_race.sql', import.meta.url), 'utf8')
const trial = readFileSync(new URL('./linked-guest-bonus-race-rollback-trial.sql', import.meta.url), 'utf8')

test('the exact trial SQL tests production-shaped rows and leaves no changes', async () => {
  const embedded = trial.split('-- Exact contents of 20261013071028_handle_linked_guest_bonus_race.sql begin.\n')[1]
    .split('-- Exact migration contents end.')[0].trim()
  assert.equal(embedded, migration.trim())

  const db = new PGlite()
  try {
    await db.exec(`
      create schema auth;
      create function auth.role() returns text language sql as $$ select 'service_role'::text $$;
      create role anon;
      create role authenticated;
      create role service_role;
      create table public.device_credits (
        device_id text primary key, credits integer not null default 5,
        last_reset_date date not null default current_date,
        free_credits integer not null default 100,
        paid_credits integer not null default 0,
        subscription_credits integer not null default 0,
        apple_user_id text, updated_at timestamptz not null default now()
      );
      create unique index device_credits_apple_user_id_key
        on public.device_credits(apple_user_id) where apple_user_id is not null;
      create table public.wallet_v2_credentials (
        wallet_id text primary key references public.device_credits(device_id),
        secret_hash text not null unique check (secret_hash ~ '^[0-9a-f]{64}$'),
        state text not null check (state in ('pending', 'active', 'linked'))
      );
      create table public.credit_transactions (
        id uuid primary key default gen_random_uuid(), device_id text not null,
        transaction_type text not null, idempotency_key text not null,
        free_delta integer not null default 0, paid_delta integer not null default 0,
        metadata jsonb not null default '{}'::jsonb,
        unique (transaction_type, idempotency_key)
      );
      create table public.credit_wallet_aliases (
        source_wallet_id text primary key, canonical_wallet_id text not null, apple_sub text not null
      );
      create table public.wallet_v2_link_attempts (
        wallet_id text not null, apple_sub text not null
      );
      create table public.guest_install_bonus_claims (
        wallet_id text primary key references public.wallet_v2_credentials(wallet_id),
        state text not null check (state in ('pending', 'granted')),
        verification_confirmed_at timestamptz, granted_at timestamptz
      );
      create table public.guest_bonus_devicecheck_lock (
        singleton boolean primary key, owner uuid, expires_at timestamptz
      );
    `)
    await db.exec(rollback.replace('drop function public.linked_apple_has_other_install_bonus(text, text);', ''))

    const signatures = [
      'public.reserve_guest_install_bonus(text,text)',
      'public.confirm_guest_install_bonus_devicecheck(text,text,uuid)',
      'public.complete_guest_install_bonus_guarded(text,text,uuid)',
    ]
    let localTrial = trial
    const productionHashes = [
      'cf187c073b7858b594766135c676fc56',
      '544614d70908ee6701a30c143bb30b3f',
      'd4bc3ce6625394e67b8537ed6c4836db',
    ]
    for (let i = 0; i < signatures.length; i++) {
      const { rows } = await db.query('select md5(pg_get_functiondef($1::regprocedure)) as hash', [signatures[i]])
      localTrial = localTrial.replace(productionHashes[i], rows[0].hash)
    }

    await assert.rejects(db.exec(localTrial), /LINKED_BONUS_RACE_ALL_ASSERTIONS_PASSED_ROLLBACK/)
    await db.exec('rollback')

    const { rows } = await db.query(`
      select to_regprocedure('public.linked_apple_has_other_install_bonus(text,text)') is null as helper_absent,
        (select count(*)::integer from public.device_credits
          where device_id like 'codex_linked_bonus_trial_%') as wallets,
        (select count(*)::integer from public.credit_transactions
          where device_id like 'codex_linked_bonus_trial_%') as transactions,
        (select count(*)::integer from public.guest_install_bonus_claims
          where wallet_id like 'codex_linked_bonus_trial_%') as claims
    `)
    assert.deepEqual(rows[0], { helper_absent: true, wallets: 0, transactions: 0, claims: 0 })
  } finally {
    await db.close()
  }
})
