import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';

const adGrantSql = await readFile(
  new URL('../../migrations/20260926220301_atomic_ad_reward_preparation.sql', import.meta.url),
  'utf8',
);
const walletLinkSql = await readFile(
  new URL('../../migrations/20260926010000_wallet_link_v2.sql', import.meta.url),
  'utf8',
);
const walletMergeSql = await readFile(
  new URL('../../migrations/20260926020000_verified_apple_wallet_merge.sql', import.meta.url),
  'utf8',
);
const walletSessionsSql = await readFile(
  new URL('../../migrations/20260926030000_wallet_sessions.sql', import.meta.url),
  'utf8',
);
const guestWalletBonusSql = await readFile(
  new URL('../../migrations/20260926040000_guest_wallet_bonus.sql', import.meta.url),
  'utf8',
);
const pendingGuestBonusSql = await readFile(
  new URL('../../migrations/20260926220236_guest_install_bonus_pending.sql', import.meta.url),
  'utf8',
);
const verifiedGuestMergeSql = await readFile(
  new URL('../../migrations/20260926050000_verified_guest_wallet_merge.sql', import.meta.url),
  'utf8',
);
const verifiedLegacyMergeSql = await readFile(
  new URL('../../migrations/20260926060000_verified_legacy_wallet_merge.sql', import.meta.url),
  'utf8',
);

