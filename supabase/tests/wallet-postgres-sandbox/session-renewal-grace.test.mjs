import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const migration = await read('../../migrations/20261024115300_apple_wallet_session_30_day_grace.sql');
const rollback = await read('../../sql/rollback_apple_wallet_session_30_day_grace.sql').catch(() => '');
const signature = "'public.rotate_apple_wallet_session(text,text,timestamptz)'::regprocedure";
const oldHash = '1'.repeat(64), nextHash = '2'.repeat(64);

test('rotation grace uses real isolated PostgreSQL and preserves all other session rules', async t => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create table public.device_credits(device_id text primary key, apple_user_id text unique);
      create table public.credit_wallet_sessions(
        token_hash text primary key check(token_hash ~ '^[0-9a-f]{64}$'),
        wallet_id text not null references public.device_credits(device_id) on delete restrict,
        apple_sub text not null, created_at timestamptz not null default now(),
        expires_at timestamptz not null, revoked_at timestamptz, rotated_to_hash text
      );
    `);
    // The rollback is the verified live definition; unrelated historical migrations are not required.
    await db.exec(rollback);
    await db.exec(`revoke all on function public.rotate_apple_wallet_session(text,text,timestamptz)
      from public,anon,authenticated;
      grant execute on function public.rotate_apple_wallet_session(text,text,timestamptz) to service_role;`);
    const properties = () => db.query(`select prosecdef,proconfig,proacl::text as acl,proowner
      from pg_proc where oid=${signature}`);
    const before = (await properties()).rows;
    const originalDefinition = (await db.query(`select pg_get_functiondef(${signature}) as body`)).rows[0].body;
    await db.exec(migration);
    assert.deepEqual((await properties()).rows, before, 'owner, ACL, definer and empty search_path unchanged');
    const definition = (await db.query(`select pg_get_functiondef(${signature}) as body`)).rows[0].body;
    assert.match(definition, /v_old\.expires_at <= now\(\) - interval '30 days'/);
    assert.equal(definition.replace("v_old.expires_at <= now() - interval '30 days'", "v_old.expires_at <= now()"),
      originalDefinition, 'the grace predicate is the only SQL body change');
    const rotate = (newHash = nextHash, expiry = "now() + interval '29 days'") =>
      db.query(`select public.rotate_apple_wallet_session($1,$2,${expiry}) as wallet_id`, [oldHash,newHash]);
    async function fixture(expiry, revoked = false) {
      await db.exec('begin');
      await db.exec("insert into device_credits values ('wallet','apple')");
      await db.query(`insert into credit_wallet_sessions(token_hash,wallet_id,apple_sub,expires_at,revoked_at)
        values ($1,'wallet','apple',${expiry},${revoked ? 'now()' : 'null'})`, [oldHash]);
    }
    for (const [label, expiry, accepted] of [
      ['valid', "now() + interval '1 day'", true],
      ['expired 1 day', "now() - interval '1 day'", true],
      ['expired 29 days', "now() - interval '29 days'", true],
      ['just inside 30 days', "now() - interval '30 days' + interval '1 microsecond'", true],
      ['exactly 30 days', "now() - interval '30 days'", false],
      ['expired 31 days', "now() - interval '31 days'", false],
    ]) {
      await t.test(label, async () => {
        await fixture(expiry);
        try {
          if (accepted) {
            assert.equal((await rotate()).rows[0].wallet_id,'wallet');
            const rows = (await db.query('select token_hash,revoked_at,rotated_to_hash from credit_wallet_sessions order by token_hash')).rows;
            assert.equal(rows.length,2);
            assert.ok(rows[0].revoked_at);
            assert.equal(rows[0].rotated_to_hash,nextHash);
            assert.equal(rows[1].revoked_at,null);
          } else await assert.rejects(rotate(), /Session is not active/);
        } finally { await db.exec('rollback'); }
      });
    }
    for (const expiry of ["now() + interval '1 day'", "now() - interval '1 day'"]) {
      await t.test('revoked ' + expiry, async () => {
        await fixture(expiry,true);
        try { await assert.rejects(rotate(), /Session is not active/); }
        finally { await db.exec('rollback'); }
      });
    }
    await t.test('retry uses the same next token and does not extend its actual expiry', async () => {
      await fixture("now() - interval '29 days'");
      try {
        await rotate();
        const before = (await db.query('select expires_at from credit_wallet_sessions where token_hash=$1',[nextHash])).rows;
        assert.equal((await rotate(nextHash, "now() + interval '30 days'")).rows[0].wallet_id,'wallet');
        assert.deepEqual((await db.query('select expires_at from credit_wallet_sessions where token_hash=$1',[nextHash])).rows,before);
        assert.equal((await db.query('select count(*)::int as n from credit_wallet_sessions')).rows[0].n,2);
        await assert.rejects(rotate('3'.repeat(64)), /Session is not active/);
      } finally { await db.exec('rollback'); }
    });
    await t.test('unlinked wallet cannot rotate', async () => {
      await fixture("now() - interval '1 day'");
      try {
        await db.exec('update device_credits set apple_user_id=null');
        await assert.rejects(rotate(), /no longer linked/);
      } finally { await db.exec('rollback'); }
    });
    for (const expiry of ["now()", "now() + interval '30 days 1 second'"]) {
      await t.test('invalid new expiry ' + expiry, async () => {
        await fixture("now() - interval '1 day'");
        try { await assert.rejects(rotate(nextHash,expiry), /Invalid session expiry/); }
        finally { await db.exec('rollback'); }
      });
    }
    await t.test('anon and authenticated cannot invoke the definer', async () => {
      for (const role of ['anon','authenticated']) {
        await db.exec('set role ' + role);
        await assert.rejects(rotate(), /permission denied/);
        await db.exec('reset role');
      }
    });
    await t.test('rollback restores the previous definition and identical permissions', async () => {
      assert.ok(rollback);
      await db.exec(rollback);
      assert.deepEqual((await properties()).rows,before);
      assert.equal((await db.query(`select pg_get_functiondef(${signature}) as body`)).rows[0].body,originalDefinition);
      await fixture("now() - interval '1 day'");
      try { await assert.rejects(rotate(), /Session is not active/); }
      finally { await db.exec('rollback'); }
    });
  } finally { await db.close(); }
});
