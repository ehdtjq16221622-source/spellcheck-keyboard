import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
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
const idempotentGuestActivationSql = await readFile(
  new URL('../../migrations/20261001133132_activate_guest_wallet_v2_idempotent.sql', import.meta.url),
  'utf8',
);
const walletCreationDefaultsSql = await readFile(
  new URL('../../migrations/20261001185145_unify_wallet_creation_bonus_defaults.sql', import.meta.url),
  'utf8',
);
const walletMergeSql = await readFile(
  new URL('../../migrations/20260926234627_verified_apple_wallet_merge.sql', import.meta.url),
  'utf8',
);
const walletSessionsSql = await readFile(
  new URL('../../migrations/20260926234634_wallet_sessions.sql', import.meta.url),
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
  new URL('../../migrations/20260926234642_verified_guest_wallet_merge.sql', import.meta.url),
  'utf8',
);
const verifiedLegacyMergeSql = await readFile(
  new URL('../../migrations/20260926234650_verified_legacy_wallet_merge.sql', import.meta.url),
  'utf8',
);
const verifiedLegacySubscriptionMergeSql = await readFile(
  new URL('../../migrations/20261001140712_preserve_verified_legacy_subscription_balance.sql', import.meta.url),
  'utf8',
);
const iosSubscriptionSql = await readFile(
  new URL('../../migrations/20260927010000_atomic_ios_subscription_candidate.sql', import.meta.url),
  'utf8',
);
const verifiedPlanChangeSql = await readFile(
  new URL('../../migrations/20260930034000_verified_ios_subscription_plan_change.sql', import.meta.url),
  'utf8',
);
const googleSubscriptionSql = await readFile(
  new URL('../../migrations/20261001232517_sync_google_subscription_atomically.sql', import.meta.url),
  'utf8',
);
const atomicUsageSyncSql = await readFile(
  new URL('../../migrations/20261002120000_atomic_client_usage_sync.sql', import.meta.url),
  'utf8',
);
const subscribedGuestMergeSql = await readFile(
  new URL('../../migrations/20260927021208_verified_guest_subscription_transfer_canary.sql', import.meta.url),
  'utf8',
);
const preserveSubscribedGuestBalancesSql = await readFile(
  new URL('../../migrations/20261002190049_preserve_subscribed_guest_balances.sql', import.meta.url),
  'utf8',
);
const sharedCreditsSource = stripTypeScriptTypes(
  (await readFile(new URL('../../functions/_shared/credits.ts', import.meta.url), 'utf8'))
    .replace(/^import \{ SupabaseClient \} from .*$/m, ''),
);
const sharedCredits = await import(`data:text/javascript,${encodeURIComponent(sharedCreditsSource)}`);

async function database({ uuidLedger = false } = {}) {
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
      id ${uuidLedger ? 'uuid default gen_random_uuid()' : 'bigserial'} primary key,
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
      product_id text not null default 'monthly',
      purchase_token text unique,
      subscription_state text not null default 'SUBSCRIPTION_STATE_ACTIVE',
      expiry_time_millis bigint,
      latest_order_id text,
      last_cycle_key text,
      last_verified_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
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
  await db.exec(verifiedLegacySubscriptionMergeSql);
  await db.exec(iosSubscriptionSql);
  await db.exec(verifiedPlanChangeSql);
  await db.exec(subscribedGuestMergeSql);
  await db.exec(preserveSubscribedGuestBalancesSql);
  await db.exec(idempotentGuestActivationSql);
  await db.exec(walletCreationDefaultsSql);
  await db.exec(googleSubscriptionSql);
  await db.exec(atomicUsageSyncSql);
  return db;
}

async function balance(db, id) {
  const result = await db.query(
    'select free_credits, paid_credits, subscription_credits from device_credits where device_id = $1',
    [id],
  );
  return result.rows[0] ?? null;
}