async function database() {
  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create table device_credits (
      device_id text primary key,
      apple_user_id text unique,
      credits integer not null default 5,
      free_credits integer not null default 0,
      paid_credits integer not null default 0,
      subscription_credits integer not null default 0,
      last_reset_date date not null default current_date,
      updated_at timestamptz not null default now()
    );
    create table credit_transactions (
      device_id text not null,
      transaction_type text not null,
      idempotency_key text not null,
      free_delta integer not null default 0,
      paid_delta integer not null default 0,
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      unique (transaction_type, idempotency_key)
    );
    create table credit_device_aliases (
      device_id text primary key,
      apple_user_id text not null
    );
    create table device_subscriptions (
      device_id text primary key,
      purchase_token text unique
    );
  `);
  await db.exec(adGrantSql);
  await db.exec(walletLinkSql);
  await db.exec(walletMergeSql);
  await db.exec(walletSessionsSql);
  await db.exec(guestWalletBonusSql);
  await db.exec(pendingGuestBonusSql);
  await db.exec(verifiedGuestMergeSql);
  await db.exec(verifiedLegacyMergeSql);
  return db;
}

async function balance(db, id) {
  const result = await db.query(
    'select free_credits, paid_credits, subscription_credits from device_credits where device_id = $1',
    [id],
  );
  return result.rows[0] ?? null;
}

async function wallets(db) {
  await db.exec(`
    insert into device_credits (device_id, apple_user_id, free_credits, paid_credits)
    values ('apple', 'apple', 0, 200), ('local', null, 500, 100);
  `);
}

async function appleSession(db, appleSub) {
  const hash = 'd'.repeat(64);
  await db.query(
    'select public.issue_apple_wallet_session($1, $2, $3)',
    [appleSub, hash, new Date(Date.now() + 60_000).toISOString()],
  );
  return hash;
}

test('legacy split link can lose the local wallet if the move fails', async () => {
  const db = await database();
  try {
    await wallets(db);
    await db.exec("delete from device_credits where device_id = 'local'");
    await assert.rejects(
      db.exec("update device_credits set device_id = 'local' where apple_user_id = 'apple' returning 1 / 0"),
    );
    assert.equal(await balance(db, 'local'), null);
    assert.equal((await balance(db, 'apple')).paid_credits, 200);
  } finally {
    await db.close();
  }
});

test('one database transaction rolls back both link steps on failure', async () => {
  const db = await database();
  try {
    await wallets(db);
    await db.exec('begin');
    await db.exec("delete from device_credits where device_id = 'local'");
    await assert.rejects(
      db.exec("update device_credits set device_id = 'local' where apple_user_id = 'apple' returning 1 / 0"),
    );
    await db.exec('rollback');
    assert.deepEqual(await balance(db, 'local'), {
      free_credits: 500, paid_credits: 100, subscription_credits: 0,
    });
    assert.equal((await balance(db, 'apple')).paid_credits, 200);
  } finally {
    await db.close();
  }
});

test('legacy split ad grant leaves a ledger entry without credits after failure', async () => {
  const db = await database();
  try {
    await wallets(db);
    await db.exec(`
      insert into credit_transactions (device_id, transaction_type, idempotency_key, paid_delta)
      values ('apple', 'admob_ssv', 'ad-1', 100)
    `);
    await assert.rejects(db.exec("update device_credits set paid_credits = paid_credits + 100 where device_id = 'apple' returning 1 / 0"));
    const retry = await db.query(`
      insert into credit_transactions (device_id, transaction_type, idempotency_key, paid_delta)
      values ('apple', 'admob_ssv', 'ad-1', 100)
      on conflict (transaction_type, idempotency_key) do nothing
      returning 1
    `);
    assert.equal(retry.rows.length, 0);
    assert.equal((await balance(db, 'apple')).paid_credits, 200);
  } finally {
    await db.close();
  }
});

test('atomic ad grant retries once after failure and ignores a duplicate', async () => {
  const db = await database();
  try {
    await wallets(db);
    await db.exec('begin');
    await db.exec(`
      insert into credit_transactions (device_id, transaction_type, idempotency_key, paid_delta)
      values ('apple', 'admob_ssv', 'ad-1', 100)
    `);
    await assert.rejects(db.exec("update device_credits set paid_credits = paid_credits + 100 where device_id = 'apple' returning 1 / 0"));
    await db.exec('rollback');

    await db.exec('begin');
    const first = await db.query(`
      insert into credit_transactions (device_id, transaction_type, idempotency_key, paid_delta)
      values ('apple', 'admob_ssv', 'ad-1', 100)
      on conflict (transaction_type, idempotency_key) do nothing
      returning 1
    `);
    if (first.rows.length) {
      await db.exec("update device_credits set paid_credits = paid_credits + 100 where device_id = 'apple'");
    }
    await db.exec('commit');
    assert.equal((await balance(db, 'apple')).paid_credits, 300);

    await db.exec('begin');
    const duplicate = await db.query(`
      insert into credit_transactions (device_id, transaction_type, idempotency_key, paid_delta)
      values ('apple', 'admob_ssv', 'ad-1', 100)
      on conflict (transaction_type, idempotency_key) do nothing
      returning 1
    `);
    if (duplicate.rows.length) {
      await db.exec("update device_credits set paid_credits = paid_credits + 100 where device_id = 'apple'");
    }
    await db.exec('commit');
    assert.equal(duplicate.rows.length, 0);
    assert.equal((await balance(db, 'apple')).paid_credits, 300);
  } finally {
    await db.close();
  }
});

test('a subscription grant to the old device ID does not increase the Apple wallet', async () => {
  const db = await database();
  try {
    await wallets(db);
    await db.exec("update device_credits set subscription_credits = 4000 where device_id = 'local'");
    assert.equal((await balance(db, 'local')).subscription_credits, 4000);
    assert.equal((await balance(db, 'apple')).subscription_credits, 0);
  } finally {
    await db.close();
  }
});

test('old device requests must resolve to the Apple wallet for display and deduction', async () => {
  const db = await database();
  try {
    await wallets(db);
    await db.exec("insert into credit_device_aliases values ('local', 'apple')");
    const resolved = await db.query(`
      select coalesce(
        (select apple_user_id from credit_device_aliases where device_id = $1),
        (select apple_user_id from device_credits where device_id = $1),
        $1
      ) as wallet_id
    `, ['local']);
    const walletId = resolved.rows[0].wallet_id;
    assert.equal(walletId, 'apple');

    const before = await balance(db, walletId);
    await db.query('update device_credits set paid_credits = paid_credits - 10 where device_id = $1', [walletId]);
    assert.equal(before.paid_credits, 200);
    assert.equal((await balance(db, walletId)).paid_credits, 190);
    assert.equal((await balance(db, 'local')).paid_credits, 100);
  } finally {
    await db.close();
  }
});

test('recorded free use blocks another automatic install bonus; no history stays uncertain', async () => {
  const db = await database();
  try {
    await wallets(db);
    await db.exec(`
      insert into credit_transactions
        (device_id, transaction_type, idempotency_key, free_delta)
      values ('apple', 'server_ai_usage', 'usage-1', -10)
    `);
    const used = await db.query(`
      select exists (
        select 1 from credit_transactions
        where device_id in ('apple', 'local') and free_delta < 0
      ) as recorded_free_use
    `);
    assert.equal(used.rows[0].recorded_free_use, true);
    assert.equal((await balance(db, 'local')).free_credits, 500);

    await db.exec('delete from credit_transactions');
    const unknown = await db.query(`
      select exists (
        select 1 from credit_transactions
        where device_id in ('apple', 'local') and free_delta < 0
      ) as recorded_free_use
    `);
    assert.equal(unknown.rows[0].recorded_free_use, false);
    assert.equal((await balance(db, 'local')).free_credits, 500);
  } finally {
    await db.close();
  }
});

test('repeated linking is idempotent and a conflicting Apple identity cannot claim the alias', async () => {
  const db = await database();
  try {
    await wallets(db);
    const link = async (appleId) => db.query(`
      insert into credit_device_aliases (device_id, apple_user_id)
      values ('local', $1)
      on conflict (device_id) do nothing
      returning apple_user_id
    `, [appleId]);

    assert.equal((await link('apple')).rows.length, 1);
    assert.equal((await link('apple')).rows.length, 0);
    assert.equal((await link('other-apple')).rows.length, 0);
    const row = await db.query("select apple_user_id from credit_device_aliases where device_id = 'local'");
    assert.equal(row.rows[0].apple_user_id, 'apple');
    assert.deepEqual(await balance(db, 'local'), {
      free_credits: 500, paid_credits: 100, subscription_credits: 0,
    });
    assert.deepEqual(await balance(db, 'apple'), {
      free_credits: 0, paid_credits: 200, subscription_credits: 0,
    });
  } finally {
    await db.close();
  }
});

test('candidate ad grant records and credits exactly once', async () => {
  const db = await database();
  try {
    await wallets(db);
    const grant = (id, amount = 100, key = 'ad-1') => db.query(
      'select * from public.grant_ad_credits_once($1, $2, $3)',
      [id, amount, key],
    );
    assert.deepEqual((await grant('apple')).rows[0], {
      applied: true, paid_credits_remaining: 300,
    });
    assert.deepEqual((await grant('apple')).rows[0], {
      applied: false, paid_credits_remaining: 300,
    });
    assert.equal((await balance(db, 'apple')).paid_credits, 300);
    assert.equal((await db.query("select count(*)::integer as n from credit_transactions where idempotency_key = 'ad-1'")).rows[0].n, 1);
  } finally {
    await db.close();
  }
});

test('candidate rejects mismatched duplicate and invalid amount without an extra ledger row', async () => {
  const db = await database();
  try {
    await wallets(db);
    await db.query("select * from public.grant_ad_credits_once('apple', 100, 'ad-1')");
    await assert.rejects(db.query("select * from public.grant_ad_credits_once('local', 100, 'ad-1')"));
    await assert.rejects(db.query("select * from public.grant_ad_credits_once('apple', 200, 'ad-1')"));
    await assert.rejects(db.query("select * from public.grant_ad_credits_once('apple', 500, 'ad-3')"));
    assert.equal((await db.query('select count(*)::integer as n from credit_transactions')).rows[0].n, 1);
    assert.equal((await balance(db, 'apple')).paid_credits, 300);
  } finally {
    await db.close();
  }
});

test('verified ad can create a missing wallet without a free install bonus', async () => {
  const db = await database();
  try {
    const result = await db.query("select * from public.grant_ad_credits_once('new-device', 100, 'new-ad')");
    assert.equal(result.rows[0].applied, true);
    assert.deepEqual(await balance(db, 'new-device'), {
      free_credits: 0, paid_credits: 100, subscription_credits: 0,
    });
    assert.equal((await db.query("select credits from device_credits where device_id = 'new-device'")).rows[0].credits, 0);
    const retry = await db.query("select * from public.grant_ad_credits_once('new-device', 100, 'new-ad')");
    assert.equal(retry.rows[0].applied, false);
    assert.equal((await balance(db, 'new-device')).paid_credits, 100);
  } finally {
    await db.close();
  }
});

test('retry of an already paid ad does not recreate a removed old wallet', async () => {
  const db = await database();
  try {
    await db.query("select * from public.grant_ad_credits_once('old-device', 200, 'old-ad')");
    await db.query("delete from device_credits where device_id = 'old-device'");
    const retry = await db.query("select * from public.grant_ad_credits_once('old-device', 200, 'old-ad')");
    assert.equal(retry.rows[0].applied, false);
    assert.equal((await db.query("select count(*)::integer as n from device_credits where device_id = 'old-device'")).rows[0].n, 0);
    assert.equal((await db.query("select count(*)::integer as n from credit_transactions where idempotency_key = 'old-ad'")).rows[0].n, 1);
  } finally {
    await db.close();
  }
});

test('candidate rolls back its ledger insert if balance update fails', async () => {
  const db = await database();
  try {
    await wallets(db);
    await db.exec(`
      create function fail_ad_update() returns trigger language plpgsql as $$
      begin
        if new.paid_credits > old.paid_credits then
          raise exception 'simulated write failure';
        end if;
        return new;
      end; $$;
      create trigger fail_ad_update before update on device_credits
        for each row execute function fail_ad_update();
    `);
    await assert.rejects(db.query("select * from public.grant_ad_credits_once('apple', 100, 'ad-fail')"));
    assert.equal((await db.query("select count(*)::integer as n from credit_transactions where idempotency_key = 'ad-fail'")).rows[0].n, 0);
    assert.equal((await balance(db, 'apple')).paid_credits, 200);
    await db.exec('drop trigger fail_ad_update on device_credits');
    assert.equal((await db.query("select * from public.grant_ad_credits_once('apple', 100, 'ad-fail')")).rows[0].applied, true);
    assert.equal((await balance(db, 'apple')).paid_credits, 300);
  } finally {
    await db.close();
  }
});

test('candidate does not leave a ledger row on overflow', async () => {
  const db = await database();
  try {
    await wallets(db);
    await db.exec("update device_credits set paid_credits = 2147483600 where device_id = 'apple'");
    await assert.rejects(db.query("select * from public.grant_ad_credits_once('apple', 100, 'ad-overflow')"));
    assert.equal((await db.query("select count(*)::integer as n from credit_transactions where idempotency_key = 'ad-overflow'")).rows[0].n, 0);
  } finally {
    await db.close();
  }
});

test('Apple JWT alone cannot authorize transfer of an unrelated device wallet', async () => {
  const db = await database();
  try {
    await wallets(db);
    const claimedDeviceId = 'local';
    const appleSubject = 'apple';
    const ownerProof = await db.query(`
      select exists (
        select 1 from credit_device_aliases
        where device_id = $1 and apple_user_id = $2
      ) or exists (
        select 1 from device_credits
        where device_id = $1 and apple_user_id = $2
      ) as already_linked
    `, [claimedDeviceId, appleSubject]);
    assert.equal(ownerProof.rows[0].already_linked, false);
    assert.deepEqual(await balance(db, 'local'), {
      free_credits: 500, paid_credits: 100, subscription_credits: 0,
    });
    assert.equal((await balance(db, 'apple')).paid_credits, 200);
  } finally {
    await db.close();
  }
});

async function classifyLinkWithoutMutation(db, appleId, localId) {
  const linked = await db.query(
    'select device_id from device_credits where apple_user_id = $1', [appleId],
  );
  const local = await db.query(
    'select device_id from device_credits where device_id = $1', [localId],
  );
  if (linked.rows.length && linked.rows[0].device_id === localId) return 'already_linked';
  if (linked.rows.length && local.rows.length) return 'both_review';
  if (linked.rows.length) return 'apple_only';
  if (local.rows.length) return 'device_only_needs_proof';
  return 'new_account_policy_needed';
}

test('link preflight classifies device-only, Apple-only, and both without moving balances', async () => {
  const db = await database();
  try {
    await db.exec("insert into device_credits (device_id, free_credits) values ('local', 500)");
    assert.equal(await classifyLinkWithoutMutation(db, 'apple', 'local'), 'device_only_needs_proof');
    await db.exec("delete from device_credits where device_id = 'local'");
    await db.exec("insert into device_credits (device_id, apple_user_id, paid_credits) values ('apple', 'apple', 200)");
    assert.equal(await classifyLinkWithoutMutation(db, 'apple', 'local'), 'apple_only');
    await db.exec("insert into device_credits (device_id, free_credits, paid_credits, subscription_credits) values ('local', 500, 100, 4000)");
    assert.equal(await classifyLinkWithoutMutation(db, 'apple', 'local'), 'both_review');
    assert.deepEqual(await balance(db, 'local'), {
      free_credits: 500, paid_credits: 100, subscription_credits: 4000,
    });
    assert.equal((await balance(db, 'apple')).paid_credits, 200);
  } finally {
    await db.close();
  }
});

const proofHash = 'a'.repeat(64);

test('pending guest bonus is granted once only for the reserved wallet proof', async () => {
  const db = await database();
  try {
    const id = (await db.query(
      'select public.register_guest_wallet_v2($1, 0) as id', [proofHash],
    )).rows[0].id;
    assert.equal((await balance(db, id)).free_credits, 0);
    assert.equal((await db.query(
      'select public.complete_guest_install_bonus($1, $2) as applied', [id, proofHash],
    )).rows[0].applied, false);
    await assert.rejects(db.query(
      'select public.reserve_guest_install_bonus($1, $2)', [id, 'b'.repeat(64)],
    ));
    assert.equal((await db.query(
      'select public.reserve_guest_install_bonus($1, $2) as state', [id, proofHash],
    )).rows[0].state, 'pending');
    assert.equal((await db.query(
      'select public.complete_guest_install_bonus($1, $2) as applied', [id, proofHash],
    )).rows[0].applied, true);
    assert.equal((await db.query(
      'select public.complete_guest_install_bonus($1, $2) as applied', [id, proofHash],
    )).rows[0].applied, false);
    assert.equal((await balance(db, id)).free_credits, 500);
    assert.equal((await db.query(
      "select count(*)::integer as n from credit_transactions where device_id = $1 and transaction_type = 'install_bonus'",
      [id],
    )).rows[0].n, 1);
    const privileges = await db.query(`
      select has_function_privilege('anon', 'public.reserve_guest_install_bonus(text,text)', 'execute') as anon_reserve,
             has_function_privilege('authenticated', 'public.complete_guest_install_bonus(text,text)', 'execute') as user_complete,
             has_function_privilege('service_role', 'public.complete_guest_install_bonus(text,text)', 'execute') as server_complete
    `);
    assert.deepEqual(privileges.rows[0], {
      anon_reserve: false, user_complete: false, server_complete: true,
    });
  } finally {
    await db.close();
  }
});

test('failed bonus finalization leaves a claim that a retry can complete', async () => {
  const db = await database();
  try {
    const id = (await db.query(
      'select public.register_guest_wallet_v2($1, 0) as id', [proofHash],
    )).rows[0].id;
    await db.query('select public.reserve_guest_install_bonus($1, $2)', [id, proofHash]);
    await db.exec(`
      create function fail_bonus_update() returns trigger language plpgsql as $$
      begin
        if new.free_credits > old.free_credits then
          raise exception 'simulated bonus write failure';
        end if;
        return new;
      end; $$;
      create trigger fail_bonus_update before update on device_credits
        for each row execute function fail_bonus_update();
    `);
    await assert.rejects(db.query(
      'select public.complete_guest_install_bonus($1, $2)', [id, proofHash],
    ));
    assert.equal((await balance(db, id)).free_credits, 0);
    assert.equal((await db.query(
      'select state from guest_install_bonus_claims where wallet_id = $1', [id],
    )).rows[0].state, 'pending');
    assert.equal((await db.query(
      "select count(*)::integer as n from credit_transactions where device_id = $1 and transaction_type = 'install_bonus'",
      [id],
    )).rows[0].n, 0);
    await db.exec('drop trigger fail_bonus_update on device_credits');
    assert.equal((await db.query(
      'select public.complete_guest_install_bonus($1, $2) as applied', [id, proofHash],
    )).rows[0].applied, true);
    assert.equal((await balance(db, id)).free_credits, 500);
  } finally {
    await db.close();
  }
});

test('new guest receives 500 once and retry keeps the same wallet and balance', async () => {
  const db = await database();
  try {
    const first = await db.query(
      'select public.register_guest_wallet_v2($1, 500) as id', [proofHash],
    );
    const id = first.rows[0].id;
    assert.equal((await balance(db, id)).free_credits, 500);
    assert.deepEqual((await db.query(
      "select transaction_type, free_delta, metadata ->> 'source' as source from credit_transactions where device_id = $1",
      [id],
    )).rows, [{ transaction_type: 'install_bonus', free_delta: 500, source: 'wallet_link_v2' }]);
    const retry = await db.query(
      'select public.register_guest_wallet_v2($1, 500) as id', [proofHash],
    );
    assert.equal(retry.rows[0].id, id);
    assert.equal((await balance(db, id)).free_credits, 500);
    assert.equal((await db.query(
      'select count(*)::integer as n from wallet_v2_credentials',
    )).rows[0].n, 1);
    assert.equal((await db.query(
      "select count(*)::integer as n from credit_transactions where device_id = $1 and transaction_type = 'install_bonus'",
      [id],
    )).rows[0].n, 1);
    await assert.rejects(db.query(
      'select public.register_guest_wallet_v2($1, 1000)', ['b'.repeat(64)],
    ));
  } finally {
    await db.close();
  }
});

test('a fresh guest secret still creates another 500 after Apple free credits were spent', async () => {
  const db = await database();
  try {
    await db.exec(`
      insert into device_credits (device_id, apple_user_id, free_credits)
      values ('apple', 'apple', 0);
      insert into credit_transactions (device_id, transaction_type, idempotency_key, free_delta)
      values ('apple', 'server_ai_usage', 'spent-install-bonus', -10);
    `);
    const first = (await db.query(
      'select public.register_guest_wallet_v2($1, 500) as id', [proofHash],
    )).rows[0].id;
    const afterReinstall = (await db.query(
      'select public.register_guest_wallet_v2($1, 500) as id', ['b'.repeat(64)],
    )).rows[0].id;

    assert.notEqual(afterReinstall, first);
    assert.equal((await balance(db, afterReinstall)).free_credits, 500);
    assert.equal((await db.query(
      "select count(*)::integer as n from credit_transactions where transaction_type = 'install_bonus'",
    )).rows[0].n, 2);
  } finally {
    await db.close();
  }
});

test('post-logout guest starts at zero and retries never grant an installation bonus', async () => {
  const db = await database();
  try {
    const id = (await db.query(
      'select public.register_guest_wallet_v2($1, 0) as id', [proofHash],
    )).rows[0].id;
    assert.equal((await balance(db, id)).free_credits, 0);
    assert.equal((await db.query(
      "select count(*)::integer as n from credit_transactions where device_id = $1 and transaction_type = 'install_bonus'",
      [id],
    )).rows[0].n, 0);
    const retry = await db.query(
      'select public.register_guest_wallet_v2($1, 500) as id', [proofHash],
    );
    assert.equal(retry.rows[0].id, id);
    assert.equal((await balance(db, id)).free_credits, 0);
  } finally {
    await db.close();
  }
});

test('verified guest merge is atomic, idempotent, and keeps only larger free balance', async () => {
  const db = await database();
  try {
    await db.exec("insert into device_credits (device_id, apple_user_id, free_credits, paid_credits) values ('apple-wallet', 'apple-sub', 100, 200)");
    const guestId = (await db.query(
      'select public.register_guest_wallet_v2($1, 500) as id', [proofHash],
    )).rows[0].id;
    await db.query('select public.activate_guest_wallet_v2($1, $2)', [guestId, proofHash]);
    await db.query('update device_credits set paid_credits = 100 where device_id = $1', [guestId]);
    const sessionHash = await appleSession(db, 'apple-sub');
    await db.query('select public.activate_apple_wallet_session($1)', [sessionHash]);
    const merge = (requestId = 'merge-1', secret = proofHash) => db.query(
      'select * from public.merge_verified_v2_guest_wallet_once($1, $2, $3, $4, $5)',
      [guestId, secret, 'apple-sub', sessionHash, requestId],
    );
    await assert.rejects(merge('merge-1', 'b'.repeat(64)));
    assert.equal((await balance(db, guestId)).free_credits, 500);
    assert.deepEqual((await merge()).rows[0], {
      decision: 'merged', canonical_wallet_id: 'apple-wallet',
      free_credits_remaining: 500, paid_credits_remaining: 300,
    });
    assert.deepEqual(await balance(db, guestId), {
      free_credits: 0, paid_credits: 0, subscription_credits: 0,
    });
    assert.deepEqual(await balance(db, 'apple-wallet'), {
      free_credits: 500, paid_credits: 300, subscription_credits: 0,
    });
    assert.equal((await merge()).rows[0].decision, 'already_merged');
    await assert.rejects(merge('merge-other'));
    assert.equal((await db.query(
      'select state from wallet_v2_credentials where wallet_id = $1', [guestId],
    )).rows[0].state, 'linked');
    assert.equal((await db.query(
      'select canonical_wallet_id from credit_wallet_aliases where source_wallet_id = $1', [guestId],
    )).rows[0].canonical_wallet_id, 'apple-wallet');
  } finally {
    await db.close();
  }
});

test('guest free use keeps Apple free balance while preserving paid credits', async () => {
  const db = await database();
  try {
    await db.exec("insert into device_credits (device_id, apple_user_id, free_credits, paid_credits) values ('apple-wallet', 'apple-sub', 100, 200)");
    const guestId = (await db.query(
      'select public.register_guest_wallet_v2($1, 500) as id', [proofHash],
    )).rows[0].id;
    await db.query('select public.activate_guest_wallet_v2($1, $2)', [guestId, proofHash]);
    await db.query('update device_credits set paid_credits = 50 where device_id = $1', [guestId]);
    await db.query(`
      insert into credit_transactions (device_id, transaction_type, idempotency_key, free_delta, created_at)
      values ($1, 'server_ai_usage', 'guest-free-use', -10, now() - interval '10 minutes')
    `, [guestId]);
    const sessionHash = await appleSession(db, 'apple-sub');
    await db.query('select public.activate_apple_wallet_session($1)', [sessionHash]);
    const result = await db.query(
      'select * from public.merge_verified_v2_guest_wallet_once($1, $2, $3, $4, $5)',
      [guestId, proofHash, 'apple-sub', sessionHash, 'guest-used-merge'],
    );
    assert.equal(result.rows[0].free_credits_remaining, 100);
    assert.equal(result.rows[0].paid_credits_remaining, 250);
    assert.equal((await balance(db, guestId)).free_credits, 0);
  } finally {
    await db.close();
  }
});

test('a later verified guest can bring paid credits without reviving a used install bonus', async () => {
  const db = await database();
  try {
    await db.exec("insert into device_credits (device_id, apple_user_id, free_credits, paid_credits) values ('apple-wallet', 'apple-sub', 100, 200)");
    const sessionHash = await appleSession(db, 'apple-sub');
    await db.query('select public.activate_apple_wallet_session($1)', [sessionHash]);
    const firstId = (await db.query(
      'select public.register_guest_wallet_v2($1, 500) as id', [proofHash],
    )).rows[0].id;
    await db.query('select public.activate_guest_wallet_v2($1, $2)', [firstId, proofHash]);
    await db.query('update device_credits set free_credits = 400 where device_id = $1', [firstId]);
    await db.query(
      "insert into credit_transactions (device_id, transaction_type, idempotency_key, free_delta, created_at) values ($1, 'server_ai_usage', 'spent-first-bonus', -100, now() - interval '10 minutes')",
      [firstId],
    );
    await db.query(
      'select * from public.merge_verified_v2_guest_wallet_once($1, $2, $3, $4, $5)',
      [firstId, proofHash, 'apple-sub', sessionHash, 'merge-first'],
    );
    assert.equal((await balance(db, 'apple-wallet')).free_credits, 100);

    const secondProof = 'b'.repeat(64);
    const secondId = (await db.query(
      'select public.register_guest_wallet_v2($1, 500) as id', [secondProof],
    )).rows[0].id;
    await db.query('select public.activate_guest_wallet_v2($1, $2)', [secondId, secondProof]);
    await db.query('update device_credits set paid_credits = 50 where device_id = $1', [secondId]);
    const second = await db.query(
      'select * from public.merge_verified_v2_guest_wallet_once($1, $2, $3, $4, $5)',
      [secondId, secondProof, 'apple-sub', sessionHash, 'merge-second'],
    );
    assert.equal(second.rows[0].free_credits_remaining, 100);
    assert.equal(second.rows[0].paid_credits_remaining, 250);
    assert.deepEqual(await balance(db, secondId), {
      free_credits: 0, paid_credits: 0, subscription_credits: 0,
    });
    assert.equal((await db.query(
      "select count(*)::integer as n from credit_v2_guest_merge_operations where apple_sub = 'apple-sub'",
    )).rows[0].n, 2);
  } finally {
    await db.close();
  }
});

test('guest merge waits for in-flight AI and refuses ambiguous purchase ownership', async () => {
  const db = await database();
  try {
    await db.exec("insert into device_credits (device_id, apple_user_id) values ('apple-wallet', 'apple-sub')");
    const guestId = (await db.query(
      'select public.register_guest_wallet_v2($1, 500) as id', [proofHash],
    )).rows[0].id;
    await db.query('select public.activate_guest_wallet_v2($1, $2)', [guestId, proofHash]);
    const sessionHash = await appleSession(db, 'apple-sub');
    await db.query('select public.activate_apple_wallet_session($1)', [sessionHash]);
    const merge = () => db.query(
      'select * from public.merge_verified_v2_guest_wallet_once($1, $2, $3, $4, $5)',
      [guestId, proofHash, 'apple-sub', sessionHash, 'merge-1'],
    );
    await db.query(
      "insert into credit_transactions (device_id, transaction_type, idempotency_key) values ($1, 'server_ai_usage', 'recent-ai')",
      [guestId],
    );
    await assert.rejects(merge());
    assert.equal((await balance(db, guestId)).free_credits, 500);
    await db.query(
      "update credit_transactions set created_at = now() - interval '10 minutes' where idempotency_key = 'recent-ai'",
    );
    await db.query(
      "insert into device_subscriptions (device_id, purchase_token) values ($1, 'purchase-1')",
      [guestId],
    );
    await assert.rejects(merge());
    assert.equal((await db.query('select count(*)::integer as n from credit_v2_guest_merge_operations')).rows[0].n, 0);
  } finally {
    await db.close();
  }
});

test('legacy wallet merge preserves paid credits and prevents a second free bonus after use', async () => {
  const db = await database();
  try {
    await db.exec(`
      insert into device_credits (device_id, apple_user_id, free_credits, paid_credits)
      values ('apple-wallet', 'apple-sub', 100, 200), ('legacy-device', null, 400, 50);
    `);
    const sessionHash = await appleSession(db, 'apple-sub');
    await db.query('select public.activate_apple_wallet_session($1)', [sessionHash]);
    const merge = (requestId = 'legacy-merge-1') => db.query(
      'select * from public.merge_verified_legacy_wallet_once($1, $2, $3, $4)',
      ['legacy-device', 'apple-sub', sessionHash, requestId],
    );
    assert.deepEqual((await merge()).rows[0], {
      decision: 'merged', canonical_wallet_id: 'apple-wallet',
      free_credits_remaining: 400, paid_credits_remaining: 250,
    });
    assert.deepEqual(await balance(db, 'legacy-device'), {
      free_credits: 0, paid_credits: 0, subscription_credits: 0,
    });
    assert.equal((await merge()).rows[0].decision, 'already_merged');
  } finally {
    await db.close();
  }
});

test('legacy merge keeps the Apple free balance after recorded free use', async () => {
  const db = await database();
  try {
    await db.exec(`
      insert into device_credits (device_id, apple_user_id, free_credits)
      values ('apple-wallet', 'apple-sub', 100), ('legacy-device', null, 400);
      insert into credit_transactions (device_id, transaction_type, idempotency_key, free_delta, created_at)
      values ('legacy-device', 'server_ai_usage', 'legacy-use', -10, now() - interval '10 minutes');
    `);
    const sessionHash = await appleSession(db, 'apple-sub');
    await db.query('select public.activate_apple_wallet_session($1)', [sessionHash]);
    const result = await db.query(
      'select * from public.merge_verified_legacy_wallet_once($1, $2, $3, $4)',
      ['legacy-device', 'apple-sub', sessionHash, 'legacy-merge-2'],
    );
    assert.equal(result.rows[0].free_credits_remaining, 100);
  } finally {
    await db.close();
  }
});

test('v2 registration starts with zero bonus and rejects a legacy wallet claim', async () => {
  const db = await database();
  try {
    const created = await db.query('select public.register_guest_wallet_v2($1) as id', [proofHash]);
    const id = created.rows[0].id;
    assert.match(id, /^v2:/);
    assert.deepEqual(await balance(db, id), {
      free_credits: 0, paid_credits: 0, subscription_credits: 0,
    });
    await db.exec("insert into device_credits (device_id, free_credits) values ('legacy', 500)");
    await assert.rejects(db.query(
      "select * from public.link_apple_wallet_v2('legacy', $1, 'apple', 'attempt-1')",
      [proofHash],
    ));
    assert.equal((await balance(db, 'legacy')).free_credits, 500);
    await assert.rejects(db.query(
      'select * from public.link_apple_wallet_v2($1, $2, $3, $4)',
      [id, proofHash, 'apple', 'attempt-1'],
    ));
  } finally {
    await db.close();
  }
});

test('v2 activation needs possession proof; Apple link is atomic and idempotent', async () => {
  const db = await database();
  try {
    const id = (await db.query('select public.register_guest_wallet_v2($1) as id', [proofHash])).rows[0].id;
    await assert.rejects(db.query(
      'select public.activate_guest_wallet_v2($1, $2)', [id, 'b'.repeat(64)],
    ));
    assert.equal((await db.query(
      'select public.activate_guest_wallet_v2($1, $2) as activated', [id, proofHash],
    )).rows[0].activated, true);
    assert.equal((await db.query(
      'select public.activate_guest_wallet_v2($1, $2) as activated', [id, proofHash],
    )).rows[0].activated, false);

    const link = (subject, key) => db.query(
      'select * from public.link_apple_wallet_v2($1, $2, $3, $4)',
      [id, proofHash, subject, key],
    );
    assert.deepEqual((await link('apple', 'attempt-1')).rows[0], {
      decision: 'linked', canonical_wallet_id: id,
    });
    assert.deepEqual((await link('apple', 'attempt-1')).rows[0], {
      decision: 'linked', canonical_wallet_id: id,
    });
    await assert.rejects(link('other-apple', 'attempt-1'));
    await assert.rejects(link('other-apple', 'attempt-2'));
    assert.equal((await db.query(
      'select count(*)::integer as n from wallet_v2_link_attempts where wallet_id = $1', [id],
    )).rows[0].n, 1);
    assert.equal((await db.query(
      'select apple_user_id from device_credits where device_id = $1', [id],
    )).rows[0].apple_user_id, 'apple');
  } finally {
    await db.close();
  }
});

test('existing Apple wallet stays intact and v2 guest is not silently merged', async () => {
  const db = await database();
  try {
    await db.exec("insert into device_credits (device_id, apple_user_id, paid_credits) values ('old-apple', 'apple', 200)");
    const id = (await db.query('select public.register_guest_wallet_v2($1) as id', [proofHash])).rows[0].id;
    await db.query('select public.activate_guest_wallet_v2($1, $2)', [id, proofHash]);
    const result = await db.query(
      'select * from public.link_apple_wallet_v2($1, $2, $3, $4)',
      [id, proofHash, 'apple', 'attempt-1'],
    );
    assert.deepEqual(result.rows[0], {
      decision: 'apple_existing_unmerged', canonical_wallet_id: 'old-apple',
    });
    assert.equal((await balance(db, 'old-apple')).paid_credits, 200);
    assert.deepEqual(await balance(db, id), {
      free_credits: 0, paid_credits: 0, subscription_credits: 0,
    });
    assert.equal((await db.query(
      'select apple_user_id from device_credits where device_id = $1', [id],
    )).rows[0].apple_user_id, null);
  } finally {
    await db.close();
  }
});

test('v2 wallet functions are not callable as anon or authenticated', async () => {
  const db = await database();
  try {
    await db.exec('set role anon');
    await assert.rejects(db.query(
      'select public.register_guest_wallet_v2($1)', [proofHash],
    ));
    await db.exec('reset role');
    await db.exec('set role authenticated');
    await assert.rejects(db.query(
      'select public.register_guest_wallet_v2($1)', [proofHash],
    ));
  } finally {
    await db.close();
  }
});

test('verified Apple subject merge keeps the larger free balance once and both paid balances', async () => {
  const db = await database();
  try {
    await db.exec(`
      insert into device_credits (device_id, apple_user_id, free_credits, paid_credits)
      values ('linked', 'apple-sub', 300, 200), ('apple-sub', null, 500, 100);
    `);
    const sessionHash = await appleSession(db, 'apple-sub');
    const merge = (key) => db.query(
      'select * from public.merge_linked_apple_subject_wallets_once($1, $2, $3)',
      ['apple-sub', key, sessionHash],
    );
    assert.deepEqual((await merge('merge-1')).rows[0], {
      decision: 'merged', canonical_wallet_id: 'linked',
      free_credits_remaining: 500, paid_credits_remaining: 300,
    });
    assert.deepEqual(await balance(db, 'linked'), {
      free_credits: 500, paid_credits: 300, subscription_credits: 0,
    });
    assert.deepEqual(await balance(db, 'apple-sub'), {
      free_credits: 0, paid_credits: 0, subscription_credits: 0,
    });
    assert.equal((await db.query(
      "select canonical_wallet_id from credit_wallet_aliases where source_wallet_id = 'apple-sub'",
    )).rows[0].canonical_wallet_id, 'linked');
    assert.equal((await db.query('select count(*)::integer as n from credit_protected_wallets')).rows[0].n, 2);
    assert.equal((await merge('merge-1')).rows[0].decision, 'already_merged');
    await assert.rejects(merge('merge-2'));
    assert.equal((await balance(db, 'linked')).paid_credits, 300);
  } finally {
    await db.close();
  }
});

test('linked Apple merge does not restore a second free grant after use', async () => {
  const db = await database();
  try {
    await db.exec(`
      insert into device_credits (device_id, apple_user_id, free_credits, paid_credits)
      values ('linked', 'apple-sub', 100, 200), ('apple-sub', null, 500, 50);
      insert into credit_transactions (device_id, transaction_type, idempotency_key, free_delta, created_at)
      values ('linked', 'server_ai_usage', 'linked-free-use', -10, now() - interval '10 minutes');
    `);
    const sessionHash = await appleSession(db, 'apple-sub');
    const result = await db.query(
      'select * from public.merge_linked_apple_subject_wallets_once($1, $2, $3)',
      ['apple-sub', 'linked-used-merge', sessionHash],
    );
    assert.equal(result.rows[0].free_credits_remaining, 100);
    assert.equal(result.rows[0].paid_credits_remaining, 250);
    assert.equal((await balance(db, 'apple-sub')).free_credits, 0);
  } finally {
    await db.close();
  }
});

test('wallet merge refuses subscription ambiguity and leaves both wallets intact', async () => {
  const db = await database();
  try {
    await db.exec(`
      insert into device_credits (device_id, apple_user_id, free_credits, paid_credits)
      values ('linked', 'apple-sub', 500, 200), ('apple-sub', null, 300, 100);
      update device_credits set subscription_credits = 4000 where device_id = 'apple-sub';
    `);
    const sessionHash = await appleSession(db, 'apple-sub');
    await assert.rejects(db.query(
      'select * from public.merge_linked_apple_subject_wallets_once($1, $2, $3)',
      ['apple-sub', 'merge-1', sessionHash],
    ));
    assert.deepEqual(await balance(db, 'linked'), {
      free_credits: 500, paid_credits: 200, subscription_credits: 0,
    });
    assert.deepEqual(await balance(db, 'apple-sub'), {
      free_credits: 300, paid_credits: 100, subscription_credits: 4000,
    });
    assert.equal((await db.query('select count(*)::integer as n from credit_wallet_aliases')).rows[0].n, 0);
  } finally {
    await db.close();
  }
});

test('wallet merge rejects a missing or unrelated session without changing balances', async () => {
  const db = await database();
  try {
    await db.exec(`
      insert into device_credits (device_id, apple_user_id, free_credits)
      values ('linked', 'apple-sub', 100), ('apple-sub', null, 500);
    `);
    await assert.rejects(db.query(
      'select * from public.merge_linked_apple_subject_wallets_once($1, $2, $3)',
      ['apple-sub', 'merge-1', 'e'.repeat(64)],
    ));
    assert.equal((await balance(db, 'apple-sub')).free_credits, 500);
    assert.equal((await db.query('select count(*)::integer as n from credit_wallet_aliases')).rows[0].n, 0);
  } finally {
    await db.close();
  }
});

test('wallet merge leaves purchase ownership untouched for review', async () => {
  const db = await database();
  try {
    await db.exec(`
      insert into device_credits (device_id, apple_user_id, free_credits)
      values ('linked', 'apple-sub', 100), ('apple-sub', null, 500);
      insert into device_subscriptions (device_id, purchase_token)
      values ('apple-sub', 'purchase-1');
    `);
    const sessionHash = await appleSession(db, 'apple-sub');
    await assert.rejects(db.query(
      'select * from public.merge_linked_apple_subject_wallets_once($1, $2, $3)',
      ['apple-sub', 'merge-1', sessionHash],
    ));
    assert.equal((await balance(db, 'apple-sub')).free_credits, 500);
    assert.equal((await db.query('select count(*)::integer as n from credit_wallet_aliases')).rows[0].n, 0);
  } finally {
    await db.close();
  }
});

test('Apple wallet session only protects a wallet after explicit activation', async () => {
  const db = await database();
  try {
    await db.exec("insert into device_credits (device_id, apple_user_id) values ('wallet', 'apple-sub')");
    const hash = 'a'.repeat(64);
    const expires = new Date(Date.now() + 60_000).toISOString();
    assert.equal((await db.query(
      'select public.issue_apple_wallet_session($1, $2, $3) as wallet_id',
      ['apple-sub', hash, expires],
    )).rows[0].wallet_id, 'wallet');
    assert.equal((await db.query('select count(*)::integer as n from credit_protected_wallets')).rows[0].n, 0);
    assert.equal((await db.query(
      'select public.activate_apple_wallet_session($1) as wallet_id', [hash],
    )).rows[0].wallet_id, 'wallet');
    assert.equal((await db.query('select wallet_id from credit_protected_wallets')).rows[0].wallet_id, 'wallet');
    await assert.rejects(db.query(
      'select public.issue_apple_wallet_session($1, $2, $3)', ['apple-sub', hash, expires],
    ));
  } finally {
    await db.close();
  }
});

test('Apple wallet session refuses an absent wallet and bad expiry without protecting anything', async () => {
  const db = await database();
  try {
    const hash = 'b'.repeat(64);
    await assert.rejects(db.query(
      'select public.issue_apple_wallet_session($1, $2, $3)',
      ['apple-sub', hash, new Date(Date.now() + 60_000).toISOString()],
    ));
    await db.exec("insert into device_credits (device_id, apple_user_id) values ('wallet', 'apple-sub')");
    await assert.rejects(db.query(
      'select public.issue_apple_wallet_session($1, $2, $3)',
      ['apple-sub', hash, new Date(Date.now() - 60_000).toISOString()],
    ));
    assert.equal((await db.query('select count(*)::integer as n from credit_wallet_sessions')).rows[0].n, 0);
  } finally {
    await db.close();
  }
});

test('wallet session RPCs are service-role only', async () => {
  const db = await database();
  try {
    await db.exec('set role anon');
    await assert.rejects(db.query('select public.activate_apple_wallet_session($1)', ['c'.repeat(64)]));
    await db.exec('reset role');
    await db.exec('set role authenticated');
    await assert.rejects(db.query('select public.activate_apple_wallet_session($1)', ['c'.repeat(64)]));
  } finally {
    await db.close();
  }
});

test('wallet session rotation is atomic, retryable, and invalidates the old token', async () => {
  const db = await database();
  try {
    await db.exec("insert into device_credits (device_id, apple_user_id) values ('wallet', 'apple-sub')");
    const oldHash = '1'.repeat(64);
    const nextHash = '2'.repeat(64);
    const expires = new Date(Date.now() + 60_000).toISOString();
    await db.query('select public.issue_apple_wallet_session($1, $2, $3)', ['apple-sub', oldHash, expires]);
    const rotate = (hash) => db.query(
      'select public.rotate_apple_wallet_session($1, $2, $3) as wallet_id',
      [oldHash, hash, expires],
    );
    assert.equal((await rotate(nextHash)).rows[0].wallet_id, 'wallet');
    assert.equal((await rotate(nextHash)).rows[0].wallet_id, 'wallet');
    await assert.rejects(rotate('3'.repeat(64)));
    const old = await db.query('select revoked_at, rotated_to_hash from credit_wallet_sessions where token_hash = $1', [oldHash]);
    assert.ok(old.rows[0].revoked_at);
    assert.equal(old.rows[0].rotated_to_hash, nextHash);
    assert.equal((await db.query('select count(*)::integer as n from credit_wallet_sessions')).rows[0].n, 2);
  } finally {
    await db.close();
  }
});

test('revoked wallet session cannot be activated or rotated', async () => {
  const db = await database();
  try {
    await db.exec("insert into device_credits (device_id, apple_user_id) values ('wallet', 'apple-sub')");
    const hash = '4'.repeat(64);
    const expires = new Date(Date.now() + 60_000).toISOString();
    await db.query('select public.issue_apple_wallet_session($1, $2, $3)', ['apple-sub', hash, expires]);
    assert.equal((await db.query('select public.revoke_apple_wallet_session($1) as revoked', [hash])).rows[0].revoked, true);
    await assert.rejects(db.query('select public.activate_apple_wallet_session($1)', [hash]));
    await assert.rejects(db.query(
      'select public.rotate_apple_wallet_session($1, $2, $3)',
      [hash, '5'.repeat(64), expires],
    ));
  } finally {
    await db.close();
  }
});
