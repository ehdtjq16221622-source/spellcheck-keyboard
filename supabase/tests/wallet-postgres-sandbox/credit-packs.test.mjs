import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const packSql = await readFile(new URL('../../migrations/20261111090000_credit_packs.sql', import.meta.url), 'utf8');
const P7 = 'com.kingboard.app.credits_7000';
const P18 = 'com.kingboard.app.credits_18000';

async function setup() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table public.device_credits(device_id text primary key, free_credits integer not null default 100,
      paid_credits integer not null default 0, subscription_credits integer not null default 0,
      apple_user_id text, updated_at timestamptz not null default now());
    create table public.credit_transactions(id uuid primary key default gen_random_uuid(), device_id text not null,
      transaction_type text not null, idempotency_key text not null, free_delta integer not null default 0,
      paid_delta integer not null default 0, metadata jsonb not null default '{}', created_at timestamptz not null default now(),
      unique(transaction_type, idempotency_key));
    create table public.credit_wallet_aliases(source_wallet_id text primary key references public.device_credits(device_id),
      canonical_wallet_id text not null references public.device_credits(device_id), apple_sub text not null,
      created_at timestamptz not null default now(), check (source_wallet_id <> canonical_wallet_id));
    insert into public.device_credits(device_id, free_credits, paid_credits, subscription_credits, apple_user_id) values
      ('v2:a', 400, 100, 2550, 'apple-a'), ('v2:b', 100, 0, 0, 'apple-b'), ('v2:old', 0, 0, 0, 'apple-a');
  `);
  await db.exec(packSql);
  return db;
}

const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const token = (db, wallet) => one(db, 'select public.credit_pack_account_token($1) t', [wallet]).then((r) => r.t);
const grant = (db, wallet, tok, txn, product = P7, env = 'Production', orig = txn) =>
  one(db, 'select * from public.grant_credit_pack_once($1,$2,$3,$4,$5,$6)', [wallet, tok, txn, orig, product, env]);
const refund = (db, txn, product = P7, env = 'Production') =>
  one(db, 'select * from public.refund_credit_pack_once($1,$2,$3,$4)', [txn, product, env, 'n-' + txn]);
const reverse = (db, txn, product = P7, env = 'Production') =>
  one(db, 'select * from public.reverse_credit_pack_refund_once($1,$2,$3,$4)', [txn, product, env, 'r-' + txn]);
const wallet = (db, id) => one(db, 'select free_credits, paid_credits, subscription_credits from public.device_credits where device_id=$1', [id]);

test('grant is once per transaction, only paid credits move, ledger matches', async () => {
  const db = await setup();
  try {
    const tA = await token(db, 'v2:a');
    assert.equal(await token(db, 'v2:a'), tA, 'token is stable per wallet');
    assert.deepEqual(await grant(db, 'v2:a', tA, '100'), { result: 'granted', credits: 7000, paid_credits: 7100 });
    assert.deepEqual(await grant(db, 'v2:a', tA, '100'), { result: 'already_granted', credits: 7000, paid_credits: 7100 });
    assert.deepEqual(await grant(db, 'v2:a', tA, '101', P18), { result: 'granted', credits: 18000, paid_credits: 25100 });
    assert.deepEqual(await wallet(db, 'v2:a'), { free_credits: 400, paid_credits: 25100, subscription_credits: 2550 });
    const ledger = await one(db, "select sum(paid_delta)::int s, count(*)::int n from public.credit_transactions where device_id='v2:a'");
    assert.deepEqual(ledger, { s: 25000, n: 2 });
    await assert.rejects(grant(db, 'v2:a', tA, '102', 'com.kingboard.app.monthly_pro'), /unknown_product/);
    await assert.rejects(grant(db, 'v2:a', tA, 'abc'), /invalid_transaction_id/);
  } finally { await db.close(); }
});

test('another wallet cannot claim with a token that is not its own', async () => {
  const db = await setup();
  try {
    const tA = await token(db, 'v2:a');
    const tB = await token(db, 'v2:b');
    await assert.rejects(grant(db, 'v2:b', tA, '200'), /account_binding_mismatch/);
    await assert.rejects(grant(db, 'v2:a', '00000000-0000-4000-8000-000000000000', '200'), /account_binding_mismatch/);
    await grant(db, 'v2:a', tA, '200');
    await assert.rejects(grant(db, 'v2:b', tB, '200'), /transaction_wallet_or_product_mismatch/);
    assert.equal((await wallet(db, 'v2:b')).paid_credits, 0);
  } finally { await db.close(); }
});

test('merged wallet: purchase, refund and reversal follow the wallet in use', async () => {
  const db = await setup();
  try {
    const tOld = await token(db, 'v2:old');
    await db.exec("insert into public.credit_wallet_aliases values ('v2:old','v2:a','apple-a',now())");
    // Token issued before the merge still works; credits land on the wallet in use.
    assert.equal((await grant(db, 'v2:old', tOld, '300')).result, 'granted');
    assert.equal((await wallet(db, 'v2:a')).paid_credits, 7100);
    assert.equal((await wallet(db, 'v2:old')).paid_credits, 0);
    assert.equal(await token(db, 'v2:old'), await token(db, 'v2:a'), 'after merge, the token request resolves to the wallet in use');
    assert.deepEqual(await refund(db, '300'), { result: 'recovered', recovered: 7000, shortfall: 0 });
    assert.equal((await wallet(db, 'v2:a')).paid_credits, 100);
    assert.deepEqual(await reverse(db, '300'), { result: 'restored', restored: 7000 });
    assert.equal((await wallet(db, 'v2:a')).paid_credits, 7100);
  } finally { await db.close(); }
});

test('refund recovers only remaining paid credits, never free or subscription; repeats are no-ops', async () => {
  const db = await setup();
  try {
    const tA = await token(db, 'v2:a');
    await grant(db, 'v2:a', tA, '400');
    await db.exec("update public.device_credits set paid_credits = 1000 where device_id='v2:a'");
    assert.deepEqual(await refund(db, '400'), { result: 'recovered', recovered: 1000, shortfall: 6000 });
    assert.deepEqual(await refund(db, '400'), { result: 'already_refunded', recovered: 1000, shortfall: 6000 });
    assert.deepEqual(await wallet(db, 'v2:a'), { free_credits: 400, paid_credits: 0, subscription_credits: 2550 });
    assert.equal((await grant(db, 'v2:a', tA, '400')).result, 'refunded', 'a refunded purchase is never re-granted');
    assert.deepEqual(await reverse(db, '400'), { result: 'restored', restored: 1000 });
    assert.deepEqual(await reverse(db, '400'), { result: 'already_restored', restored: 1000 });
    assert.equal((await wallet(db, 'v2:a')).paid_credits, 1000);
    await assert.rejects(refund(db, '400'), /refund_after_reversal_requires_review/);
  } finally { await db.close(); }
});

test('refund before claim blocks the claim; reversal before refund asks for a retry', async () => {
  const db = await setup();
  try {
    const tA = await token(db, 'v2:a');
    assert.deepEqual(await refund(db, '500'), { result: 'recorded_unclaimed', recovered: 0, shortfall: 0 });
    assert.equal((await grant(db, 'v2:a', tA, '500')).result, 'refunded');
    assert.equal((await wallet(db, 'v2:a')).paid_credits, 100);
    await assert.rejects(reverse(db, '501'), /refund_not_found_retry/);
    // Unclaimed refund reversed: nothing to restore, and the purchase can then be claimed normally.
    assert.deepEqual(await reverse(db, '500'), { result: 'restored', restored: 0 });
    assert.equal((await grant(db, 'v2:a', tA, '500')).result, 'granted');
    assert.equal((await wallet(db, 'v2:a')).paid_credits, 7100);
  } finally { await db.close(); }
});

test('sandbox purchases are granted, marked, and capped at 3 per wallet per 30 days', async () => {
  const db = await setup();
  try {
    const tB = await token(db, 'v2:b');
    for (const txn of ['600', '601', '602']) assert.equal((await grant(db, 'v2:b', tB, txn, P7, 'Sandbox')).result, 'granted');
    assert.deepEqual(await grant(db, 'v2:b', tB, '603', P7, 'Sandbox'), { result: 'sandbox_limit', credits: 0, paid_credits: null });
    assert.equal((await grant(db, 'v2:b', tB, '604', P7, 'Production')).result, 'granted', 'real purchases are never capped');
    const marked = await one(db, "select count(*)::int n from public.credit_transactions where metadata->>'environment'='Sandbox'");
    assert.equal(marked.n, 3);
    await db.exec("update public.credit_pack_purchases set created_at = now() - interval '31 days' where environment='Sandbox'");
    assert.equal((await grant(db, 'v2:b', tB, '605', P7, 'Sandbox')).result, 'granted');
    await assert.rejects(grant(db, 'v2:b', tB, '606', P7, 'Xcode'), /invalid_environment/);
  } finally { await db.close(); }
});

test('a duplicate ledger key aborts the grant without leaving a half-written purchase', async () => {
  const db = await setup();
  try {
    const tA = await token(db, 'v2:a');
    await db.exec("insert into public.credit_transactions(device_id, transaction_type, idempotency_key, paid_delta) values ('v2:a','credit_pack_purchase','700',1)");
    await assert.rejects(grant(db, 'v2:a', tA, '700'), /duplicate key/);
    assert.equal((await one(db, "select count(*)::int n from public.credit_pack_purchases where transaction_id='700'")).n, 0);
    assert.equal((await wallet(db, 'v2:a')).paid_credits, 100);
  } finally { await db.close(); }
});

test('clients cannot call the functions or read the tables', async () => {
  const db = await setup();
  try {
    for (const fn of ['grant_credit_pack_once(text,uuid,text,text,text,text)', 'refund_credit_pack_once(text,text,text,text)',
      'reverse_credit_pack_refund_once(text,text,text,text)', 'credit_pack_account_token(text)']) {
      for (const role of ['anon', 'authenticated']) {
        const r = await one(db, `select has_function_privilege($1, 'public.${fn}', 'execute') ok`, [role]);
        assert.equal(r.ok, false, `${role} must not execute ${fn}`);
      }
      assert.equal((await one(db, `select has_function_privilege('service_role', 'public.${fn}', 'execute') ok`)).ok, true);
    }
    for (const table of ['credit_pack_purchases', 'credit_pack_refunds', 'credit_pack_account_tokens']) {
      assert.equal((await one(db, `select has_table_privilege('anon', 'public.${table}', 'select') ok`)).ok, false);
    }
  } finally { await db.close(); }
});
