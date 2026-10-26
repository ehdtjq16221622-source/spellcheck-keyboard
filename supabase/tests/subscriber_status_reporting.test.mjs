import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const helper = readFileSync(new URL('../functions/_shared/subscription_reporting.ts', import.meta.url), 'utf8');
const helperUrl = `data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(helper))}`;
const source = readFileSync(new URL('../functions/subscriber_status/index.ts', import.meta.url), 'utf8');
const runnable = stripTypeScriptTypes(source
  .replace(/^import \{ importPKCS8, SignJWT \} from .*$/m, 'const { importPKCS8, SignJWT } = globalThis.__reportJose;')
  .replace(/^import \{ createClient \} from .*$/m, 'const createClient = globalThis.__reportDb;')
  .replace("'../_shared/subscription_reporting.ts'", JSON.stringify(helperUrl)));
const now = Date.now(), day = 86400_000;
const product = name => `com.kingboard.app.monthly_${name}`;
const signed = value => `h.${Buffer.from(JSON.stringify(value)).toString('base64url')}.s`;
const tx = (id, chain, tier, start, end, more = {}) => ({ transactionId: id, originalTransactionId: chain,
  productId: product(tier), environment: 'Production', purchaseDate: now + start * day,
  expiresDate: now + end * day, transactionReason: 'PURCHASE', ...more });

async function run({ rows, histories, statuses, grants = [], accounts = [], historyError = false }) {
  let handler;
  const calls = [], reads = [];
  const savedFetch = globalThis.fetch;
  globalThis.Deno = { env: { get: key => ({ SUPABASE_SERVICE_ROLE_KEY: 'fixture-only-service',
    SUPABASE_URL: 'https://example.invalid', APPLE_IAP_KEY_B64: btoa('fixture-key') })[key] },
    serve: fn => { handler = fn; } };
  globalThis.__reportJose = { importPKCS8: async () => ({}), SignJWT: class {
    setProtectedHeader() { return this; } setIssuer() { return this; } setIssuedAt() { return this; }
    setExpirationTime() { return this; } setAudience() { return this; } async sign() { return 'fixture-only-jwt'; }
  } };
  globalThis.__reportDb = () => ({ from(table) {
    return { select() { return this; }, eq() { return this; }, order() { return this; },
      async range(a, b) {
        reads.push({ table, a, b });
        return { data: (table === 'device_subscriptions' ? rows : table === 'credit_transactions' ? grants : []).slice(a, b + 1) };
      },
      async in() { return { data: accounts }; },
    };
  } });
  globalThis.fetch = async input => {
    const url = new URL(input), chain = decodeURIComponent(url.pathname.split('/').at(-1));
    calls.push(url);
    if (url.pathname.includes('/subscriptions/')) {
      return Response.json({ environment: 'Production', data: [{ lastTransactions: statuses[chain] }] });
    }
    if (historyError) return Response.json({}, { status: 503 });
    const pages = histories[chain];
    const page = url.searchParams.has('revision') ? 1 : 0;
    return Response.json({ environment: 'Production', signedTransactions: pages[page].map(signed),
      hasMore: page < pages.length - 1, revision: 'fixture-next-page' });
  };
  try {
    await import(`data:text/javascript,${encodeURIComponent(runnable)}#${crypto.randomUUID()}`);
    const response = await handler(new Request('https://example.invalid/subscriber_status?include_history=1', {
      headers: { Authorization: 'Bearer fixture-only-service' },
    }));
    return { status: response.status, body: await response.json(), calls, reads };
  } finally { globalThis.fetch = savedFetch; }
}
const row = chain => ({ device_id: `wallet-${chain}`, purchase_token: chain, product_id: product('basic') });
const current = transaction => ({ status: 1, originalTransactionId: transaction.originalTransactionId,
  signedTransactionInfo: signed(transaction), signedRenewalInfo: signed({ autoRenewStatus: 1,
    autoRenewProductId: product('premium') }) });

test('Apple history pagination restores a different-plan resubscription and uses the next plan price', async () => {
  const old = tx('a', 'old', 'basic', -60, -30), next = tx('b', 'new', 'pro', -5, 25);
  const result = await run({ rows: [row('old')], statuses: { old: [current(next)] }, histories: { old: [[old], [next]] } });
  assert.equal(result.status, 200);
  assert.equal(result.body.renewal_outcomes.resubscribed_changed_plan, 1);
  assert.equal(result.body.auto_renew_off_now, 0);
  assert.equal(result.body.active_by_tier.monthly_pro, 1);
  assert.equal(result.body.renewing_by_tier.monthly_premium, 1);
  assert.equal(result.body.next_month_revenue_krw, 2200);
  const page2 = result.calls.find(url => url.searchParams.has('revision'));
  assert.equal(page2.searchParams.get('productType'), 'AUTO_RENEWABLE');
  assert.equal(page2.searchParams.get('sort'), 'ASCENDING');
  assert.doesNotMatch(JSON.stringify(result.body), /wallet-old|fixture-only|"originalTransactionId"/);
});

test('linked account with two original transaction IDs is counted once, sandbox grants are excluded', async () => {
  const a = tx('a', 'old', 'basic', -50, -20), b = tx('b', 'new', 'pro', -10, 20);
  const result = await run({ rows: [row('old'), row('new'), row('sandbox')],
    statuses: { old: [current(b)], new: [current(b)] },
    histories: { old: [[a, b]], new: [[a, b]] },
    accounts: [{ device_id: 'wallet-old', apple_user_id: 'private-apple-account' },
      { device_id: 'wallet-new', apple_user_id: 'private-apple-account' }],
    grants: [{ id: 'grant', metadata: { originalTransactionId: 'sandbox', environment: 'Sandbox' } }] });
  assert.equal(result.body.checked, 2);
  assert.equal(result.body.checked_people, 1);
  assert.equal(result.body.active_subscribers_now, 1);
  assert.equal(result.body.renewal_outcomes.denominator, 1);
  assert.equal(result.body.renewal_outcomes.resubscribed_changed_plan, 1);
  assert.doesNotMatch(JSON.stringify(result.body), /private-apple-account/);
});

test('failed history is unknown, not zero renewals or expiry, while current status remains available', async () => {
  const transaction = tx('a', 'one', 'basic', -10, 20);
  const result = await run({ rows: [row('one')], histories: {}, statuses: { one: [current(transaction)] }, historyError: true });
  assert.equal(result.body.active_subscribers_now, 1);
  assert.equal(result.body.renewal_outcomes.unknown, 1);
  assert.equal(result.body.renewal_outcomes.expired, 0);
  assert.equal(result.body.renewal_outcomes.renewal_rate, null);
});
