import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const packSql = await readFile(new URL('../../migrations/20261111090000_credit_packs.sql', import.meta.url), 'utf8');
const googleSql = await readFile(new URL('../../migrations/20261114100000_google_accounts_and_play_packs.sql', import.meta.url), 'utf8');
const P7 = 'com.kingboard.app.credits_7000';
const P18 = 'com.kingboard.app.credits_18000';
const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
const H3 = 'c'.repeat(64);

async function setup() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table public.device_credits(device_id text primary key, free_credits integer not null default 100,
      paid_credits integer not null default 0, subscription_credits integer not null default 0,
      apple_user_id text, updated_at timestamptz not null default now());
    create unique index device_credits_apple_user_id_key on public.device_credits(apple_user_id) where apple_user_id is not null;
    create table public.credit_transactions(id uuid primary key default gen_random_uuid(), device_id text not null,
      transaction_type text not null, idempotency_key text not null, free_delta integer not null default 0,
      paid_delta integer not null default 0, metadata jsonb not null default '{}', created_at timestamptz not null default now(),
      unique(transaction_type, idempotency_key));
    create table public.credit_wallet_aliases(source_wallet_id text primary key references public.device_credits(device_id),
      canonical_wallet_id text not null references public.device_credits(device_id), apple_sub text not null,
      created_at timestamptz not null default now(), check (source_wallet_id <> canonical_wallet_id));
    insert into public.device_credits(device_id, free_credits, paid_credits, subscription_credits, apple_user_id) values
      ('v2:g', 400, 100, 0, 'google:111'), ('v2:a', 100, 0, 0, 'apple-a'), ('legacy-1', 0, 0, 0, null);
  `);
  await db.exec(packSql);
  await db.exec(googleSql);
  return db;
}

const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const token = (db, wallet) => one(db, 'select public.credit_pack_account_token($1) t', [wallet]).then((r) => r.t);
const grant = (db, wallet, tok, order, hash = H1, product = P7, env = 'Production') =>
  one(db, 'select * from public.grant_google_credit_pack_once($1,$2,$3,$4,$5,$6)', [wallet, tok, order, hash, product, env]);
const refund = (db, order, hash = H1, product = P7, env = 'Production') =>
  one(db, 'select * from public.refund_google_credit_pack_once($1,$2,$3,$4,$5)', [order, hash, product, env, 'n-' + order]);
const wallet = (db, id) => one(db, 'select free_credits, paid_credits, subscription_credits from public.device_credits where device_id=$1', [id]);
const rejects = (promise, code) => assert.rejects(promise, (e) => e.message.includes(code), code);

test('google subjects only own V2 wallets and no wallet ID can look like one', async () => {
  const db = await setup();
  try {
    await rejects(db.query(`insert into public.device_credits(device_id) values ('google:222')`), 'device_credits_no_google_wallet_id');
    await rejects(db.query(`update public.device_credits set apple_user_id = 'google:333' where device_id = 'legacy-1'`),
      'device_credits_google_subject_v2_only');
    await db.query(`insert into public.device_credits(device_id, apple_user_id) values ('v2:g2', 'google:444')`);
    // Apple and Google subjects share one unique index, so one subject can never own two wallets.
    await rejects(db.query(`insert into public.device_credits(device_id, apple_user_id) values ('v2:g3', 'google:444')`), 'duplicate');
  } finally { await db.close(); }
});

test('a Play order is granted once, to the wallet its account token names, as paid credits', async () => {
  const db = await setup();
  try {
    const t = await token(db, 'v2:g');
    assert.deepEqual(await grant(db, 'v2:g', t, 'GPA.1111-2222-3333-44444'), { result: 'granted', credits: 7000, paid_credits: 7100 });
    assert.deepEqual(await grant(db, 'v2:g', t, 'GPA.1111-2222-3333-44444'), { result: 'already_granted', credits: 7000, paid_credits: 7100 });
    assert.deepEqual(await wallet(db, 'v2:g'), { free_credits: 400, paid_credits: 7100, subscription_credits: 0 });
    const ledger = await one(db, `select count(*)::int n, sum(paid_delta)::int s from public.credit_transactions
      where transaction_type = 'credit_pack_purchase' and idempotency_key = 'gp:GPA.1111-2222-3333-44444'`);
    assert.deepEqual(ledger, { n: 1, s: 7000 });

    const other = await token(db, 'v2:a');
    await rejects(grant(db, 'v2:g', other, 'GPA.9999-0000-0000-00001', H2), 'account_binding_mismatch');
    // The same purchase token cannot be granted again under a different order ID.
    await rejects(grant(db, 'v2:g', t, 'GPA.9999-0000-0000-00002', H1), 'transaction_wallet_or_product_mismatch');
    // A known order cannot switch product.
    await rejects(grant(db, 'v2:g', t, 'GPA.1111-2222-3333-44444', H1, P18), 'transaction_wallet_or_product_mismatch');
    await rejects(grant(db, 'v2:g', t, '4000001', H3), 'invalid_transaction_id');
    await rejects(grant(db, 'v2:g', t, 'GPA.1-2', 'nothex'), 'invalid_transaction_id');
    await rejects(grant(db, 'v2:g', t, 'GPA.1-3', H3, 'com.kingboard.app.monthly_basic'), 'unknown_product');
  } finally { await db.close(); }
});

test('test purchases share the 3-per-30-days limit with Apple Sandbox purchases', async () => {
  const db = await setup();
  try {
    const t = await token(db, 'v2:g');
    await one(db, 'select * from public.grant_credit_pack_once($1,$2,$3,$3,$4,$5)', ['v2:g', t, '5000001', P7, 'Sandbox']);
    await one(db, 'select * from public.grant_credit_pack_once($1,$2,$3,$3,$4,$5)', ['v2:g', t, '5000002', P7, 'Sandbox']);
    assert.equal((await grant(db, 'v2:g', t, 'GPA.1-1', H1, P7, 'Sandbox')).result, 'granted');
    assert.equal((await grant(db, 'v2:g', t, 'GPA.1-2', H2, P7, 'Sandbox')).result, 'sandbox_limit');
    assert.equal((await grant(db, 'v2:g', t, 'GPA.1-3', H3, P7, 'Production')).result, 'granted');
  } finally { await db.close(); }
});

test('a void takes back up to the pack from paid credits, and blocks a later grant', async () => {
  const db = await setup();
  try {
    const t = await token(db, 'v2:g');
    await grant(db, 'v2:g', t, 'GPA.7-1');
    await db.query(`update public.device_credits set paid_credits = 3000 where device_id = 'v2:g'`);
    assert.deepEqual(await refund(db, 'GPA.7-1'), { result: 'recovered', recovered: 3000, shortfall: 4000 });
    assert.deepEqual(await refund(db, 'GPA.7-1'), { result: 'already_refunded', recovered: 3000, shortfall: 4000 });
    assert.deepEqual(await wallet(db, 'v2:g'), { free_credits: 400, paid_credits: 0, subscription_credits: 0 });

    // Voided before the app claimed it: recorded, and the claim then reports refunded.
    assert.deepEqual(await refund(db, 'GPA.7-2', H2), { result: 'recorded_unclaimed', recovered: 0, shortfall: 0 });
    assert.deepEqual(await grant(db, 'v2:g', t, 'GPA.7-2', H2), { result: 'refunded', credits: 0, paid_credits: null });
    assert.equal((await wallet(db, 'v2:g')).paid_credits, 0);
  } finally { await db.close(); }
});

test('grants and refunds follow a merged wallet to the one in use', async () => {
  const db = await setup();
  try {
    await db.query(`insert into public.device_credits(device_id, apple_user_id) values ('v2:gold', null)`);
    const oldToken = await token(db, 'v2:gold');
    await db.query(`insert into public.credit_wallet_aliases values ('v2:gold', 'v2:g', 'google:111')`);
    assert.equal((await one(db, 'select public.credit_pack_wallet_for_account_token($1) w', [oldToken])).w, 'v2:g');
    assert.equal((await grant(db, 'v2:g', oldToken, 'GPA.8-1')).result, 'granted');
    assert.equal((await wallet(db, 'v2:g')).paid_credits, 7100);
    assert.equal((await refund(db, 'GPA.8-1')).recovered, 7000);
  } finally { await db.close(); }
});

test('only service_role may call the Google pack functions', async () => {
  const db = await setup();
  try {
    for (const role of ['anon', 'authenticated']) {
      const r = await one(db, `select has_function_privilege($1, 'public.grant_google_credit_pack_once(text, uuid, text, text, text, text)', 'execute') g,
        has_function_privilege($1, 'public.refund_google_credit_pack_once(text, text, text, text, text)', 'execute') r,
        has_table_privilege($1, 'public.credit_pack_google_purchases', 'select') t`, [role]);
      assert.deepEqual(r, { g: false, r: false, t: false }, role);
    }
    const s = await one(db, `select has_function_privilege('service_role', 'public.grant_google_credit_pack_once(text, uuid, text, text, text, text)', 'execute') g`);
    assert.equal(s.g, true);
  } finally { await db.close(); }
});
