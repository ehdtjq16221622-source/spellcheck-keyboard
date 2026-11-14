import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const expirySql = await readFile(new URL('../../migrations/20261106090000_expire_subscription_credits.sql', import.meta.url), 'utf8');
const v2Sql = await readFile(new URL('../../migrations/20261114110000_google_subscriptions_v2.sql', import.meta.url), 'utf8');
const BASIC = 'com.kingboard.app.monthly_basic';
const PRO = 'com.kingboard.app.monthly_pro';
const DAY = 86_400_000;

async function setup() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table public.device_credits(device_id text primary key, free_credits integer not null default 100,
      paid_credits integer not null default 0, subscription_credits integer not null default 0,
      apple_user_id text, last_reset_date date, updated_at timestamptz not null default now());
    create table public.credit_transactions(id uuid primary key default gen_random_uuid(), device_id text not null,
      transaction_type text not null, idempotency_key text not null, free_delta integer not null default 0,
      paid_delta integer not null default 0, metadata jsonb not null default '{}', created_at timestamptz not null default now(),
      unique(transaction_type, idempotency_key));
    create table public.credit_wallet_aliases(source_wallet_id text primary key, canonical_wallet_id text not null,
      apple_sub text not null);
    create table public.device_subscriptions(device_id text primary key, product_id text not null, purchase_token text not null,
      subscription_state text not null, expiry_time_millis bigint, latest_order_id text, last_cycle_key text,
      last_verified_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
    create unique index device_subscriptions_purchase_token_idx on public.device_subscriptions(purchase_token);
    insert into public.device_credits(device_id, free_credits, paid_credits, apple_user_id) values
      ('v2:g', 50, 7000, 'google:1'), ('v2:h', 0, 0, 'google:2');
  `);
  await db.exec(expirySql);
  await db.exec(v2Sql);
  return db;
}

const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const sync = (db, { wallet = 'v2:g', product = BASIC, token = 'tokA', linked = null, state = 'SUBSCRIPTION_STATE_ACTIVE',
  expiry, amount = 4000, verified = true, cycle } = {}) =>
  one(db, 'select * from public.sync_google_subscription_v2_once($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [wallet, product, token, linked,
    state, expiry, 'GPA.1-1', cycle ?? (state === 'SUBSCRIPTION_STATE_ACTIVE' ? `${token}:${product}:${expiry}` : null), amount,
    JSON.stringify(verified ? { google_purchase_verified: true } : {})]);
const credits = (db, id = 'v2:g') => one(db, 'select free_credits, paid_credits, subscription_credits from public.device_credits where device_id=$1', [id]);
const rejects = (promise, text) => assert.rejects(promise, (e) => e.message.includes(text), text);

test('one grant per billing cycle, sets subscription credits, never touches free or pack credits', async () => {
  const db = await setup();
  try {
    const e1 = Date.now() + 30 * DAY;
    assert.equal((await sync(db, { expiry: e1 })).applied, true);
    assert.equal((await sync(db, { expiry: e1 })).applied, false, 'same cycle is a no-op');
    assert.deepEqual(await credits(db), { free_credits: 50, paid_credits: 7000, subscription_credits: 4000 });
    await db.query(`update public.device_credits set subscription_credits = 120 where device_id = 'v2:g'`);
    const e2 = e1 + 30 * DAY;
    assert.equal((await sync(db, { expiry: e2 })).applied, true, 'renewal');
    assert.deepEqual(await credits(db), { free_credits: 50, paid_credits: 7000, subscription_credits: 4000 });
    await rejects(sync(db, { expiry: e1 }), 'stale Google subscription transaction');
  } finally { await db.close(); }
});

test('an upgrade moves to the new token only when Google linked it to the wallet token', async () => {
  const db = await setup();
  try {
    const e1 = Date.now() + 30 * DAY;
    await sync(db, { expiry: e1 });
    await rejects(sync(db, { token: 'tokB', product: PRO, expiry: e1 + DAY, amount: 30000 }), 'token change requires review');
    await rejects(sync(db, { token: 'tokB', linked: 'other', product: PRO, expiry: e1 + DAY, amount: 30000 }), 'token change requires review');
    const r = await sync(db, { token: 'tokB', linked: 'tokA', product: PRO, expiry: e1 - DAY, amount: 30000 });
    assert.equal(r.applied, true);
    assert.equal((await credits(db)).subscription_credits, 30000);
    const row = await one(db, `select purchase_token, product_id from public.device_subscriptions where device_id = 'v2:g'`);
    assert.deepEqual(row, { purchase_token: 'tokB', product_id: PRO });
  } finally { await db.close(); }
});

test('one purchase token never serves two wallets, and a cycle cannot be granted twice across wallets', async () => {
  const db = await setup();
  try {
    const e1 = Date.now() + 30 * DAY;
    await sync(db, { expiry: e1 });
    await rejects(sync(db, { wallet: 'v2:h', expiry: e1 + DAY }), 'owner transfer requires review');
  } finally { await db.close(); }
});

test('active syncs need a verified, well-formed cycle; unknown plans and old products are refused', async () => {
  const db = await setup();
  try {
    const e1 = Date.now() + 30 * DAY;
    await rejects(sync(db, { expiry: e1, verified: false }), 'requires a verified cycle');
    await rejects(sync(db, { expiry: e1, cycle: 'tokA:x:1' }), 'requires a verified cycle');
    await rejects(sync(db, { expiry: e1, product: 'kingboard_monthly_500' }), 'invalid Google subscription input');
    await rejects(sync(db, { expiry: e1, token: 'tok:A' }), 'invalid Google subscription input');
    await rejects(sync(db, { expiry: e1, state: 'SUBSCRIPTION_STATE_CANCELED' }), 'invalid Google subscription input');
    assert.equal((await credits(db)).subscription_credits, 0);
  } finally { await db.close(); }
});

test('grace keeps credits without a new grant; final expiry clears subscription credits only', async () => {
  const db = await setup();
  try {
    const e1 = Date.now() + 30 * DAY;
    await sync(db, { expiry: e1 });
    const grace = await sync(db, { state: 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD', expiry: e1 + 3 * DAY });
    assert.equal(grace.applied, false);
    assert.equal((await credits(db)).subscription_credits, 4000);

    // A cycle that ended: the sync records EXPIRED, then the expiry call clears that cycle's leftovers.
    const past = Date.now() - DAY;
    await sync(db, { wallet: 'v2:h', token: 'tokH', expiry: past });
    await sync(db, { wallet: 'v2:h', token: 'tokH', state: 'SUBSCRIPTION_STATE_EXPIRED', expiry: past });
    assert.deepEqual(await one(db, 'select * from public.expire_google_subscription_credits($1,$2,$3)', ['tokH', past, 'n1']),
      { result: 'cleared', cleared: 4000 });
    assert.deepEqual(await one(db, 'select * from public.expire_google_subscription_credits($1,$2,$3)', ['tokH', past, 'n1']),
      { result: 'nothing_to_clear', cleared: 0 });
    assert.deepEqual(await credits(db, 'v2:h'), { free_credits: 0, paid_credits: 0, subscription_credits: 0 });
    // The still-active wallet is untouched, and its renewed cycle is protected from a late expiry.
    assert.equal((await one(db, 'select * from public.expire_google_subscription_credits($1,$2,$3)', ['tokA', e1, 'n2'])).result,
      'not_expired');
    assert.equal((await credits(db)).subscription_credits, 4000);
  } finally { await db.close(); }
});

test('only service_role may call the Google subscription functions', async () => {
  const db = await setup();
  try {
    const sig = 'public.sync_google_subscription_v2_once(text, text, text, text, text, bigint, text, text, integer, jsonb)';
    for (const role of ['anon', 'authenticated']) {
      assert.equal((await one(db, `select has_function_privilege($1, '${sig}', 'execute') x`, [role])).x, false);
    }
    assert.equal((await one(db, `select has_function_privilege('service_role', '${sig}', 'execute') x`)).x, true);
  } finally { await db.close(); }
});
