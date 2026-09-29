import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = readFileSync(new URL('../functions/sync_subscription_ios/index.ts', import.meta.url), 'utf8');
const productId = 'com.kingboard.app.monthly_premium';
const runnable = stripTypeScriptTypes(source
  .replace(/^import \{ createClient \} from .*$/m, 'const createClient = globalThis.__createClient;')
  .replace(/^import \{[\s\S]*?\} from '\.\.\/_shared\/credits\.ts'$/m,
    'const { getCredits, setMonthlySubscriptionCredits, subscriptionCreditsForProduct } = globalThis.__credits;')
  .replace(/^import \{ verifyAppleSubscription \} from .*$/m,
    'const verifyAppleSubscription = globalThis.__verifyAppleSubscription;')
  .replace(/^import \{ verifyAppleJWS \} from .*$/m,
    'const verifyAppleJWS = globalThis.__verifyAppleJWS;')
  .replace(/^import \{ verifyActiveApplePurchase \} from .*$/m,
    'const verifyActiveApplePurchase = globalThis.__verifyActiveApplePurchase;')
  .replace(/^import \{ resolveCreditWallet, WalletAccessError \} from .*$/m,
    'const { resolveCreditWallet, WalletAccessError } = globalThis.__walletAuth;'));

async function run({ allowlist = '', rpcError = null, requestedProduct = productId,
  requestedDeviceId = 'v2:guest', authError = null,
  verifiedPurchase = 'purchase-1', receiptData = 'apple-receipt',
  existingProduct = null, appleCurrentProduct = true } = {}) {
  let handler;
  const calls = [];
  globalThis.Deno = {
    env: { get: (key) => ({
      SUPABASE_URL: 'https://example.invalid',
      SUPABASE_SERVICE_ROLE_KEY: 'test',
      IOS_SUBSCRIPTION_ATOMIC_CANARY_WALLETS: allowlist,
    })[key] },
    serve: (value) => { handler = value; },
  };
  globalThis.__credits = {
    subscriptionCreditsForProduct: () => 9000,
    getCredits: async () => ({ freeCredits: 5, paidCredits: 10, remaining: 15 }),
    setMonthlySubscriptionCredits: async () => ({ applied: true }),
  };
  globalThis.__verifyAppleSubscription = async (_receipt, _product, _bundle, strict) => {
    calls.push({ verification: 'receipt', strict });
    return { active: true, state: 'SUBSCRIPTION_STATE_ACTIVE',
      expiryTimeMillis: Date.now() + 60_000, cycleKey: 'cycle-1', orderId: 'order-1',
      originalTransactionId: verifiedPurchase, environment: 'Sandbox' };
  };
  globalThis.__verifyAppleJWS = async () => {
    calls.push({ verification: 'jws' });
    return ({
    bundleId: 'com.kingboard.app', productId,
    expiresDate: Date.now() + 60_000,
    transactionId: 'order-1', originalTransactionId: verifiedPurchase,
    });
  };
  globalThis.__verifyActiveApplePurchase = async (...args) => {
    calls.push({ verification: 'apple_current_product', args });
    return appleCurrentProduct;
  };
  globalThis.__walletAuth = {
    resolveCreditWallet: async (_req, _supabase, _walletId, forceWalletAuth) => {
      calls.push({ authorization: 'wallet', forceWalletAuth });
      if (authError) throw authError;
      return { walletId: requestedDeviceId };
    },
    WalletAccessError: class WalletAccessError extends Error {},
  };
  globalThis.__createClient = () => ({
    rpc: async (name, args) => {
      calls.push({ name, args });
      return rpcError
        ? { data: null, error: rpcError }
        : { data: [{ applied: true, free_credits_remaining: 5,
          paid_credits_remaining: 9010, credits_remaining: 9015 }], error: null };
    },
    from: (table) => {
      calls.push({ table });
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({
          data: table === 'device_subscriptions' && existingProduct
            ? { product_id: existingProduct } : null,
          error: null,
        }) }) }),
        upsert: async () => ({ error: null }),
      };
    },
  });
  await import(`data:text/javascript,${encodeURIComponent(runnable)}#${crypto.randomUUID()}`);
  const response = await handler(new Request('https://example.invalid/sync_subscription_ios', {
    method: 'POST', body: JSON.stringify({ deviceId: requestedDeviceId, productId: requestedProduct,
      jwsToken: 'untrusted-jws', receiptData }),
  }));
  return { response, calls, body: await response.json() };
}

