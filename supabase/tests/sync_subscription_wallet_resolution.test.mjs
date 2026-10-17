import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = readFileSync(new URL('../functions/sync_subscription/index.ts', import.meta.url), 'utf8');
const runnable = stripTypeScriptTypes(source
  .replace(/^import \{ createClient \} from .*$/m,
    'const createClient = globalThis.__createClient;')
  .replace(/^import \{[\s\S]*?\} from '\.\.?\/\_shared\/credits\.ts'$/m,
    'const { getCredits, googleSubscriptionCreditsForProduct, setMonthlySubscriptionCredits } = globalThis.__credits;')
  .replace(/^import \{ verifySubscription \} from .*$/m,
    'const verifySubscription = globalThis.__verifySubscription;')
  .replace(/^import \{ resolveCreditWallet, WalletAccessError \} from .*$/m,
    'const { resolveCreditWallet, WalletAccessError } = globalThis.__walletAuth;')
  .replace(/^import \{[\s\S]*?\} from '\.\.?\/_shared\/subscription_audit\.ts'$/m,
    'const { logSubscriptionAudit, safeSubscriptionFailureCode, subscriptionFailureHttpStatus, subscriptionTransactionFingerprint, subscriptionWalletFingerprint } = globalThis.__subscriptionAudit;'));

async function run({
  deviceId = 'legacy-device',
  resolvedWalletId = deviceId,
  authError = null,
  verifiedAccountId = deviceId,
  productId = 'premium.monthly',
  atomicCanaryWallets = '',
  atomicRpcError = null,
  existing = null,
  upsertFailures = 0,
  retryAfterFailure = false,
} = {}) {
  let handler;
  const calls = [];
  const appliedGrantKeys = new Set();
  let savedSubscription = existing;
  globalThis.Deno = {
    env: { get: (key) => ({
      SUPABASE_URL: 'https://example.invalid',
      SUPABASE_SERVICE_ROLE_KEY: 'test',
      GOOGLE_PLAY_PACKAGE_NAME: 'com.example.app',
      GOOGLE_SUBSCRIPTION_ATOMIC_CANARY_WALLETS: atomicCanaryWallets,
    })[key] },
    serve: (callback) => { handler = callback; },
  };
  globalThis.__walletAuth = {
    WalletAccessError: class WalletAccessError extends Error {
      constructor(message, status) { super(message); this.status = status; }
    },
    resolveCreditWallet: async (_req, _client, requestedId) => {
      calls.push({ type: 'resolve', requestedId });
      if (authError) {
        throw new globalThis.__walletAuth.WalletAccessError(authError.message, authError.status);
      }
      return { walletId: resolvedWalletId, authenticated: resolvedWalletId !== requestedId };
    },
  };
  globalThis.__verifySubscription = async (...args) => {
    calls.push({ type: 'verify', args });
    return {
      active: true,
      state: 'SUBSCRIPTION_STATE_ACTIVE',
      expiryTimeMillis: 1_900_000_000_000,
      cycleKey: 'cycle-1',
      orderId: 'order-1',
      obfuscatedAccountId: verifiedAccountId,
    };
  };
  globalThis.__credits = {
    googleSubscriptionCreditsForProduct: (productId) =>
      productId === 'kingboard_monthly_1000' ? 9000 : 4000,
    getCredits: async (_client, walletId) => {
      calls.push({ type: 'balance', walletId });
      return { freeCredits: 500, paidCredits: 4000, remaining: 4500 };
    },
    setMonthlySubscriptionCredits: async (_client, walletId, amount, key) => {
      const applied = !appliedGrantKeys.has(key);
      appliedGrantKeys.add(key);
      calls.push({ type: 'grant', walletId, amount, key, applied });
      return { applied };
    },
  };
  globalThis.__subscriptionAudit = {
    logSubscriptionAudit: (level, auditId, event, fields = {}) =>
      calls.push({ type: 'audit', level, auditId, event, fields }),
    safeSubscriptionFailureCode: (stage, error) =>
      error?.message.includes('Google subscription owner transfer requires review')
        ? 'google_subscription_owner_transfer_requires_review'
        : `stage_${stage}`,
    subscriptionFailureHttpStatus: (error) =>
      error?.message.includes('Google subscription owner transfer requires review') ? 409 : null,
    subscriptionWalletFingerprint: async (walletId) => `wallet:${walletId}`,
    subscriptionTransactionFingerprint: async (value) => `transaction:${value}`,
  };
  globalThis.__createClient = () => ({
    rpc: async (name, args) => {
      calls.push({ type: 'rpc', name, args });
      if (atomicRpcError) return { data: null, error: atomicRpcError };
      return { data: [{
        applied: true,
        free_credits_remaining: 500,
        paid_credits_remaining: 4000,
        credits_remaining: 4500,
      }], error: null };
    },
    from: (table) => ({
      select: () => ({
        eq: (_column, walletId) => ({
          maybeSingle: async () => {
            calls.push({ type: 'read_subscription', walletId });
            return { data: table === 'device_subscriptions' ? savedSubscription : null, error: null };
          },
        }),
      }),
      upsert: async (row) => {
        calls.push({ type: 'write_subscription', row });
        if (upsertFailures > 0) {
          upsertFailures -= 1;
          return { error: new Error('simulated subscription row write failure') };
        }
        savedSubscription = row;
        return { error: null };
      },
    }),
  });

  await import(`data:text/javascript,${encodeURIComponent(runnable)}#${crypto.randomUUID()}`);
  const invoke = () => handler(new Request('https://example.invalid/sync_subscription', {
    method: 'POST',
    body: JSON.stringify({ deviceId, productId, purchaseToken: 'purchase-token' }),
  }));
  const firstResponse = await invoke();
  const firstBody = await firstResponse.json();
  if (retryAfterFailure && firstResponse.status >= 500) {
    const response = await invoke();
    return { response, body: await response.json(), firstResponse, firstBody, calls, appliedGrantCount: appliedGrantKeys.size };
  }
  return { response: firstResponse, body: firstBody, calls, appliedGrantCount: appliedGrantKeys.size };
}

