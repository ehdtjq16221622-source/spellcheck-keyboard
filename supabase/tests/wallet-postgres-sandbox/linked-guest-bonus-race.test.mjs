import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'

const migration = readFileSync(new URL('../../migrations/20261013071028_handle_linked_guest_bonus_race.sql', import.meta.url), 'utf8')
const rollback = readFileSync(new URL('../../sql/rollback_linked_guest_bonus_race.sql', import.meta.url), 'utf8')
const secret = 'a'.repeat(64)
const lockOwner = '00000000-0000-0000-0000-000000000001'

async function setup() {
  const db = new PGlite()
  await db.exec(`
    create schema auth;
    create function auth.role() returns text language sql as $$ select 'service_role'::text $$;
    create role anon;
    create role authenticated;
    create role service_role;
    create table public.device_credits (
      device_id text primary key, apple_user_id text, free_credits integer not null default 0,
      paid_credits integer not null default 0, updated_at timestamptz default now()
    );
    create table public.wallet_v2_credentials (
      wallet_id text primary key, secret_hash text not null, state text not null
    );
    create table public.credit_transactions (
      id integer generated always as identity primary key, device_id text not null,
      transaction_type text not null, idempotency_key text not null,
      free_delta integer not null, metadata jsonb,
      unique (transaction_type, idempotency_key)
    );
    create table public.credit_wallet_aliases (
      source_wallet_id text primary key, apple_sub text not null
    );
    create table public.wallet_v2_link_attempts (
      wallet_id text not null, apple_sub text not null
    );
    create table public.guest_install_bonus_claims (
      wallet_id text primary key, state text not null,
      verification_confirmed_at timestamptz, granted_at timestamptz
    );
    create table public.guest_bonus_devicecheck_lock (
      singleton boolean primary key, owner uuid, expires_at timestamptz
    );
    insert into public.guest_bonus_devicecheck_lock values
      (true, '${lockOwner}', now() + interval '1 hour');
  `)
  await db.exec(migration)
  return db
}

async function wallet(db, id, apple = null, state = 'active') {
  await db.query('insert into public.device_credits(device_id, apple_user_id) values ($1, $2)', [id, apple])
  await db.query('insert into public.wallet_v2_credentials values ($1, $2, $3)', [id, secret, state])
}

async function reserve(db, id) {
  return (await db.query('select public.reserve_guest_install_bonus($1, $2) as result', [id, secret])).rows[0].result
}

async function confirm(db, id) {
  return (await db.query('select public.confirm_guest_install_bonus_devicecheck($1, $2, $3) as result', [id, secret, lockOwner])).rows[0].result
}

async function complete(db, id) {
  return (await db.query('select public.complete_guest_install_bonus_guarded($1, $2, $3) as result', [id, secret, lockOwner])).rows[0].result
}

test('link between reservation and DeviceCheck completion grants exactly once', async () => {
  const db = await setup()
  try {
    await wallet(db, 'v2:race')
    assert.equal(await reserve(db, 'v2:race'), 'pending')
    await db.exec("update public.wallet_v2_credentials set state = 'linked' where wallet_id = 'v2:race'; update public.device_credits set apple_user_id = 'apple-race' where device_id = 'v2:race'")
    assert.equal(await confirm(db, 'v2:race'), true)
    assert.equal(await complete(db, 'v2:race'), true)
    assert.equal(await complete(db, 'v2:race'), false)
    const { rows } = await db.query("select d.free_credits, count(t.id)::integer as grants from public.device_credits d left join public.credit_transactions t on t.device_id = d.device_id and t.transaction_type = 'install_bonus' where d.device_id = 'v2:race' group by d.device_id")
    assert.deepEqual(rows, [{ free_credits: 500, grants: 1 }])
  } finally { await db.close() }
})

