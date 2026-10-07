import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';

const migration = await readFile(
  new URL('../../migrations/20261007031215_defer_linked_wallet_merge_after_recent_ai_use.sql', import.meta.url),
  'utf8',
);

async function database({ withRefund, recentUsage = null }) {
  const db = new PGlite();
  await db.exec(`
    create table device_credits (
      device_id text primary key, apple_user_id text unique,
      free_credits integer not null default 0, paid_credits integer not null default 0,
      subscription_credits integer not null default 0, updated_at timestamptz not null default now()
    );
    create table credit_wallet_sessions (
      token_hash text primary key, wallet_id text not null, apple_sub text not null,
      expires_at timestamptz not null, revoked_at timestamptz
    );
    create table credit_wallet_merge_operations (
      apple_sub text primary key, request_id text not null, source_wallet_id text not null,
      canonical_wallet_id text not null, source_before jsonb not null, destination_before jsonb not null,
      free_after integer not null, paid_after integer not null
    );
    create table credit_wallet_aliases (
      source_wallet_id text primary key, canonical_wallet_id text not null, apple_sub text not null
    );
    create table credit_protected_wallets (wallet_id text primary key);
    create table device_subscriptions (device_id text primary key);
    create table credit_transactions (
      id uuid primary key default gen_random_uuid(), device_id text not null,
      transaction_type text not null, free_delta integer not null default 0,
      paid_delta integer not null default 0, metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );
  `);
  await db.exec(migration);
  const { rows: [{ definition }] } = await db.query(
    "select pg_get_functiondef('public.merge_linked_apple_subject_wallets_once(text,text,text)'::regprocedure) as definition",
  );
  assert.match(definition, /Recent AI usage must settle before wallet merge/);
  await db.exec(`
    insert into device_credits (device_id, apple_user_id, free_credits, paid_credits)
    values ('canonical', 'apple-sub', 500, 20), ('apple-sub', null, 230, 10);
    insert into credit_wallet_sessions (token_hash, wallet_id, apple_sub, expires_at)
    values ('${'a'.repeat(64)}', 'canonical', 'apple-sub', now() + interval '1 day');
  `);
  if (withRefund) {
    await db.exec(`
      insert into credit_transactions (device_id, transaction_type, free_delta)
      values ('apple-sub', 'server_ai_refund', 50);
    `);
  }
  if (recentUsage) {
    await db.query(
      `insert into credit_transactions (device_id, transaction_type, free_delta, metadata, created_at)
       values ($1, 'server_ai_usage', -10, $2::jsonb, now() - $3::interval)`,
      [recentUsage.wallet, JSON.stringify({ refunded: recentUsage.refunded }), recentUsage.age ?? '1 minute'],
    );
  }
  return db;
}

test('holds refunded source balance without changing either wallet', async () => {
  const db = await database({ withRefund: true });
  try {
    await assert.rejects(
      db.query(
        'select * from public.merge_linked_apple_subject_wallets_once($1, $2, $3)',
        ['apple-sub', 'request-1', 'a'.repeat(64)],
      ),
      /Second wallet refund credits require transaction review/,
    );
    assert.deepEqual((await db.query(
      "select device_id, free_credits, paid_credits from device_credits order by device_id",
    )).rows, [
      { device_id: 'apple-sub', free_credits: 230, paid_credits: 10 },
      { device_id: 'canonical', free_credits: 500, paid_credits: 20 },
    ]);
    assert.equal((await db.query('select count(*)::int as n from credit_wallet_merge_operations')).rows[0].n, 0);
    assert.equal((await db.query('select count(*)::int as n from credit_wallet_aliases')).rows[0].n, 0);
  } finally {
    await db.close();
  }
});

test('continues merging a linked pair with no refund ledger entry', async () => {
  const db = await database({ withRefund: false });
  try {
    const result = await db.query(
      'select * from public.merge_linked_apple_subject_wallets_once($1, $2, $3)',
      ['apple-sub', 'request-1', 'a'.repeat(64)],
    );
    assert.equal(result.rows[0].decision, 'merged');
    assert.equal(result.rows[0].free_credits_remaining, 500);
    assert.equal(result.rows[0].paid_credits_remaining, 30);
    assert.deepEqual((await db.query(
      "select device_id, free_credits, paid_credits from device_credits order by device_id",
    )).rows, [
      { device_id: 'apple-sub', free_credits: 0, paid_credits: 0 },
      { device_id: 'canonical', free_credits: 500, paid_credits: 30 },
    ]);
  } finally {
    await db.close();
  }
});

for (const wallet of ['apple-sub', 'canonical']) {
  test(`defers a merge after recent AI use on ${wallet === 'apple-sub' ? 'the source' : 'the destination'} wallet`, async () => {
    const db = await database({ withRefund: false, recentUsage: { wallet, age: '1 minute' } });
    try {
      await assert.rejects(
        db.query(
          'select * from public.merge_linked_apple_subject_wallets_once($1, $2, $3)',
          ['apple-sub', 'request-1', 'a'.repeat(64)],
        ),
        /Recent AI usage must settle before wallet merge/,
      );
      assert.deepEqual((await db.query(
        'select device_id, free_credits, paid_credits from device_credits order by device_id',
      )).rows, [
        { device_id: 'apple-sub', free_credits: 230, paid_credits: 10 },
        { device_id: 'canonical', free_credits: 500, paid_credits: 20 },
      ]);
      assert.equal((await db.query('select count(*)::int as n from credit_wallet_merge_operations')).rows[0].n, 0);
      assert.equal((await db.query('select count(*)::int as n from credit_wallet_aliases')).rows[0].n, 0);
    } finally {
      await db.close();
    }
  });
}

test('allows merging after the five-minute window', async () => {
  const db = await database({ withRefund: false, recentUsage: { wallet: 'apple-sub', age: '6 minutes' } });
  try {
    const result = await db.query(
      'select * from public.merge_linked_apple_subject_wallets_once($1, $2, $3)',
      ['apple-sub', 'request-1', 'a'.repeat(64)],
    );
    assert.equal(result.rows[0].decision, 'merged');
  } finally {
    await db.close();
  }
});

test('allows merging when recent AI use is explicitly marked refunded', async () => {
  const db = await database({ withRefund: false, recentUsage: { wallet: 'canonical', refunded: true } });
  try {
    const result = await db.query(
      'select * from public.merge_linked_apple_subject_wallets_once($1, $2, $3)',
      ['apple-sub', 'request-1', 'a'.repeat(64)],
    );
    assert.equal(result.rows[0].decision, 'merged');
  } finally {
    await db.close();
  }
});