test('allowlisted wallet uses only the atomic RPC and returns its balance', async () => {
  const { response, calls, body } = await run({ allowlist: 'other, v2:guest' });
  assert.equal(response.status, 200);
  assert.deepEqual(calls.filter((call) => call.verification).map((call) => call.verification), ['receipt']);
  assert.deepEqual(calls.filter((call) => call.name).map((call) => call.name), ['sync_ios_subscription_once']);
  const args = calls.find((call) => call.name === 'sync_ios_subscription_once').args;
  assert.equal(args.p_device_id, 'v2:guest');
  assert.deepEqual(calls.filter((call) => call.authorization).map((call) => call.forceWalletAuth), [true]);
  assert.equal(args.p_cycle_key, `purchase-1:${productId}:` + args.p_metadata.cycleKey);
  assert.equal(body.credits_remaining, 9015);
});

test('plan upgrade requires Apple current status before the atomic grant', async () => {
  const { response, calls } = await run({
    allowlist: 'v2:guest', existingProduct: 'com.kingboard.app.monthly_basic',
  });
  assert.equal(response.status, 200);
  assert.equal(calls.some((call) => call.verification === 'apple_current_product'), true);
  const grant = calls.find((call) => call.name === 'sync_ios_subscription_once');
  assert.equal(grant.args.p_metadata.apple_current_product_verified, true);
});

test('unconfirmed plan upgrade never calls the grant RPC', async () => {
  const { response, calls } = await run({
    allowlist: 'v2:guest', existingProduct: 'com.kingboard.app.monthly_basic',
    appleCurrentProduct: false,
  });
  assert.equal(response.status, 409);
  assert.equal(calls.some((call) => call.name === 'sync_ios_subscription_once'), false);
});

test('restore of the already linked plan does not repeat Apple plan verification', async () => {
  const { response, calls } = await run({
    allowlist: 'v2:guest', existingProduct: productId,
  });
  assert.equal(response.status, 200);
  assert.equal(calls.some((call) => call.verification === 'apple_current_product'), false);
  const grant = calls.find((call) => call.name === 'sync_ios_subscription_once');
  assert.equal(grant.args.p_metadata.apple_current_product_verified, false);
});

test('atomic RPC failure does not fall back to the split grant', async () => {
  const { response, calls } = await run({ allowlist: 'v2:guest', rpcError: new Error('injected failure') });
  assert.equal(response.status, 500);
  assert.deepEqual(calls.filter((call) => call.name).map((call) => call.name), ['sync_ios_subscription_once']);
});

test('other wallets remain on the legacy path', async () => {
  const { response, calls } = await run({ allowlist: 'other-wallet', requestedDeviceId: 'old-device' });
  assert.equal(response.status, 200);
  assert.equal(calls.some((call) => call.name === 'sync_ios_subscription_once'), false);
  assert.equal(calls.some((call) => call.table === 'device_subscriptions'), true);
  assert.deepEqual(calls.filter((call) => call.verification).map((call) => call.verification), ['jws']);
  assert.equal(calls.some((call) => call.authorization), false);
});

test('canary rejects a missing Apple receipt without writing subscription state', async () => {
  const { response, calls } = await run({ allowlist: 'v2:guest', receiptData: null });
  assert.equal(response.status, 400);
  assert.equal(calls.some((call) => call.name || call.table === 'device_subscriptions'), false);
});

test('unknown subscription product is rejected before a wallet write', async () => {
  const { response, calls } = await run({ allowlist: 'v2:guest', requestedProduct: 'com.example.fake' });
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});

test('missing original purchase ID cannot create a fallback subscription row', async () => {
  const { response, calls } = await run({ allowlist: 'v2:guest', verifiedPurchase: null });
  assert.equal(response.status, 400);
  assert.equal(calls.filter((call) => call.table === 'device_subscriptions').length, 0);
  assert.equal(calls.filter((call) => call.name === 'sync_ios_subscription_once').length, 0);
});

test('canary rejects an unproven wallet before Apple verification or any write', async () => {
  const { response, calls } = await run({ allowlist: 'v2:guest', authError: new Error('no wallet proof') });
  assert.equal(response.status, 500);
  assert.equal(calls.some((call) => call.verification || call.name || call.table), false);
});
