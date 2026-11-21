import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

// Each function bundles its own copy of the revenue helper; tests inline the canonical one.
const revenueSource = readFileSync(new URL('../functions/_shared/revenue.ts', import.meta.url), 'utf8');
const revenueModule = stripTypeScriptTypes(revenueSource).replace(/^export /gm, '');
const inlineRevenue = code => code.replace(/^import \{[^}]*\} from '\.\/_shared\/revenue\.ts'.*$/m, revenueModule);
const runnable = stripTypeScriptTypes(inlineRevenue(readFileSync(new URL('../functions/apple_notifications/index.ts', import.meta.url), 'utf8'))
  .replace(/^import \{ createClient \} from .*$/m, 'const createClient = globalThis.__notificationDb;')
  .replace(/^import \{ verifyAppleNotificationJws, verifyAppleRenewalInfoJws, verifyAppleTransactionJws \} from .*$/m,
    'const { verifyAppleNotificationJws, verifyAppleRenewalInfoJws, verifyAppleTransactionJws } = globalThis.__notificationVerification;')
  .replace(/^import \{ sendTelegram \} from .*$/m,
    'const sendTelegram = async (text, options) => { globalThis.__telegram.push({ text, options }); return true; };')
  .replace(/^import \{ subscriptionCreditsForProduct \} from .*$/m, 'const subscriptionCreditsForProduct = () => 4000;'));
const helpers = await import(`data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(revenueSource))}`);

const monthTotal = { data: [{ inserted: true, month_totals: { KRW: 1234000000 }, since: '2026-10-01T00:00:00Z' }], error: null };

async function run(type, tx, { environment = 'Production', revenue = monthTotal, subtype = '',
  rpcResult = { data: [{ result: 'recovered', recovered: 7000, shortfall: 0 }], error: null } } = {}) {
  const calls = { rpc: [], tables: [] };
  globalThis.__telegram = [];
  let handler;
  globalThis.Deno = { env: { get: (key) => ({ SUPABASE_URL: 'https://example.invalid', SUPABASE_SERVICE_ROLE_KEY: 'service' })[key] },
    serve: (fn) => { handler = fn; } };
  globalThis.__notificationDb = () => ({
    from: (table) => { calls.tables.push(table); return {
      select() { return this; }, eq() { return this; }, update() { return this; },
      async maybeSingle() { return { data: table === 'device_subscriptions' ? { device_id: 'wallet' } : null }; },
      then(resolve) { resolve({ error: null }); },
    }; },
    async rpc(name, args) {
      calls.rpc.push({ name, args });
      if (name === 'record_revenue_event') return typeof revenue === 'function' ? revenue(args) : revenue;
      return rpcResult;
    },
  });
  globalThis.__notificationVerification = {
    verifyAppleNotificationJws: async () => ({ verified: true, environment, notification: {
      notificationType: type, subtype, notificationUUID: 'n-1', signedDate: Date.parse('2026-11-21T03:00:00Z'),
      data: { bundleId: 'com.kingboard.app', signedTransactionInfo: 'fixture' },
    } }),
    verifyAppleTransactionJws: async () => tx,
    verifyAppleRenewalInfoJws: async () => ({}),
  };
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ active_subscribers_now: 10, auto_renew_on_now: 9, auto_renew_off_now: 1 });
  try {
    await import(`data:text/javascript,${encodeURIComponent(runnable)}#${crypto.randomUUID()}`);
    const response = await handler(new Request('https://example.invalid/apple_notifications', {
      method: 'POST', body: JSON.stringify({ signedPayload: 'fixture' }),
    }));
    return { status: response.status, calls, telegram: globalThis.__telegram,
      revenue: calls.rpc.filter((c) => c.name === 'record_revenue_event').map((c) => c.args) };
  } finally { globalThis.fetch = savedFetch; }
}

const purchaseDate = Date.parse('2026-11-21T02:59:00Z');
const renewal = { originalTransactionId: '500', transactionId: '501', productId: 'com.kingboard.app.monthly_basic',
  expiresDate: Date.now() + 30 * 86400_000, purchaseDate, price: 4900000, currency: 'KRW', inAppOwnershipType: 'PURCHASED' };
const lifetime = { originalTransactionId: '700', transactionId: '700', productId: 'com.kingboard.app.features_lifetime',
  purchaseDate, price: 11000000, currency: 'KRW', inAppOwnershipType: 'PURCHASED' };
const pack = { originalTransactionId: '900', transactionId: '900', productId: 'com.kingboard.app.credits_7000',
  purchaseDate, price: 7000000, currency: 'KRW', inAppOwnershipType: 'PURCHASED' };

test('a subscription renewal records Apple\'s price once and shows it with the month total', async () => {
  const r = await run('DID_RENEW', renewal);
  assert.equal(r.status, 200);
  assert.deepEqual(r.revenue, [{ p_store: 'app_store', p_environment: 'Production', p_category: 'subscription',
    p_kind: 'purchase', p_product_id: 'com.kingboard.app.monthly_basic', p_transaction_id: '501',
    p_amount_milli: 4900000, p_currency: 'KRW', p_occurred_at: new Date(purchaseDate).toISOString(),
    p_source: 'apple_notification' }]);
  assert.match(r.telegram[0].text, /^- 매출 ₩4,900 · 이번 달 총 매출 ₩1,234,000$/m);
  // Apple redelivers with the same notification ID, so Telegram sends it at most once.
  assert.equal(r.telegram[0].options.idempotencyKey, 'n-1');
});

