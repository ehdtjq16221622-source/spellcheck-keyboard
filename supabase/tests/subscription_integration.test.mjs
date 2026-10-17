import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { test } from 'node:test';

const read = (file) => readFileSync(new URL(`../functions/${file}`, import.meta.url), 'utf8');
const runnable = (source) => stripTypeScriptTypes(source
  .replace(/^import[\s\S]*?from ['"][^'"]+['"];?\r?$/gm, '')
  .replace(/^export /gm, ''));
const product = 'com.kingboard.app.monthly_premium';

async function invoke({ verified = true, expired = false, rpcError = null, origin = 'purchase' } = {}) {
  let handler;
  const calls = { rpc: [], failures: [], audits: [], reports: 0 };
  const tasks = [];
  const context = {
    Error, Date, crypto, Response, Request, URL, TextEncoder,
    console: { log() {}, info() {}, warn() {}, error() {} },
    Deno: {
      env: { get: (key) => ({ SUPABASE_URL: 'https://fixture.invalid', SUPABASE_SERVICE_ROLE_KEY: 'fixture',
        IOS_SUBSCRIPTION_ATOMIC_CANARY_WALLETS: '', IOS_SUBSCRIPTION_ATOMIC_ALL_USERS_ENABLED: 'true',
        WALLET_SESSIONS_ENABLED: 'true' })[key] },
      serve: (value) => { handler = value; },
    },
    resolveCreditWallet: async () => ({ walletId: 'v2:fixture', authenticated: true }),
    WalletAccessError: class extends Error {},
    subscriptionCreditsForProduct: () => 9000,
    getCredits: async () => ({ freeCredits: 10, paidCredits: 9000, remaining: 9010 }),
    setMonthlySubscriptionCredits: async () => { throw new Error('Split grant is forbidden'); },
    verifyAppleSubscription: async () => { throw new Error('Unexpected receipt fallback'); },
    verifyAppleTransactionJws: async () => ({ bundleId: 'com.kingboard.app', productId: product,
      transactionId: '54321', originalTransactionId: '12345', environment: 'Sandbox',
      expiresDate: Date.now() + (expired ? -60000 : 60000) }),
    verifyAppleSubscriptionRecordWithReason: async () => ({ verified, reason: verified ? 'confirmed' : 'subscription_not_found' }),
    setTimeout: (callback) => { callback(); return 0; },
    deferDiagnostic: (task) => { tasks.push(Promise.resolve().then(task)); },
    reportFailure: async () => { calls.reports++; },
    createClient: () => ({
      rpc: async (name, args) => {
        calls.rpc.push({ name, args });
        return rpcError ? { data: null, error: rpcError } : { data: [{ applied: true,
          free_credits_remaining: 10, paid_credits_remaining: 9000, credits_remaining: 9010 }], error: null };
      },
      from: (table) => {
        const query = { select: () => query, eq: () => query,
          maybeSingle: async () => ({ data: table === 'device_subscriptions'
            ? { product_id: 'com.kingboard.app.monthly_basic', purchase_token: '12345' } : null, error: null }),
          insert: async (row) => { assert.equal(table, 'subscription_sync_failures'); calls.failures.push(row); return { error: null }; },
          upsert: async () => { throw new Error('Split subscription writes are forbidden'); },
        };
        return query;
      },
    }),
  };
  vm.createContext(context);
  vm.runInContext(runnable(read('_shared/subscription_audit.ts')), context);
  context.writeSubscriptionAudit = (level, auditId, event, fields) => calls.audits.push({ level, auditId, event, fields });
  // Only the pure summarizer is loaded; all network delivery is replaced above.
  const alerts = {};
  vm.runInNewContext(runnable(read('_shared/subscription_alerts.ts')), alerts);
  context.summarizeFailure = alerts.summarizeFailure;
  vm.runInContext(runnable(read('sync_subscription_ios/index.ts')), context);
  const response = await handler(new Request('https://fixture.invalid/sync_subscription_ios', {
    method: 'POST', body: JSON.stringify({ deviceId: 'v2:fixture', productId: product, jwsToken: 'fixture',
      syncOrigin: origin, clientDiag: JSON.stringify({ fixture: true }) }),
  }));
  await Promise.all(tasks);
  return { response, body: await response.json(), calls };
}

test('verified plan change uses one atomic grant and retains the verification diagnostic', async () => {
  const { response, calls } = await invoke();
  assert.equal(response.status, 200);
  assert.equal(calls.rpc.length, 1);
  assert.equal(calls.rpc[0].name, 'sync_ios_subscription_once');
  assert.equal(calls.rpc[0].args.p_metadata.apple_current_product_verified, true);
  assert.equal(calls.failures.length, 0);
  assert.equal(calls.audits.find((event) => event.event === 'plan_change_verification_completed').fields.origin, 'purchase');
});

test('unconfirmed plan preserves the app error code and full failure details without granting', async () => {
  const { response, body, calls } = await invoke({ verified: false });
  assert.equal(response.status, 409);
  assert.equal(body.error, 'subscription_plan_change_unverified');
  assert.equal(calls.rpc.length, 0);
  assert.equal(calls.failures.length, 1);
  const detail = calls.failures[0].detail;
  assert.equal(detail.transactionId, '54321');
  assert.equal(detail.client.fixture, true);
  assert.equal(detail.syncOrigin, 'purchase');
  assert.equal(calls.reports, 1);
});

test('expired plan keeps stale-transaction response and never grants', async () => {
  const { response, body, calls } = await invoke({ expired: true });
  assert.equal(response.status, 409);
  assert.equal(body.error, 'stale_subscription_transaction');
  assert.equal(calls.rpc.length, 0);
  assert.equal(calls.failures.length, 1);
});

test('atomic ownership conflict never falls back to split writes', async () => {
  const { response, body, calls } = await invoke({ rpcError: new Error('subscription owner transfer requires review') });
  assert.equal(response.status, 409);
  assert.equal(body.code, 'subscription_owner_transfer_requires_review');
  assert.equal(calls.rpc.length, 1);
  assert.equal(calls.failures.length, 1);
});

test('untrusted origin is not copied into public audit events', async () => {
  const { calls } = await invoke({ origin: 'untrusted-fixture-origin' });
  assert.equal(calls.audits.find((event) => event.event === 'request_accepted').fields.origin, 'unknown');
});