test('link before reservation still grants after confirmed DeviceCheck', async () => {
  const db = await setup()
  try {
    await wallet(db, 'v2:linked', 'apple-first', 'linked')
    assert.equal(await reserve(db, 'v2:linked'), 'pending')
    await assert.rejects(complete(db, 'v2:linked'), /Confirmed device verification required/)
    assert.equal(await confirm(db, 'v2:linked'), true)
    assert.equal(await complete(db, 'v2:linked'), true)
    assert.equal(await reserve(db, 'v2:linked'), 'granted')
  } finally { await db.close() }
})

test('another Apple wallet bonus or restore blocks the new bonus', async () => {
  const db = await setup()
  try {
    await wallet(db, 'v2:prior')
    await db.exec("insert into public.credit_wallet_aliases values ('v2:prior', 'apple-owner'); insert into public.credit_transactions(device_id, transaction_type, idempotency_key, free_delta) values ('v2:prior', 'install_bonus_restore', 'prior', 500)")
    await wallet(db, 'v2:new', 'apple-owner', 'linked')
    assert.equal(await reserve(db, 'v2:new'), 'account_bonus_exists')
    const { rows } = await db.query("select count(*)::integer as claims from public.guest_install_bonus_claims where wallet_id = 'v2:new'")
    assert.equal(rows[0].claims, 0)
    await db.exec("insert into public.guest_install_bonus_claims(wallet_id, state, verification_confirmed_at) values ('v2:new', 'pending', now())")
    assert.equal(await complete(db, 'v2:new'), false)
    const balances = await db.query("select free_credits from public.device_credits where device_id = 'v2:new'")
    assert.equal(balances.rows[0].free_credits, 0)
  } finally { await db.close() }
})

test('own restore is terminal and wrong proof cannot grant', async () => {
  const db = await setup()
  try {
    await wallet(db, 'v2:restore', 'apple-restore', 'linked')
    await db.exec("insert into public.credit_transactions(device_id, transaction_type, idempotency_key, free_delta) values ('v2:restore', 'install_bonus_restore', 'restore', 500)")
    assert.equal(await reserve(db, 'v2:restore'), 'granted')
    assert.equal(await complete(db, 'v2:restore'), false)
    await assert.rejects(db.query("select public.reserve_guest_install_bonus('v2:restore', 'wrong')"), /Wallet possession proof failed/)
  } finally { await db.close() }
})

test('rollback restores the old linked-wallet rejection without deleting grants', async () => {
  const db = await setup()
  try {
    await wallet(db, 'v2:rollback', 'apple-rollback', 'linked')
    assert.equal(await reserve(db, 'v2:rollback'), 'pending')
    await db.exec(rollback)
    await assert.rejects(reserve(db, 'v2:rollback'), /Wallet possession proof failed/)
    const { rows } = await db.query("select count(*)::integer as claims from public.guest_install_bonus_claims where wallet_id = 'v2:rollback'")
    assert.equal(rows[0].claims, 1)
    const helper = await db.query("select to_regprocedure('public.linked_apple_has_other_install_bonus(text,text)') as name")
    assert.equal(helper.rows[0].name, null)
  } finally { await db.close() }
})

test('bonus RPCs remain service-role only', async () => {
  const db = await setup()
  try {
    const { rows } = await db.query(`
      select p.proname,
        has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
        has_function_privilege('service_role', p.oid, 'EXECUTE') as service
      from pg_proc p where p.oid in (
        'public.linked_apple_has_other_install_bonus(text,text)'::regprocedure,
        'public.reserve_guest_install_bonus(text,text)'::regprocedure,
        'public.confirm_guest_install_bonus_devicecheck(text,text,uuid)'::regprocedure,
        'public.complete_guest_install_bonus_guarded(text,text,uuid)'::regprocedure
      )`)
    assert.equal(rows.length, 4)
    for (const row of rows) assert.deepEqual([row.anon, row.authenticated, row.service], [false, false, true])
  } finally { await db.close() }
})