function creditsClient(db) {
  return {
    async rpc(name, args) {
      try {
        const result = await db.query(
          `select * from public.${name}($1, $2, $3, $4, $5)`,
          [args.p_device_id, args.p_event_id, args.p_requested_free,
            args.p_requested_paid, JSON.stringify(args.p_metadata ?? {})],
        );
        return { data: result.rows, error: null };
      } catch (error) {
        return { data: null, error: { code: error.code, message: error.message } };
      }
    },
    from(table) {
      let operation = 'select';
      let payload = null;
      let columns = '*';
      const filters = [];
      const execute = async () => {
        try {
          let result;
          if (operation === 'select') {
            const where = filters.map((filter, index) => `"${filter.column}" = $${index + 1}`).join(' and ');
            result = await db.query(
              `select ${columns} from ${table}${where ? ` where ${where}` : ''}`,
              filters.map((filter) => filter.value),
            );
            return { data: result.rows, error: null };
          }
          const entries = Object.entries(payload);
          const values = entries.map(([key, value]) =>
            key === 'metadata' && typeof value !== 'string' ? JSON.stringify(value) : value);
          if (operation === 'insert') {
            const names = entries.map(([key]) => `"${key}"`).join(', ');
            const placeholders = entries.map((_, index) => `$${index + 1}`).join(', ');
            result = await db.query(
              `insert into ${table} (${names}) values (${placeholders})${columns !== '*' ? ` returning ${columns}` : ''}`,
              values,
            );
          } else {
            const sets = entries.map(([key], index) => `"${key}" = $${index + 1}`);
            const where = filters.map((filter, index) =>
              `"${filter.column}" = $${entries.length + index + 1}`);
            result = await db.query(
              `update ${table} set ${sets.join(', ')}${where.length ? ` where ${where.join(' and ')}` : ''}`,
              [...values, ...filters.map((filter) => filter.value)],
            );
          }
          return { data: result.rows ?? null, error: null };
        } catch (error) {
          return { data: null, error: { code: error.code, message: error.message } };
        }
      };
      const builder = {
        select(value = '*') { columns = value; return builder; },
        eq(column, value) { filters.push({ column, value }); return builder; },
        insert(value) { operation = 'insert'; payload = value; return builder; },
        update(value) { operation = 'update'; payload = value; return builder; },
        async maybeSingle() {
          const result = await execute();
          return { data: Array.isArray(result.data) ? result.data[0] ?? null : result.data, error: result.error };
        },
        then(resolve, reject) { return execute().then(resolve, reject); },
      };
      return builder;
    },
  };
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

test('subscription grant on a missing wallet grants subscription credits without an install bonus', async () => {
  const db = await database();
  try {
    const grant = await db.query(
      `select * from public.reset_subscription_credits(
         'new-subscriber', 4000, 'cycle-new-subscriber', '{}'::jsonb
       )`,
    );
    assert.deepEqual(grant.rows[0], {
      applied: true,
      free_credits_remaining: 0,
      paid_credits_remaining: 4000,
      credits_remaining: 4000,
    });
    assert.deepEqual(await balance(db, 'new-subscriber'), {
      free_credits: 0, paid_credits: 0, subscription_credits: 4000,
    });
    const ledger = await db.query(
      `select count(*)::int as count from credit_transactions
       where transaction_type = 'subscription_monthly_grant'
         and idempotency_key = 'cycle-new-subscriber'`,
    );
    assert.equal(ledger.rows[0].count, 1);
  } finally {
    await db.close();
  }
});

test('subscription retry returns current balance; same cycle key cannot be replayed to another wallet', async () => {
  const db = await database();
  try {
    await db.query(
      `select * from public.reset_subscription_credits(
         'subscriber-a', 4000, 'cycle-shared', '{}'::jsonb
       )`,
    );
    await db.query(
      `update device_credits set subscription_credits = 3970 where device_id = 'subscriber-a'`,
    );
    const retry = await db.query(
      `select * from public.reset_subscription_credits(
         'subscriber-a', 4000, 'cycle-shared', '{}'::jsonb
       )`,
    );
    assert.deepEqual(retry.rows[0], {
      applied: false,
      free_credits_remaining: 0,
      paid_credits_remaining: 3970,
      credits_remaining: 3970,
    });
    await assert.rejects(
      db.query(`select * from public.reset_subscription_credits(
        'subscriber-b', 4000, 'cycle-shared', '{}'::jsonb
      )`),
      /subscription cycle key belongs to another wallet/,
    );
    assert.equal(await balance(db, 'subscriber-b'), null);
  } finally {
    await db.close();
  }
});

test('AI usage cannot mint an install bonus for a missing wallet and retries stay idempotent', async () => {
  const db = await database();
  try {
    const first = await db.query(
      `select * from public.consume_ai_credits('ai-new-wallet', 'ai-request-1', 'correct')`,
    );
    assert.deepEqual(first.rows[0], {
      accepted: false,
      already_processed: false,
      free_credits_remaining: 0,
      paid_credits_remaining: 0,
      credits_remaining: 0,
    });
    const retry = await db.query(
      `select * from public.consume_ai_credits('ai-new-wallet', 'ai-request-1', 'correct')`,
    );
    assert.deepEqual(retry.rows[0], {
      accepted: false,
      already_processed: false,
      free_credits_remaining: 0,
      paid_credits_remaining: 0,
      credits_remaining: 0,
    });
    assert.deepEqual(await balance(db, 'ai-new-wallet'), {
      free_credits: 0, paid_credits: 0, subscription_credits: 0,
    });
  } finally {
    await db.close();
  }
});

test('usage synchronization cannot mint an install bonus for an absent wallet', async () => {
  const db = await database();
  try {
    const supabase = creditsClient(db);
    const synced = await sharedCredits.applyUsageEventOnce(
      supabase, 'legacy-new-device', 'legacy-first-use', 10, 0,
    );
    assert.deepEqual(synced.snapshot, { freeCredits: 0, paidCredits: 0, remaining: 0 });
    assert.deepEqual(await balance(db, 'legacy-new-device'), {
      free_credits: 0, paid_credits: 0, subscription_credits: 0,
    });

    const display = await sharedCredits.getCredits(supabase, 'legacy-display-only');
    assert.deepEqual(display, { freeCredits: 0, paidCredits: 0, remaining: 0 });
  } finally {
    await db.close();
  }
});

test('usage sync applies a wallet debit once and returns the same snapshot on retry', async () => {
  const db = await database();
  try {
    await wallets(db);
    const supabase = creditsClient(db);
    const first = await sharedCredits.applyUsageEventOnce(
      supabase, 'local', 'legacy-debit-1', 10, 5, { kind: 'correct' },
    );
    const retry = await sharedCredits.applyUsageEventOnce(
      supabase, 'local', 'legacy-debit-1', 10, 5, { kind: 'correct' },
    );
    assert.equal(first.applied, true);
    assert.equal(retry.applied, false);
    assert.deepEqual(first.snapshot, { freeCredits: 485, paidCredits: 100, remaining: 585 });
    assert.deepEqual(retry.snapshot, first.snapshot);
    assert.equal((await db.query(`
      select count(*)::int as count from credit_transactions
      where transaction_type = 'client_usage_sync' and idempotency_key = 'legacy-debit-1'
    `)).rows[0].count, 1);
  } finally {
    await db.close();
  }
});

test('concurrent retries of one usage event apply only one debit', async () => {
  const db = await database();
  try {
    await wallets(db);
    const supabase = creditsClient(db);
    const results = await Promise.all([
      sharedCredits.applyUsageEventOnce(supabase, 'local', 'legacy-concurrent-event', 10, 0),
      sharedCredits.applyUsageEventOnce(supabase, 'local', 'legacy-concurrent-event', 10, 0),
    ]);
    assert.equal(results.filter((result) => result.applied).length, 1);
    assert.deepEqual(await balance(db, 'local'), {
      free_credits: 490, paid_credits: 100, subscription_credits: 0,
    });
    assert.equal((await db.query(`
      select count(*)::int as count from credit_transactions
      where transaction_type = 'client_usage_sync' and idempotency_key = 'legacy-concurrent-event'
    `)).rows[0].count, 1);
  } finally {
    await db.close();
  }
});

test('usage sync supports the production UUID transaction ID and retries once', async () => {
  const db = await database({ uuidLedger: true });
  try {
    await wallets(db);
    const client = creditsClient(db);
    const first = await sharedCredits.applyUsageEventOnce(client, 'local', 'uuid-usage', 10, 0);
    const retry = await sharedCredits.applyUsageEventOnce(client, 'local', 'uuid-usage', 10, 0);
    assert.equal(first.applied, true);
    assert.equal(retry.applied, false);
    assert.deepEqual(first.snapshot, retry.snapshot);
    assert.equal(first.snapshot.remaining, 590);
    assert.equal((await db.query("select count(*)::int as n from credit_transactions where idempotency_key = 'uuid-usage'")).rows[0].n, 1);
  } finally {
    await db.close();
  }
});

test('usage sync rolls back the debit if updating its ledger entry fails', async () => {
  const db = await database();
  try {
    await wallets(db);
    await db.exec(`
      create function fail_usage_ledger_update() returns trigger language plpgsql as $$
      begin
        if new.transaction_type = 'client_usage_sync' then raise exception 'injected ledger failure'; end if;
        return new;
      end $$;
      create trigger fail_usage_ledger_update before update on credit_transactions
      for each row execute function fail_usage_ledger_update();
    `);
    const supabase = creditsClient(db);
    await assert.rejects(sharedCredits.applyUsageEventOnce(
      supabase, 'local', 'legacy-debit-failure', 10, 0,
    ), (error) => error?.message === 'injected ledger failure');
    assert.deepEqual(await balance(db, 'local'), {
      free_credits: 500, paid_credits: 100, subscription_credits: 0,
    });
    assert.equal((await db.query(`
      select count(*)::int as count from credit_transactions
      where transaction_type = 'client_usage_sync' and idempotency_key = 'legacy-debit-failure'
    `)).rows[0].count, 0);
  } finally {
    await db.close();
  }
});

test('usage event keys cannot be replayed against a different wallet', async () => {
  const db = await database();
  try {
    await wallets(db);
    const supabase = creditsClient(db);
    await sharedCredits.applyUsageEventOnce(supabase, 'local', 'wallet-bound-event', 10, 0);
    await assert.rejects(sharedCredits.applyUsageEventOnce(
      supabase, 'apple', 'wallet-bound-event', 10, 0,
    ), (error) => error?.message?.includes('belongs to another wallet'));
    assert.deepEqual(await balance(db, 'apple'), {
      free_credits: 0, paid_credits: 200, subscription_credits: 0,
    });
  } finally {
    await db.close();
  }
});

test('legacy incomplete usage markers fail closed instead of risking a second debit', async () => {
  const db = await database();
  try {
    await wallets(db);
    await db.exec(`
      update device_credits set free_credits = 490 where device_id = 'local';
      insert into credit_transactions
        (device_id, transaction_type, idempotency_key, free_delta, metadata)
      values ('local', 'client_usage_sync', 'legacy-pending-event', 0,
        '{"applied":false}'::jsonb);
    `);
    await assert.rejects(sharedCredits.applyUsageEventOnce(
      creditsClient(db), 'local', 'legacy-pending-event', 10, 0,
    ), (error) => error?.message?.includes('requires reconciliation'));
    assert.deepEqual(await balance(db, 'local'), {
      free_credits: 490, paid_credits: 100, subscription_credits: 0,
    });
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

test('candidate subscription sync grants once and never creates free install credits', async () => {
  const db = await database();
  try {
    const sql = `select * from public.sync_ios_subscription_once(
      'apple', 'monthly', 'purchase-1', 'SUBSCRIPTION_STATE_ACTIVE',
      1800000000000, 'order-1', 'cycle-1', 9000, '{}'::jsonb)`;
    assert.equal((await db.query(sql)).rows[0].applied, true);
    assert.deepEqual(await balance(db, 'apple'), {
      free_credits: 0, paid_credits: 0, subscription_credits: 9000,
    });
    await db.exec("update device_credits set subscription_credits = 8990 where device_id = 'apple'");
    assert.equal((await db.query(sql)).rows[0].applied, false);
    assert.equal((await balance(db, 'apple')).subscription_credits, 8990);
    assert.equal((await db.query("select count(*)::int as count from credit_transactions where transaction_type = 'subscription_monthly_grant'")).rows[0].count, 1);
  } finally {
    await db.close();
  }
});

test('Google subscription row and monthly grant commit atomically and retries do not double grant', async () => {
  const db = await database();
  try {
    const sql = `select * from public.sync_google_subscription_once(
      'android-wallet', 'basic.monthly', 'google-purchase-1', 'SUBSCRIPTION_STATE_ACTIVE',
      1800000000000, 'google-order-1', 'google:fp-google-1',
      4000, '{"audit_id":"audit-google-1","transaction_fingerprint":"fp-google-1","google_purchase_verified":true}'::jsonb)`;
    const first = (await db.query(sql)).rows[0];
    assert.equal(first.applied, true);
    assert.equal(first.credits_remaining, 4000);
    assert.deepEqual(await balance(db, 'android-wallet'), {
      free_credits: 0, paid_credits: 0, subscription_credits: 4000,
    });
    const subscription = (await db.query(
      "select device_id, purchase_token, subscription_state from device_subscriptions where device_id = 'android-wallet'",
    )).rows[0];
    assert.deepEqual(subscription, {
      device_id: 'android-wallet',
      purchase_token: 'google-purchase-1',
      subscription_state: 'SUBSCRIPTION_STATE_ACTIVE',
    });
    const ledger = (await db.query(
      "select idempotency_key, metadata->>'audit_id' as audit_id, metadata->>'transaction_fingerprint' as transaction_fingerprint, metadata ? 'purchase_token' as has_purchase_token from credit_transactions where transaction_type = 'subscription_monthly_grant'",
    )).rows[0];
    assert.equal(ledger.audit_id, 'audit-google-1');
    assert.equal(ledger.transaction_fingerprint, 'fp-google-1');
    assert.equal(ledger.has_purchase_token, false);
    assert.equal(ledger.idempotency_key.includes('google-purchase-1'), false);

    assert.equal((await db.query(sql)).rows[0].applied, false);
    assert.equal((await db.query(
      "select count(*)::int as count from credit_transactions where transaction_type = 'subscription_monthly_grant'",
    )).rows[0].count, 1);
  } finally {
    await db.close();
  }
});

test('Google atomic rollout reuses the legacy idempotency key for an already-paid billing cycle', async () => {
  const db = await database();
  try {
    const legacyCycleKey = 'google-purchase-1:basic.monthly:cycle-1';
    await db.query(`select * from public.reset_subscription_credits(
      'android-wallet', 4000, $1, '{"legacy_path":true}'::jsonb)`, [legacyCycleKey]);
    await db.exec("update device_credits set subscription_credits = 3000 where device_id = 'android-wallet'");

    const migrated = (await db.query(`select * from public.sync_google_subscription_once(
      'android-wallet', 'basic.monthly', 'google-purchase-1', 'SUBSCRIPTION_STATE_ACTIVE',
      1800000000000, 'google-order-1', $1, 4000,
      '{"audit_id":"audit-google-rollout","google_purchase_verified":true}'::jsonb)`,
    [legacyCycleKey])).rows[0];

    assert.equal(migrated.applied, false);
    assert.equal(migrated.credits_remaining, 3000);
    assert.equal((await balance(db, 'android-wallet')).subscription_credits, 3000);
    assert.equal((await db.query(
      "select count(*)::int as count from credit_transactions where transaction_type = 'subscription_monthly_grant'",
    )).rows[0].count, 1);
  } finally {
    await db.close();
  }
});

test('Google subscription owner conflict leaves both wallets and rows unchanged', async () => {
  const db = await database();
  try {
    await db.query(`select * from public.sync_google_subscription_once(
      'owner-wallet', 'basic.monthly', 'google-purchase-1', 'SUBSCRIPTION_STATE_ACTIVE',
      1800000000000, 'google-order-1', 'google-purchase-1:basic.monthly:cycle-1',
      4000, '{"google_purchase_verified":true}'::jsonb)`);
    await db.exec("insert into device_credits (device_id, free_credits, paid_credits, subscription_credits) values ('other-wallet', 120, 30, 40)");

    await assert.rejects(db.query(`select * from public.sync_google_subscription_once(
      'other-wallet', 'basic.monthly', 'google-purchase-1', 'SUBSCRIPTION_STATE_ACTIVE',
      1800000000000, 'google-order-1', 'google-purchase-1:basic.monthly:cycle-1',
      4000, '{"google_purchase_verified":true}'::jsonb)`), /Google subscription owner transfer requires review/);
    assert.deepEqual(await balance(db, 'owner-wallet'), {
      free_credits: 0, paid_credits: 0, subscription_credits: 4000,
    });
    assert.deepEqual(await balance(db, 'other-wallet'), {
      free_credits: 120, paid_credits: 30, subscription_credits: 40,
    });
    assert.equal((await db.query('select count(*)::int as count from device_subscriptions')).rows[0].count, 1);
    assert.equal((await db.query("select count(*)::int as count from credit_transactions where transaction_type = 'subscription_monthly_grant'")).rows[0].count, 1);
  } finally {
    await db.close();
  }
});

test('Google subscription RPC is service-role only', async () => {
  const db = await database();
  try {
    const result = await db.query(`select has_function_privilege(
      'anon',
      'public.sync_google_subscription_once(text,text,text,text,bigint,text,text,integer,jsonb)',
      'EXECUTE') as anon_allowed,
      has_function_privilege(
      'authenticated',
      'public.sync_google_subscription_once(text,text,text,text,bigint,text,text,integer,jsonb)',
      'EXECUTE') as authenticated_allowed,
      has_function_privilege(
      'service_role',
      'public.sync_google_subscription_once(text,text,text,text,bigint,text,text,integer,jsonb)',
      'EXECUTE') as service_allowed`);
    assert.deepEqual(result.rows[0], {
      anon_allowed: false, authenticated_allowed: false, service_allowed: true,
    });
  } finally {
    await db.close();
  }
});

test('candidate subscription sync blocks a plan upgrade without current Apple status', async () => {
  const db = await database();
  try {
    await db.query(`select * from public.sync_ios_subscription_once(
      'apple', 'monthly_basic', 'purchase-1', 'SUBSCRIPTION_STATE_ACTIVE',
      1800000000000, 'order-1', 'purchase-1:monthly_basic:cycle-1', 4000, '{}'::jsonb)`);
    await assert.rejects(db.query(`select * from public.sync_ios_subscription_once(
      'apple', 'monthly_premium', 'purchase-1', 'SUBSCRIPTION_STATE_ACTIVE',
      1800000100000, 'order-2', 'purchase-1:monthly_premium:cycle-2', 9000, '{}'::jsonb)`),
    /subscription plan change requires Apple current-status verification/);
    assert.deepEqual(await balance(db, 'apple'), {
      free_credits: 0, paid_credits: 0, subscription_credits: 4000,
    });
    assert.equal((await db.query("select count(*)::int as count from credit_transactions where transaction_type = 'subscription_monthly_grant'")).rows[0].count, 1);
  } finally {
    await db.close();
  }
});

test('verified plan upgrade replaces subscription credits once and preserves paid credits', async () => {
  const db = await database();
  try {
    const basic = `select * from public.sync_ios_subscription_once(
      'apple', 'monthly_basic', 'purchase-1', 'SUBSCRIPTION_STATE_ACTIVE',
      1800000000000, 'order-1', 'purchase-1:monthly_basic:cycle-1',
      4000, '{}'::jsonb)`;
    const premium = `select * from public.sync_ios_subscription_once(
      'apple', 'monthly_premium', 'purchase-1', 'SUBSCRIPTION_STATE_ACTIVE',
      1800000100000, 'order-2', 'purchase-1:monthly_premium:cycle-2',
      9000, '{"apple_current_product_verified":true}'::jsonb)`;
    assert.equal((await db.query(basic)).rows[0].applied, true);
    await db.exec("update device_credits set paid_credits = 200, subscription_credits = 3500 where device_id = 'apple'");
    assert.equal((await db.query(premium)).rows[0].applied, true);
    assert.deepEqual(await balance(db, 'apple'), {
      free_credits: 0, paid_credits: 200, subscription_credits: 9000,
    });
    await db.exec("update device_credits set subscription_credits = 8990 where device_id = 'apple'");
    const restoredPremium = premium.replace(
      '{"apple_current_product_verified":true}', '{}',
    );
    assert.equal((await db.query(restoredPremium)).rows[0].applied, false);
    assert.equal((await balance(db, 'apple')).subscription_credits, 8990);
    assert.equal((await db.query("select count(*)::int as count from credit_transactions where transaction_type = 'subscription_monthly_grant'")).rows[0].count, 2);
    await assert.rejects(db.query(basic), /subscription plan change requires Apple current-status verification/);
    assert.equal((await balance(db, 'apple')).subscription_credits, 8990);
  } finally {
    await db.close();
  }
});

test('older subscription expiry cannot replace a newer verified cycle', async () => {
  const db = await database();
  try {
    await db.query(`select * from public.sync_ios_subscription_once(
      'apple', 'monthly_premium', 'purchase-1', 'SUBSCRIPTION_STATE_ACTIVE',
      1800000100000, 'order-2', 'purchase-1:monthly_premium:cycle-2',
      9000, '{}'::jsonb)`);
    await assert.rejects(db.query(`select * from public.sync_ios_subscription_once(
      'apple', 'monthly_premium', 'purchase-1', 'SUBSCRIPTION_STATE_ACTIVE',
      1800000000000, 'order-1', 'purchase-1:monthly_premium:cycle-1',
      9000, '{}'::jsonb)`), /stale subscription transaction/);
    assert.equal((await balance(db, 'apple')).subscription_credits, 9000);
  } finally {
    await db.close();
  }
});

test('failed plan upgrade rolls back and retry grants the new plan once', async () => {
  const db = await database();
  try {
    await db.query(`select * from public.sync_ios_subscription_once(
      'apple', 'monthly_basic', 'purchase-1', 'SUBSCRIPTION_STATE_ACTIVE',
      1800000000000, 'order-1', 'purchase-1:monthly_basic:cycle-1',
      4000, '{}'::jsonb)`);
    const upgrade = `select * from public.sync_ios_subscription_once(
      'apple', 'monthly_premium', 'purchase-1', 'SUBSCRIPTION_STATE_ACTIVE',
      1800000100000, 'order-2', 'purchase-1:monthly_premium:cycle-2',
      9000, '{"apple_current_product_verified":true}'::jsonb)`;
    await db.exec(`create function reject_upgrade() returns trigger language plpgsql as $$
      begin if new.idempotency_key = 'purchase-1:monthly_premium:cycle-2'
        then raise exception 'injected upgrade ledger failure'; end if;
        return new; end $$;
      create trigger reject_upgrade before insert on credit_transactions
      for each row execute function reject_upgrade();`);
    await assert.rejects(db.query(upgrade), /injected upgrade ledger failure/);
    assert.equal((await balance(db, 'apple')).subscription_credits, 4000);
    assert.equal((await db.query("select product_id from device_subscriptions where device_id = 'apple'")).rows[0].product_id, 'monthly_basic');
    await db.exec('drop trigger reject_upgrade on credit_transactions');
    assert.equal((await db.query(upgrade)).rows[0].applied, true);
    assert.equal((await db.query(upgrade)).rows[0].applied, false);
    assert.equal((await balance(db, 'apple')).subscription_credits, 9000);
    assert.equal((await db.query("select count(*)::int as count from credit_transactions where transaction_type = 'subscription_monthly_grant'")).rows[0].count, 2);
  } finally {
    await db.close();
  }
});

test('legacy subscription record move strands a grant on the old wallet', async () => {
  const db = await database();
  try {
    await db.query(`select * from public.sync_ios_subscription_once(
      'old', 'monthly', 'purchase-1', 'SUBSCRIPTION_STATE_ACTIVE',
      1800000000000, 'order-1', 'purchase-1:monthly:cycle-1', 9000, '{}'::jsonb)`);
    await db.exec("insert into device_credits (device_id, apple_user_id) values ('apple', 'apple-sub')");

    // The legacy restore path reassigns the purchase row separately from credits.
    await db.exec("update device_subscriptions set device_id = 'apple' where purchase_token = 'purchase-1'");
    assert.equal((await balance(db, 'apple')).subscription_credits, 0);
    assert.equal((await balance(db, 'old')).subscription_credits, 9000);
    assert.equal((await db.query(`select device_id from credit_transactions
      where transaction_type = 'subscription_monthly_grant'
      and idempotency_key = 'purchase-1:monthly:cycle-1'`)).rows[0].device_id, 'old');

    await assert.rejects(db.query(`select * from public.sync_ios_subscription_once(
      'apple', 'monthly', 'purchase-1', 'SUBSCRIPTION_STATE_ACTIVE',
      1800000000000, 'order-1', 'purchase-1:monthly:cycle-1', 9000, '{}'::jsonb)`));
    assert.equal((await balance(db, 'apple')).subscription_credits, 0);
  } finally {
    await db.close();
  }
});

test('candidate subscription sync rolls back ownership record and grant together', async () => {
  const db = await database();
  try {
    await db.exec(`create function reject_grant() returns trigger language plpgsql as $$
      begin if new.transaction_type = 'subscription_monthly_grant' then
        raise exception 'injected ledger failure'; end if; return new; end $$;
      create trigger reject_grant before insert on credit_transactions
      for each row execute function reject_grant();`);
    const sql = `select * from public.sync_ios_subscription_once(
      'apple', 'monthly', 'purchase-1', 'SUBSCRIPTION_STATE_ACTIVE',
      1800000000000, 'order-1', 'cycle-1', 9000, '{}'::jsonb)`;
    await assert.rejects(db.query(sql));
    assert.equal((await db.query('select count(*)::int as count from device_subscriptions')).rows[0].count, 0);
    assert.equal(await balance(db, 'apple'), null);
    await db.exec('drop trigger reject_grant on credit_transactions');
    assert.equal((await db.query(sql)).rows[0].applied, true);
  } finally {
    await db.close();
  }
});

test('candidate subscription sync refuses ambiguous ownership without changing either wallet', async () => {
  const db = await database();
  try {
    await db.exec(`insert into device_credits (device_id, free_credits, subscription_credits)
      values ('old', 50, 100), ('new', 70, 0)`);
    await db.exec(`insert into device_subscriptions (device_id, purchase_token)
      values ('old', 'purchase-1')`);
    await assert.rejects(db.query(`select * from public.sync_ios_subscription_once(
      'new', 'monthly', 'purchase-1', 'SUBSCRIPTION_STATE_ACTIVE',
      1800000000000, 'order-1', 'cycle-1', 9000, '{}'::jsonb)`));
    assert.equal((await db.query("select device_id from device_subscriptions where purchase_token = 'purchase-1'")).rows[0].device_id, 'old');
    assert.equal((await balance(db, 'new')).subscription_credits, 0);
  } finally {
    await db.close();
  }
});

test('candidate subscription sync records an expired purchase without granting credits', async () => {
  const db = await database();
  try {
    const result = await db.query(`select * from public.sync_ios_subscription_once(
      'apple', 'monthly', 'purchase-1', 'SUBSCRIPTION_STATE_EXPIRED',
      1700000000000, 'order-1', null, 9000, '{}'::jsonb)`);
    assert.equal(result.rows[0].applied, false);
    assert.equal(result.rows[0].credits_remaining, 0);
    assert.equal(await balance(db, 'apple'), null);
    assert.equal((await db.query('select count(*)::int as count from device_subscriptions')).rows[0].count, 1);
  } finally {
    await db.close();
  }
});

test('candidate subscription sync refuses an ambiguous plan change without a second grant', async () => {
  const db = await database();
  try {
    await db.query(`select * from public.sync_ios_subscription_once(
      'apple', 'monthly', 'purchase-1', 'SUBSCRIPTION_STATE_ACTIVE',
      1800000000000, 'order-1', 'cycle-1', 9000, '{}'::jsonb)`);
    await assert.rejects(db.query(`select * from public.sync_ios_subscription_once(
      'apple', 'annual', 'purchase-1', 'SUBSCRIPTION_STATE_ACTIVE',
      1800000000000, 'order-2', 'cycle-1-annual', 10000, '{}'::jsonb)`));
    assert.equal((await balance(db, 'apple')).subscription_credits, 9000);
    assert.equal((await db.query("select count(*)::int as count from credit_transactions where transaction_type = 'subscription_monthly_grant'")).rows[0].count, 1);
  } finally {
    await db.close();
  }
});

test('candidate subscription sync is service-role only', async () => {
  const db = await database();
  try {
    const result = await db.query(`select has_function_privilege(
      'anon',
      'public.sync_ios_subscription_once(text,text,text,text,bigint,text,text,integer,jsonb)',
      'EXECUTE') as anon_allowed,
      has_function_privilege(
      'authenticated',
      'public.sync_ios_subscription_once(text,text,text,text,bigint,text,text,integer,jsonb)',
      'EXECUTE') as authenticated_allowed,
      has_function_privilege(
      'service_role',
      'public.sync_ios_subscription_once(text,text,text,text,bigint,text,text,integer,jsonb)',
      'EXECUTE') as service_allowed`);
    assert.deepEqual(result.rows[0], {
      anon_allowed: false, authenticated_allowed: false, service_allowed: true,
    });
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

test('concurrent registration retries with the same persisted secret resolve to one 500-credit wallet', async () => {
  const db = await database();
  try {
    const secretHash = 'c'.repeat(64);
    const registrations = await Promise.all([
      db.query('select public.register_guest_wallet_v2($1, 0) as id', [secretHash]),
      db.query('select public.register_guest_wallet_v2($1, 0) as id', [secretHash]),
    ]);
    const walletIds = registrations.map((result) => result.rows[0].id);
    assert.equal(walletIds[0], walletIds[1]);

    await Promise.all(walletIds.map((id) => db.query(
      'select public.reserve_guest_install_bonus($1, $2)', [id, secretHash],
    )));
    await Promise.all(walletIds.map((id) => db.query(
      'select public.complete_guest_install_bonus($1, $2)', [id, secretHash],
    )));

    assert.deepEqual(await balance(db, walletIds[0]), {
      free_credits: 500, paid_credits: 0, subscription_credits: 0,
    });
    assert.equal((await db.query(
      "select count(*)::int as count from credit_transactions where transaction_type = 'install_bonus'",
    )).rows[0].count, 1);
    assert.equal((await db.query('select count(*)::int as count from wallet_v2_credentials')).rows[0].count, 1);
  } finally {
    await db.close();
  }
});

test('service-role guest registration can create multiple 500 wallets for fresh secrets', async () => {
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

test('verified guest subscription adds to existing Apple balance and replay returns current balance', async () => {
  const db = await database();
  try {
    await db.exec("insert into device_credits (device_id, apple_user_id, free_credits, paid_credits, subscription_credits) values ('apple-wallet', 'apple-sub', 100, 200, 600)");
    const guestId = (await db.query(
      'select public.register_guest_wallet_v2($1, 500) as id', [proofHash],
    )).rows[0].id;
    await db.query('select public.activate_guest_wallet_v2($1, $2)', [guestId, proofHash]);
    await db.query(
      'update device_credits set paid_credits = 100, subscription_credits = 3000 where device_id = $1',
      [guestId],
    );
    await db.query(`
      insert into device_subscriptions (device_id, product_id, purchase_token, expiry_time_millis)
      values ($1, 'monthly', 'purchase-1', (extract(epoch from now() + interval '30 days') * 1000)::bigint)
    `, [guestId]);
    await db.query(`
      insert into credit_transactions (device_id, transaction_type, idempotency_key, metadata)
      values ($1, 'subscription_monthly_grant', 'purchase-1:monthly:cycle-1',
        '{"originalTransactionId":"purchase-1","productId":"monthly","subscription_credits":4000}'::jsonb)
    `, [guestId]);
    await db.query(`
      insert into credit_transactions (device_id, transaction_type, idempotency_key, metadata)
      values ('apple-wallet', 'subscription_monthly_grant', 'purchase-1:monthly:previous-cycle',
        '{"originalTransactionId":"purchase-1","productId":"monthly","subscription_credits":4000}'::jsonb)
    `);
    const sessionHash = await appleSession(db, 'apple-sub');
    await db.query('select public.activate_apple_wallet_session($1)', [sessionHash]);
    const transfer = (request = 'subscription-merge-1', secret = proofHash) => db.query(
      'select * from public.merge_verified_v2_subscribed_guest_preserving_once($1, $2, $3, $4, $5, $6)',
      [guestId, secret, 'apple-sub', sessionHash, request, 'purchase-1'],
    );
    assert.deepEqual((await transfer()).rows[0], {
      decision: 'merged', canonical_wallet_id: 'apple-wallet',
      free_credits_remaining: 500, paid_credits_remaining: 3900,
    });
    assert.deepEqual(await balance(db, guestId), {
      free_credits: 0, paid_credits: 0, subscription_credits: 0,
    });
    assert.deepEqual(await balance(db, 'apple-wallet'), {
      free_credits: 500, paid_credits: 300, subscription_credits: 3600,
    });
    assert.equal((await db.query(
      "select device_id from device_subscriptions where purchase_token = 'purchase-1'",
    )).rows[0].device_id, 'apple-wallet');
    assert.equal((await db.query(
      "select device_id from credit_transactions where idempotency_key = 'purchase-1:monthly:cycle-1'",
    )).rows[0].device_id, guestId);
    await db.query("update device_credits set subscription_credits = 2500 where device_id = 'apple-wallet'");
    assert.deepEqual((await transfer()).rows[0], {
      decision: 'already_merged', canonical_wallet_id: 'apple-wallet',
      free_credits_remaining: 500, paid_credits_remaining: 2800,
    });
    await assert.rejects(transfer('different-request'));
    const refresh = await db.query(`select * from public.sync_ios_subscription_once(
      'apple-wallet', 'monthly', 'purchase-1', 'SUBSCRIPTION_STATE_ACTIVE',
      (extract(epoch from now() + interval '30 days') * 1000)::bigint,
      'order-1', 'purchase-1:monthly:cycle-1', 4000, '{}'::jsonb)`);
    assert.equal(refresh.rows[0].applied, false);
    assert.equal((await balance(db, 'apple-wallet')).subscription_credits, 2500);
    const renewal = await db.query(`select * from public.sync_ios_subscription_once(
      'apple-wallet', 'monthly', 'purchase-1', 'SUBSCRIPTION_STATE_ACTIVE',
      (extract(epoch from now() + interval '60 days') * 1000)::bigint,
      'order-2', 'purchase-1:monthly:cycle-2', 4000, '{}'::jsonb)`);
    assert.equal(renewal.rows[0].applied, true);
    assert.equal((await balance(db, 'apple-wallet')).subscription_credits, 4000);
    assert.deepEqual((await transfer()).rows[0], {
      decision: 'already_merged', canonical_wallet_id: 'apple-wallet',
      free_credits_remaining: 500, paid_credits_remaining: 4300,
    });
    assert.equal((await db.query(
      "select device_id from credit_transactions where idempotency_key = 'purchase-1:monthly:cycle-2'",
    )).rows[0].device_id, 'apple-wallet');
  } finally {
    await db.close();
  }
});

test('guest subscription transfer rolls back on bad proof or competing Apple purchase', async () => {
  const db = await database();
  try {
    await db.exec("insert into device_credits (device_id, apple_user_id) values ('apple-wallet', 'apple-sub')");
    const guestId = (await db.query(
      'select public.register_guest_wallet_v2($1, 500) as id', [proofHash],
    )).rows[0].id;
    await db.query('select public.activate_guest_wallet_v2($1, $2)', [guestId, proofHash]);
    await db.query('update device_credits set subscription_credits = 3000 where device_id = $1', [guestId]);
    await db.query(`
      insert into device_subscriptions (device_id, purchase_token, expiry_time_millis)
      values ($1, 'purchase-1', (extract(epoch from now() + interval '30 days') * 1000)::bigint)
    `, [guestId]);
    const sessionHash = await appleSession(db, 'apple-sub');
    await db.query('select public.activate_apple_wallet_session($1)', [sessionHash]);
    const transfer = (secret = proofHash) => db.query(
      'select * from public.merge_verified_v2_subscribed_guest_preserving_once($1, $2, $3, $4, $5, $6)',
      [guestId, secret, 'apple-sub', sessionHash, 'subscription-merge-1', 'purchase-1'],
    );
    await assert.rejects(transfer('b'.repeat(64)));
    await assert.rejects(transfer());
    await db.exec("insert into device_subscriptions (device_id, purchase_token) values ('apple-wallet', 'purchase-2')");
    await assert.rejects(transfer());
    assert.equal((await balance(db, guestId)).subscription_credits, 3000);
    assert.equal((await balance(db, 'apple-wallet')).subscription_credits, 0);
    assert.equal((await db.query(
      "select device_id from device_subscriptions where purchase_token = 'purchase-1'",
    )).rows[0].device_id, guestId);
    assert.equal((await db.query(
      'select count(*)::integer as n from credit_v2_subscription_transfer_grants',
    )).rows[0].n, 0);
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

test('verified legacy merge preserves remaining subscription balance exactly once', async () => {
  const db = await database();
  try {
    await db.exec(`
      insert into device_credits
        (device_id, apple_user_id, free_credits, paid_credits, subscription_credits)
      values ('apple-wallet', 'apple-sub', 40, 60, 1100),
             ('legacy-device', null, 490, 20, 4000);
      insert into credit_transactions
        (device_id, transaction_type, idempotency_key, free_delta, metadata, created_at)
      values ('legacy-device', 'server_ai_usage', 'legacy-free-use', -10,
        '{}'::jsonb, now() - interval '10 minutes'),
        ('legacy-device', 'subscription_monthly_grant', 'legacy-sub-grant', 0,
         '{"originalTransactionId":"1234567890","productId":"com.kingboard.app.monthly_basic","subscription_credits":5000}'::jsonb, now()),
        ('apple-wallet', 'subscription_monthly_grant', 'apple-sub-grant', 0,
         '{"originalTransactionId":"1234567890","productId":"com.kingboard.app.monthly_basic","subscription_credits":4000}'::jsonb, now());
      insert into device_subscriptions (device_id, product_id, purchase_token)
      values ('legacy-device', 'com.kingboard.app.monthly_basic', '1234567890');
    `);
    const sessionHash = await appleSession(db, 'apple-sub');
    await db.query('select public.activate_apple_wallet_session($1)', [sessionHash]);
    const merge = (requestId = 'legacy-subscription-merge') => db.query(
      `select * from public.merge_verified_legacy_wallet_v2_once(
        $1, $2, $3, $4, $5, $6
      )`,
      ['legacy-device', 'apple-sub', sessionHash, requestId,
       '1234567890', 'com.kingboard.app.monthly_basic'],
    );
    assert.deepEqual((await merge()).rows[0], {
      decision: 'merged', canonical_wallet_id: 'apple-wallet',
      free_credits_remaining: 40, paid_credits_remaining: 80,
      subscription_credits_remaining: 5100,
    });
    assert.deepEqual(await balance(db, 'legacy-device'), {
      free_credits: 0, paid_credits: 0, subscription_credits: 0,
    });
    assert.deepEqual(await balance(db, 'apple-wallet'), {
      free_credits: 40, paid_credits: 80, subscription_credits: 5100,
    });
    assert.equal((await db.query(
      "select count(*)::int as n from device_subscriptions where device_id = 'apple-wallet'",
    )).rows[0].n, 1);
    await db.exec(`
      update device_credits
      set free_credits = 35, paid_credits = 75, subscription_credits = 5050
      where device_id = 'apple-wallet';
    `);
    const retry = await merge();
    assert.deepEqual(retry.rows[0], {
      decision: 'already_merged', canonical_wallet_id: 'apple-wallet',
      free_credits_remaining: 35, paid_credits_remaining: 75,
      subscription_credits_remaining: 5050,
    });
    const transfer = await db.query(`
      select free_delta, paid_delta, metadata from credit_transactions
      where device_id = 'apple-wallet' and transaction_type = 'legacy_wallet_merge'
        and idempotency_key = 'legacy-merge:legacy-subscription-merge'
    `);
    assert.equal(transfer.rows.length, 1);
    assert.equal(transfer.rows[0].paid_delta, 20);
    assert.equal(transfer.rows[0].metadata.subscription_delta, 4000);
    assert.equal(transfer.rows[0].metadata.subscription_credits_after, 5100);
    await assert.rejects(merge('different-request'));
    assert.equal((await balance(db, 'apple-wallet')).subscription_credits, 5050);
  } finally {
    await db.close();
  }
});

test('verified legacy merge transfers a zero-balance purchase mapping without granting credits', async () => {
  const db = await database();
  try {
    await db.exec(`
      insert into device_credits
        (device_id, apple_user_id, free_credits, paid_credits, subscription_credits)
      values ('apple-wallet', 'apple-sub', 40, 60, 0),
             ('legacy-device', null, 500, 0, 0);
      insert into device_subscriptions (device_id, product_id, purchase_token)
      values ('legacy-device', 'com.kingboard.app.monthly_basic', '1234567890');
    `);
    const sessionHash = await appleSession(db, 'apple-sub');
    await db.query('select public.activate_apple_wallet_session($1)', [sessionHash]);
    const merge = (key) => db.query(
      `select * from public.merge_verified_legacy_wallet_v2_once(
        'legacy-device', 'apple-sub', $1, $2, '1234567890', 'com.kingboard.app.monthly_basic'
      )`, [sessionHash, key],
    );
    assert.deepEqual((await merge('zero-sub-map')).rows[0], {
      decision: 'merged', canonical_wallet_id: 'apple-wallet',
      free_credits_remaining: 500, paid_credits_remaining: 60,
      subscription_credits_remaining: 0,
    });
    assert.deepEqual(await balance(db, 'legacy-device'), {
      free_credits: 0, paid_credits: 0, subscription_credits: 0,
    });
    assert.deepEqual(await balance(db, 'apple-wallet'), {
      free_credits: 500, paid_credits: 60, subscription_credits: 0,
    });
    assert.equal((await db.query(
      "select count(*)::int as n from device_subscriptions where device_id = 'apple-wallet'",
    )).rows[0].n, 1);
    assert.equal((await merge('zero-sub-map')).rows[0].decision, 'already_merged');
    assert.equal((await db.query(
      "select count(*)::int as n from credit_transactions where device_id = 'apple-wallet' and transaction_type = 'legacy_wallet_merge'",
    )).rows[0].n, 1);
  } finally {
    await db.close();
  }
});

test('verified legacy subscription merge rejects missing or mismatched Apple evidence without mutation', async () => {
  const db = await database();
  try {
    await db.exec(`
      insert into device_credits
        (device_id, apple_user_id, subscription_credits)
      values ('apple-wallet', 'apple-sub', 100), ('legacy-device', null, 300);
      insert into credit_transactions
        (device_id, transaction_type, idempotency_key, metadata)
      values ('legacy-device', 'subscription_monthly_grant', 'legacy-grant',
        '{"originalTransactionId":"1234567890","productId":"com.kingboard.app.monthly_basic","subscription_credits":500}'::jsonb);
      insert into device_subscriptions (device_id, product_id, purchase_token)
      values ('legacy-device', 'com.kingboard.app.monthly_basic', '1234567890');
    `);
    const sessionHash = await appleSession(db, 'apple-sub');
    await db.query('select public.activate_apple_wallet_session($1)', [sessionHash]);
    const call = (token, product) => db.query(
      `select * from public.merge_verified_legacy_wallet_v2_once(
        'legacy-device', 'apple-sub', $1, 'legacy-subscription-merge', $2, $3
      )`, [sessionHash, token, product],
    );
    await assert.rejects(call(null, null));
    await assert.rejects(call('9999999999', 'com.kingboard.app.monthly_basic'));
    await assert.rejects(call('1234567890', 'com.kingboard.app.monthly_pro'));
    assert.deepEqual(await balance(db, 'legacy-device'), {
      free_credits: 0, paid_credits: 0, subscription_credits: 300,
    });
    assert.deepEqual(await balance(db, 'apple-wallet'), {
      free_credits: 0, paid_credits: 0, subscription_credits: 100,
    });
    assert.equal((await db.query('select count(*)::int as n from credit_wallet_aliases')).rows[0].n, 0);
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
    )).rows[0].activated, true);

    const link = (subject, key) => db.query(
      'select * from public.link_apple_wallet_v2($1, $2, $3, $4)',
      [id, proofHash, subject, key],
    );
    assert.deepEqual((await link('apple', 'attempt-1')).rows[0], {
      decision: 'linked', canonical_wallet_id: id,
    });
    assert.equal((await db.query(
      'select public.activate_guest_wallet_v2($1, $2) as activated', [id, proofHash],
    )).rows[0].activated, false);
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
