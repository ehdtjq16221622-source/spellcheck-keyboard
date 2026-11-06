import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = readFileSync(new URL('../functions/apple_notifications/index.ts', import.meta.url), 'utf8');
const runnable = stripTypeScriptTypes(source
  .replace(/^import \{ createClient \} from .*$/m, 'const createClient = globalThis.__notificationDb;')
  .replace(/^import \{ verifyAppleNotificationJws, verifyAppleRenewalInfoJws, verifyAppleTransactionJws \} from .*$/m,
    'const { verifyAppleNotificationJws, verifyAppleRenewalInfoJws, verifyAppleTransactionJws } = globalThis.__notificationVerification;')
  .replace(/^import \{ sendTelegram \} from .*$/m, 'const sendTelegram = async () => true;')
  .replace(/^import \{ subscriptionCreditsForProduct \} from .*$/m, 'const subscriptionCreditsForProduct = () => 4000;'));

const expires = Date.now() + 30 * 86400_000;

// Runs the real handler with Apple verification and the database stubbed; returns the subscription row update.
async function run(type, tx) {
  const updates = [];
  let handler;
  const savedFetch = globalThis.fetch;
  globalThis.Deno = { env: { get: key => ({ SUPABASE_URL: 'https://example.invalid',
    SUPABASE_SERVICE_ROLE_KEY: 'service' })[key] }, serve: fn => { handler = fn; } };
  globalThis.__notificationDb = () => ({
    from: () => ({
      select() { return this; }, eq() { return this; },
      update(values) { updates.push(values); return this; },
      async maybeSingle() { return { data: { device_id: 'wallet' } }; },
      then(resolve) { resolve({ error: null }); },
    }),
    async rpc() { return { data: [{ result: 'granted' }], error: null }; },
  });
  globalThis.__notificationVerification = {
    verifyAppleNotificationJws: async () => ({ verified: true, environment: 'Production', notification: {
      notificationType: type, subtype: '', notificationUUID: 'delivery', signedDate: Date.now(),
      data: { bundleId: 'com.kingboard.app', signedTransactionInfo: 'fixture', signedRenewalInfo: 'fixture' },
    } }),
    verifyAppleTransactionJws: async () => tx,
    verifyAppleRenewalInfoJws: async () => ({ originalTransactionId: 'otx', autoRenewStatus: 1,
      autoRenewProductId: 'com.kingboard.app.monthly_premium' }),
  };
  globalThis.fetch = async () => Response.json({});
  try {
    await import(`data:text/javascript,${encodeURIComponent(runnable)}#${crypto.randomUUID()}`);
    const response = await handler(new Request('https://example.invalid/apple_notifications', {
      method: 'POST', body: JSON.stringify({ signedPayload: 'fixture' }),
    }));
    assert.equal(response.status, 200);
    assert.equal(updates.length, 1);
    return updates[0];
  } finally { globalThis.fetch = savedFetch; }
}

test('a renewal after a scheduled downgrade stores the plan Apple billed', async () => {
  const update = await run('DID_RENEW', { originalTransactionId: 'otx', transactionId: 'tx2',
    productId: 'com.kingboard.app.monthly_basic', expiresDate: expires });
  assert.equal(update.subscription_state, 'SUBSCRIPTION_STATE_ACTIVE');
  assert.equal(update.expiry_time_millis, expires);
  assert.equal(update.product_id, 'com.kingboard.app.monthly_basic');
  assert.equal(update.last_cycle_key, `otx:com.kingboard.app.monthly_basic:${expires}`);
  assert.equal(update.latest_order_id, 'tx2');
});

test('the plan is not taken from renewal preferences or unknown products', async () => {
  // No transaction product: the pending auto-renew product must not replace the current plan.
  const noProduct = await run('DID_RENEW', { originalTransactionId: 'otx', expiresDate: expires });
  assert.equal('product_id' in noProduct, false);
  const unknown = await run('DID_RENEW', { originalTransactionId: 'otx', productId: 'com.other.app',
    expiresDate: expires });
  assert.equal('product_id' in unknown, false);
});

test('non-renewal events keep updating only state and expiry', async () => {
  for (const type of ['SUBSCRIBED', 'EXPIRED', 'DID_FAIL_TO_RENEW']) {
    const update = await run(type, { originalTransactionId: 'otx', transactionId: 'tx2',
      productId: 'com.kingboard.app.monthly_basic', expiresDate: expires });
    assert.equal('product_id' in update, false, type);
    assert.equal('last_cycle_key' in update, false, type);
  }
});

async function rpcCalls(type, tx, env = {}) {
  const calls = [];
  let handler;
  const savedFetch = globalThis.fetch;
  globalThis.Deno = { env: { get: key => ({ SUPABASE_URL: 'https://example.invalid',
    SUPABASE_SERVICE_ROLE_KEY: 'service', ...env })[key] }, serve: fn => { handler = fn; } };
  globalThis.__notificationDb = () => ({
    from: () => ({
      select() { return this; }, eq() { return this; }, update() { return this; },
      async maybeSingle() { return { data: { device_id: 'wallet' } }; },
      then(resolve) { resolve({ error: null }); },
    }),
    async rpc(name, args) { calls.push({ name, args }); return { data: [{ result: 'cleared' }], error: null }; },
  });
  globalThis.__notificationVerification = {
    verifyAppleNotificationJws: async () => ({ verified: true, environment: 'Production', notification: {
      notificationType: type, subtype: '', notificationUUID: 'delivery', signedDate: Date.now(),
      data: { bundleId: 'com.kingboard.app', signedTransactionInfo: 'fixture', signedRenewalInfo: 'fixture' },
    } }),
    verifyAppleTransactionJws: async () => tx,
    verifyAppleRenewalInfoJws: async () => ({ originalTransactionId: 'otx', autoRenewStatus: 0,
      autoRenewProductId: 'com.kingboard.app.monthly_basic' }),
  };
  globalThis.fetch = async () => Response.json({});
  try {
    await import(`data:text/javascript,${encodeURIComponent(runnable)}#${crypto.randomUUID()}`);
    const response = await handler(new Request('https://example.invalid/apple_notifications', {
      method: 'POST', body: JSON.stringify({ signedPayload: 'fixture' }),
    }));
    assert.equal(response.status, 200);
    return calls;
  } finally { globalThis.fetch = savedFetch; }
}

const expiredTx = { originalTransactionId: 'otx', transactionId: 'tx2',
  productId: 'com.kingboard.app.monthly_basic', expiresDate: Date.now() - 1000 };

test('final expiry clears subscription credits for that cycle when enabled', async () => {
  for (const type of ['EXPIRED', 'GRACE_PERIOD_EXPIRED']) {
    const calls = await rpcCalls(type, expiredTx, { SUBSCRIPTION_EXPIRY_CLEAR_ENABLED: 'true' });
    assert.deepEqual(calls, [{ name: 'expire_subscription_credits',
      args: { p_original_txn: 'otx', p_expired_ms: expiredTx.expiresDate, p_notification_id: 'delivery' } }], type);
  }
});

test('expiry clearing stays off without the flag', async () => {
  assert.deepEqual(await rpcCalls('EXPIRED', expiredTx), []);
});

test('billing retry and auto-renew changes never clear credits', async () => {
  for (const type of ['DID_FAIL_TO_RENEW', 'DID_CHANGE_RENEWAL_STATUS']) {
    assert.deepEqual(await rpcCalls(type, expiredTx, { SUBSCRIPTION_EXPIRY_CLEAR_ENABLED: 'true' }), [], type);
  }
});