test('linked Apple session resolves Google subscription grant, row, and response to the canonical wallet', async () => {
  const result = await run({ resolvedWalletId: 'apple-wallet' });
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.calls.find((call) => call.type === 'resolve'), {
    type: 'resolve', requestedId: 'legacy-device',
  });
  assert.equal(result.calls.find((call) => call.type === 'read_subscription').walletId, 'apple-wallet');
  assert.equal(result.calls.find((call) => call.type === 'grant').walletId, 'apple-wallet');
  assert.equal(result.calls.find((call) => call.type === 'write_subscription').row.device_id, 'apple-wallet');
  assert.equal(result.calls.find((call) => call.type === 'balance').walletId, 'apple-wallet');
});

test('wallet ownership rejection is returned as its intended status without subscription writes or grants', async () => {
  const accessError = new Error('앱을 최신 버전으로 업데이트해 주세요.');
  accessError.status = 409;
  const result = await run({ authError: accessError });
  assert.equal(result.response.status, 409);
  assert.equal(result.calls.some((call) => call.type === 'grant' || call.type === 'write_subscription'), false);
});

test('Google account-bound ID mismatch is rejected before wallet resolution or credit writes', async () => {
  const result = await run({ verifiedAccountId: 'somebody-else' });
  assert.equal(result.response.status, 403);
  assert.equal(result.calls.some((call) => call.type === 'resolve' || call.type === 'grant' || call.type === 'write_subscription'), false);
});

test('legacy unlinked wallet continues through the compatibility resolver result', async () => {
  const result = await run();
  assert.equal(result.response.status, 200);
  assert.equal(result.calls.find((call) => call.type === 'grant').walletId, 'legacy-device');
  assert.equal(result.calls.find((call) => call.type === 'balance').walletId, 'legacy-device');
});

