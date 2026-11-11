import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = readFileSync(new URL('../functions/apple_notifications/index.ts', import.meta.url), 'utf8');
const runnable = stripTypeScriptTypes(source
  .replace(/^import \{ createClient \} from .*$/m, 'const createClient = globalThis.__notificationDb;')
  .replace(/^import \{ verifyAppleNotificationJws, verifyAppleRenewalInfoJws, verifyAppleTransactionJws \} from .*$/m,
    'const { verifyAppleNotificationJws, verifyAppleRenewalInfoJws, verifyAppleTransactionJws } = globalThis.__notificationVerification;')
  .replace(/^import \{ sendTelegram \} from .*$/m, 'const sendTelegram = async (text) => { globalThis.__telegram.push(text); return true; };')
  .replace(/^import \{ subscriptionCreditsForProduct \} from .*$/m, 'const subscriptionCreditsForProduct = () => 4000;'));

async function run(type, tx, rpcResult = { data: [{ result: 'recovered', recovered: 7000, shortfall: 0 }], error: null },
  environment = 'Production') {
  const calls = { rpc: [], tables: [] };
  globalThis.__telegram = [];
  let handler;
  globalThis.Deno = { env: { get: (key) => ({ SUPABASE_URL: 'https://example.invalid', SUPABASE_SERVICE_ROLE_KEY: 'service' })[key] },
    serve: (fn) => { handler = fn; } };
  globalThis.__notificationDb = () => ({
    from: (table) => { calls.tables.push(table); return {
      select() { return this; }, eq() { return this; }, update() { return this; },
      async maybeSingle() { return { data: null }; }, then(resolve) { resolve({ error: null }); },
    }; },
    async rpc(name, args) { calls.rpc.push({ name, args }); return rpcResult; },
  });
  globalThis.__notificationVerification = {
    verifyAppleNotificationJws: async () => ({ verified: true, environment, notification: {
      notificationType: type, subtype: '', notificationUUID: 'n-1', signedDate: Date.now(),
      data: { bundleId: 'com.kingboard.app', signedTransactionInfo: 'fixture' },
    } }),
    verifyAppleTransactionJws: async () => tx,
    verifyAppleRenewalInfoJws: async () => ({}),
  };
  await import(`data:text/javascript,${encodeURIComponent(runnable)}#${crypto.randomUUID()}`);
  const response = await handler(new Request('https://example.invalid/apple_notifications', {
    method: 'POST', body: JSON.stringify({ signedPayload: 'fixture' }),
  }));
  return { status: response.status, body: await response.json(), calls, telegram: globalThis.__telegram };
}

const pack = { transactionId: '2000001', originalTransactionId: '2000001', productId: 'com.kingboard.app.credits_7000' };

test('a pack refund takes credits back through the pack function, never the subscription path', async () => {
  const r = await run('REFUND', pack);
  assert.equal(r.status, 200);
  assert.deepEqual(r.calls.rpc.map((c) => c.name), ['refund_credit_pack_once']);
  assert.deepEqual(r.calls.rpc[0].args, { p_transaction_id: '2000001', p_product_id: 'com.kingboard.app.credits_7000',
    p_environment: 'Production', p_notification_id: 'n-1' });
  assert.equal(r.calls.tables.includes('device_subscriptions'), false);
  assert.match(r.telegram[0], /묶음 환불 · 7,000 크레딧 · 회수 7,000/);
});

test('a pack refund reversal restores through the reversal function', async () => {
  const r = await run('REFUND_REVERSED', { ...pack, productId: 'com.kingboard.app.credits_18000' },
    { data: [{ result: 'restored', restored: 18000 }], error: null });
  assert.equal(r.status, 200);
  assert.equal(r.calls.rpc[0].name, 'reverse_credit_pack_refund_once');
  assert.match(r.telegram[0], /환불 취소 · 18,000 크레딧 · 복구 18,000/);
});

test('sandbox pack refunds are handled and labelled as tests', async () => {
  const r = await run('REFUND', pack, undefined, 'Sandbox');
  assert.equal(r.calls.rpc[0].args.p_environment, 'Sandbox');
  assert.match(r.telegram[0], /^🧪/);
});

test('a failed pack refund returns 500 so Apple redelivers', async () => {
  const r = await run('REFUND_REVERSED', pack, { data: null, error: { message: 'refund_not_found_retry' } });
  assert.equal(r.status, 500);
});

test('a refund after a reversal is acknowledged once and sent to a person', async () => {
  const r = await run('REFUND', pack, { data: null, error: { message: 'refund_after_reversal_requires_review' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.result, 'needs_review');
  assert.match(r.telegram[0], /재환불 확인 필요/);
});

test('other pack notifications change nothing', async () => {
  for (const type of ['CONSUMPTION_REQUEST', 'REFUND_DECLINED']) {
    const r = await run(type, pack);
    assert.equal(r.status, 200, type);
    assert.equal(r.calls.rpc.length, 0, type);
  }
});

test('subscription refunds still use the subscription path', async () => {
  const r = await run('REFUND', { transactionId: '9', originalTransactionId: '9', productId: 'com.kingboard.app.monthly_pro',
    expiresDate: Date.now() });
  assert.equal(r.calls.rpc.some((c) => c.name === 'refund_credit_pack_once'), false);
  assert.equal(r.calls.tables.includes('device_subscriptions'), true);
});
