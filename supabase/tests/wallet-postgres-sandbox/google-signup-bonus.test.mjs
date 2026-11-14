import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const bonusSql = await readFile(new URL('../../migrations/20261114120000_google_signup_bonus.sql', import.meta.url), 'utf8');
const S = 'a'.repeat(64);

async function setup(role = 'service_role') {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.role() returns text language sql as $$ select '${role}'::text $$;
    create table public.device_credits(device_id text primary key, free_credits integer not null default 0,
      paid_credits integer not null default 0, apple_user_id text, updated_at timestamptz not null default now());
    create unique index device_credits_apple_user_id_key on public.device_credits(apple_user_id) where apple_user_id is not null;
    create table public.credit_transactions(id uuid primary key default gen_random_uuid(), device_id text not null,
      transaction_type text not null, idempotency_key text not null, free_delta integer not null default 0,
      paid_delta integer not null default 0, metadata jsonb not null default '{}', created_at timestamptz not null default now(),
      unique(transaction_type, idempotency_key));
    create table public.wallet_v2_credentials(wallet_id text primary key, secret_hash text not null, state text not null);
    create table public.credit_wallet_aliases(source_wallet_id text primary key, canonical_wallet_id text not null, apple_sub text not null);
    create table public.wallet_v2_link_attempts(wallet_id text, idempotency_key text, apple_sub text);
    create function public.linked_apple_has_other_install_bonus(p_apple_sub text, p_wallet_id text) returns boolean
    language sql set search_path to '' as $f$
      select exists (select 1 from (
        select d.device_id as wallet_id from public.device_credits d where d.apple_user_id = p_apple_sub
        union select a.source_wallet_id from public.credit_wallet_aliases a where a.apple_sub = p_apple_sub
        union select l.wallet_id from public.wallet_v2_link_attempts l where l.apple_sub = p_apple_sub
        union select p_apple_sub) owned
      join public.credit_transactions t on t.device_id = owned.wallet_id
      where owned.wallet_id <> p_wallet_id and t.transaction_type in ('install_bonus', 'install_bonus_restore'));
    $f$;
    insert into public.device_credits(device_id, apple_user_id) values
      ('v2:g1', 'google:111'), ('v2:g2', null), ('v2:apple', 'apple-a');
    insert into public.wallet_v2_credentials values
      ('v2:g1', '${S}', 'linked'), ('v2:g2', '${S}', 'active'), ('v2:apple', '${S}', 'linked');
  `);
  await db.exec(bonusSql);
  return db;
}

const grant = async (db, wallet, sub, secret = S) =>
  (await db.query('select public.grant_google_signup_bonus_once($1,$2,$3) g', [wallet, secret, sub])).rows[0].g;
const free = async (db, wallet) =>
  (await db.query('select free_credits f from public.device_credits where device_id=$1', [wallet])).rows[0].f;
const rejects = (promise, text) => assert.rejects(promise, (e) => e.message.includes(text), text);

test('a Google account gets the 500 sign-up bonus exactly once', async () => {
  const db = await setup();
  try {
    assert.equal(await grant(db, 'v2:g1', 'google:111'), true);
    assert.equal(await grant(db, 'v2:g1', 'google:111'), false);
    assert.equal(await free(db, 'v2:g1'), 500);
    const row = (await db.query(`select idempotency_key k, metadata->>'source' s from public.credit_transactions`)).rows;
    assert.deepEqual(row, [{ k: 'google-signup:google:111', s: 'wallet_link_v2_google' }]);
  } finally { await db.close(); }
});

test('the same Google account on a second wallet (reinstall, new device) gets nothing', async () => {
  const db = await setup();
  try {
    assert.equal(await grant(db, 'v2:g1', 'google:111'), true);
    // Simulate a later wallet for the same account: the first wallet was merged away and the
    // account now owns a new guest wallet.
    await db.exec(`update public.device_credits set apple_user_id = null where device_id = 'v2:g1';
      update public.device_credits set apple_user_id = 'google:111' where device_id = 'v2:g2';
      update public.wallet_v2_credentials set state = 'linked' where wallet_id = 'v2:g2';`);
    assert.equal(await grant(db, 'v2:g2', 'google:111'), false);
    assert.equal(await free(db, 'v2:g2'), 0);
  } finally { await db.close(); }
});

test('a wallet that already had an install bonus does not get a second one', async () => {
  const db = await setup();
  try {
    await db.exec(`insert into public.credit_transactions(device_id, transaction_type, idempotency_key, free_delta)
      values ('v2:g1', 'install_bonus', 'v2:g1', 500)`);
    assert.equal(await grant(db, 'v2:g1', 'google:111'), false);
  } finally { await db.close(); }
});

test('only the linked owner with the wallet secret, a Google subject and the service role can claim', async () => {
  const db = await setup();
  try {
    await rejects(grant(db, 'v2:g1', 'google:111', 'b'.repeat(64)), 'Wallet possession proof failed');
    await rejects(grant(db, 'v2:g2', 'google:111'), 'Wallet possession proof failed');
    await rejects(grant(db, 'v2:g1', 'google:999'), 'not linked to this Google account');
    await rejects(grant(db, 'v2:apple', 'apple-a'), 'Invalid Google subject');
    assert.equal(await free(db, 'v2:g1'), 0);
  } finally { await db.close(); }
  const anon = await setup('anon');
  try {
    await rejects(grant(anon, 'v2:g1', 'google:111'), 'Service role required');
  } finally { await anon.close(); }
});