test('retry after the subscription row write fails reuses the grant key and saves the row without a duplicate credit grant', async () => {
  const result = await run({ upsertFailures: 1, retryAfterFailure: true });
  assert.equal(result.firstResponse.status, 500);
  assert.equal(result.response.status, 200);
  assert.equal(result.calls.filter((call) => call.type === 'grant' && call.applied).length, 1);
  assert.equal(result.calls.filter((call) => call.type === 'grant').length, 2);
  assert.equal(result.calls.filter((call) => call.type === 'write_subscription').length, 2);
  const grantCalls = result.calls.filter((call) => call.type === 'grant');
  assert.equal(grantCalls[0].key, grantCalls[1].key);
});

test('allowlisted Google subscription uses atomic RPC and returns its audit ID without split writes', async () => {
  const result = await run({
    deviceId: 'wallet-canary',
    productId: 'kingboard_monthly_1000',
    atomicCanaryWallets: 'wallet-canary',
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.audit_id.length > 0, true);
  const rpc = result.calls.find((call) => call.type === 'rpc');
  assert.equal(rpc.name, 'sync_google_subscription_once');
  assert.equal(rpc.args.p_device_id, 'wallet-canary');
  assert.equal(rpc.args.p_amount, 9000);
  assert.equal(rpc.args.p_cycle_key, 'purchase-token:kingboard_monthly_1000:cycle-1');
  assert.equal(rpc.args.p_metadata.google_purchase_verified, true);
  assert.equal(result.calls.some((call) => call.type === 'grant' || call.type === 'write_subscription'), false);
});

test('Google basic and premium products map to their configured monthly credit amounts', async () => {
  const basic = await run({
    deviceId: 'wallet-canary-basic',
    productId: 'kingboard_monthly_500',
    atomicCanaryWallets: 'wallet-canary-basic',
  });
  const premium = await run({
    deviceId: 'wallet-canary-premium',
    productId: 'kingboard_monthly_1000',
    atomicCanaryWallets: 'wallet-canary-premium',
  });

  assert.equal(basic.response.status, 200);
  assert.equal(basic.calls.find((call) => call.type === 'rpc').args.p_amount, 4000);
  assert.equal(premium.response.status, 200);
  assert.equal(premium.calls.find((call) => call.type === 'rpc').args.p_amount, 9000);
});

test('non-canary Google premium product also grants its configured amount', async () => {
  const result = await run({ productId: 'kingboard_monthly_1000' });
  assert.equal(result.response.status, 200);
  assert.equal(result.calls.find((call) => call.type === 'grant').amount, 9000);
});

test('atomic Google subscription failure does not fall back to split writes', async () => {
  const result = await run({
    deviceId: 'wallet-canary',
    productId: 'kingboard_monthly_500',
    atomicCanaryWallets: 'wallet-canary',
    atomicRpcError: new Error('simulated atomic sync failure'),
  });
  assert.equal(result.response.status, 500);
  assert.equal(result.body.error, 'Subscription sync failed.');
  assert.equal(result.body.error.includes('simulated atomic sync failure'), false);
  assert.equal(result.body.audit_id.length > 0, true);
  assert.equal(result.calls.some((call) => call.type === 'grant' || call.type === 'write_subscription'), false);
  assert.equal(result.calls.some((call) => call.type === 'audit' && call.event === 'sync_failed'), true);
});

test('verified Google purchase bound to another wallet returns review conflict without moving credits', async () => {
  const result = await run({
    deviceId: 'wallet-canary',
    productId: 'kingboard_monthly_500',
    atomicCanaryWallets: 'wallet-canary',
    atomicRpcError: new Error('Google subscription owner transfer requires review'),
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.body.code, 'google_subscription_owner_transfer_requires_review');
  assert.equal(result.calls.some((call) => call.type === 'grant' || call.type === 'write_subscription'), false);
});