test('an upgrade counts as a charge; a downgrade or plain plan change does not', async () => {
  assert.equal((await run('DID_CHANGE_RENEWAL_PREF', renewal, { subtype: 'UPGRADE' })).revenue[0].p_kind, 'purchase');
  assert.equal((await run('DID_CHANGE_RENEWAL_PREF', renewal, { subtype: 'DOWNGRADE' })).revenue.length, 0);
  assert.equal((await run('DID_CHANGE_RENEWAL_STATUS', renewal, { subtype: 'AUTO_RENEW_DISABLED' })).revenue.length, 0);
});

test('a subscription refund is recorded as a refund and shown as negative', async () => {
  const r = await run('REFUND', { ...renewal, revocationDate: Date.parse('2026-11-21T02:00:00Z') }, {
    revenue: { data: [{ inserted: true, month_totals: { KRW: 1229100000 }, since: '2026-10-01T00:00:00Z' }], error: null } });
  assert.equal(r.revenue[0].p_kind, 'refund');
  assert.equal(r.revenue[0].p_amount_milli, 4900000);
  assert.equal(r.revenue[0].p_occurred_at, '2026-11-21T02:00:00.000Z');
  assert.match(r.telegram[0].text, /^- 매출 -₩4,900 · 이번 달 총 매출 ₩1,229,100$/m);
});

test('sandbox charges are labelled and left out of the total', async () => {
  const r = await run('DID_RENEW', renewal, { environment: 'Sandbox' });
  assert.equal(r.revenue[0].p_environment, 'Sandbox');
  assert.match(r.telegram[0].text, /^- 매출 ₩4,900 \(시험 결제 · 합계 제외\)$/m);
});

test('a failed revenue record never fails the webhook and still shows the amount', async () => {
  const r = await run('DID_RENEW', renewal, { revenue: { data: null, error: { message: 'boom' } } });
  assert.equal(r.status, 200);
  assert.match(r.telegram[0].text, /^- 매출 ₩4,900$/m);
  assert.equal(r.calls.tables.includes('device_subscriptions'), true);
});

test('no price from Apple means no revenue line and no record', async () => {
  const { price, ...noPrice } = renewal;
  const r = await run('DID_RENEW', noPrice);
  assert.equal(r.revenue.length, 0);
  assert.doesNotMatch(r.telegram[0].text, /매출/);
});

test('a lifetime purchase is announced with its revenue and keyed by transaction', async () => {
  const r = await run('ONE_TIME_CHARGE', lifetime);
  assert.equal(r.status, 200);
  assert.equal(r.revenue[0].p_category, 'lifetime');
  assert.equal(r.telegram.length, 1);
  assert.match(r.telegram[0].text, /^💎 평생이용권 구매\n- \d+\/\d+ \d\d:\d\d\n- 매출 ₩11,000 · 이번 달 총 매출 ₩1,234,000$/);
  assert.equal(r.telegram[0].options.idempotencyKey, 'purchase:700');
});

test('a lifetime refund records a refund and never touches the subscription path', async () => {
  const r = await run('REFUND', lifetime);
  assert.equal(r.status, 200);
  assert.deepEqual(r.calls.rpc.map((c) => c.name), ['record_revenue_event']);
  assert.equal(r.calls.tables.includes('device_subscriptions'), false);
  assert.match(r.telegram[0].text, /^💸 평생이용권 환불\n/);
  assert.match(r.telegram[0].text, /- 매출 -₩11,000 · /);
});

test('lifetime access through Family Sharing is not revenue', async () => {
  const r = await run('ONE_TIME_CHARGE', { ...lifetime, inAppOwnershipType: 'FAMILY_SHARED' });
  assert.equal(r.revenue.length, 0);
  assert.equal(r.telegram.length, 0);
});

test('a pack charge notification only records revenue; the claim sends the purchase alert', async () => {
  const r = await run('ONE_TIME_CHARGE', pack);
  assert.equal(r.status, 200);
  assert.deepEqual(r.calls.rpc.map((c) => c.name), ['record_revenue_event']);
  assert.equal(r.revenue[0].p_category, 'credit_pack');
  assert.equal(r.telegram.length, 0);
});

test('a pack refund alert shows the revenue change and keeps the credit recovery first', async () => {
  const r = await run('REFUND', pack);
  assert.deepEqual(r.calls.rpc.map((c) => c.name), ['refund_credit_pack_once', 'record_revenue_event']);
  assert.match(r.telegram[0].text, /^💸 묶음 환불 · 7,000 크레딧 · 회수 7,000\n- 매출 -₩7,000 · 이번 달 총 매출 ₩1,234,000$/);
});

test('a failed pack refund still returns 500 for redelivery without recording revenue', async () => {
  const r = await run('REFUND', pack, { rpcResult: { data: null, error: { message: 'refund_not_found_retry' } } });
  assert.equal(r.status, 500);
  assert.equal(r.revenue.length, 0);
});

test('revenue lines: foreign currencies, a partial first month and refunds', () => {
  const now = Date.parse('2026-11-21T03:00:00Z');
  const result = { inserted: true, monthTotals: { USD: 9980, KRW: 7000000 }, since: '2026-11-21T02:00:00Z' };
  assert.equal(helpers.revenueLine('purchase', 4990, 'USD', 'Production', result, now),
    '- 매출 US$4.99 · 이번 달 총 매출 ₩7,000 + US$9.98 (11/21부터 집계)');
  assert.equal(helpers.revenueLine('refund', 7000000, 'KRW', 'Production', { ...result, monthTotals: {} }, now),
    '- 매출 -₩7,000 · 이번 달 총 매출 ₩0 (11/21부터 집계)');
  assert.equal(helpers.appleRevenueAmount({ price: 7000000, currency: 'KRW' }).amountMilli, 7000000);
  assert.equal(helpers.appleRevenueAmount({ price: 1.5, currency: 'KRW' }), null);
  assert.equal(helpers.appleRevenueAmount({ price: 7000000, currency: 'krw' }), null);
});
