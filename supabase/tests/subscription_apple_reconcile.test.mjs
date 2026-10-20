import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = readFileSync(new URL('../functions/subscription_apple_reconcile/index.ts', import.meta.url), 'utf8');
const runnable = stripTypeScriptTypes(source
  .replace(/^import \{ createClient \} from .*$/m, 'const createClient = globalThis.__reconcileClient;')
  .replace(/^import \{ importPKCS8, SignJWT \} from .*$/m, 'const { importPKCS8, SignJWT } = globalThis.__reconcileJose;')
  .replace(/^import \{ fingerprint, sendIncident \} from .*$/m, 'const { fingerprint, sendIncident } = globalThis.__reconcileAlerts;'));

const product = 'com.kingboard.app.monthly_basic';
const now = Date.parse('2026-10-19T03:00:00Z');
const expiry = now + 86400_000;
const row = (i = 1, extra = {}) => ({ device_id: `fixture-${String(i).padStart(8, '0')}`,
  product_id: product, purchase_token: String(i), expiry_time_millis: expiry, ...extra });
const tx = (id = '1', extra = {}) => ({ bundleId: 'com.kingboard.app', originalTransactionId: id,
  environment: 'Production', productId: product, expiresDate: expiry, signedDate: now, ...extra });
const item = (payload, status = 1) => ({ originalTransactionId: payload.originalTransactionId, status,
  signedTransactionInfo: `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature` });
const appleResponse = items => Response.json({ bundleId: 'com.kingboard.app', data: [{ lastTransactions: items }] });

async function run({ rows = [row()], headers = { 'x-admin-token': 'fixture-admin' }, method = 'POST', body = {},
  env = {}, queryError = false, fetcher, afterQuery, delivered = true } = {}) {
  const calls = { queries: [], lookups: [], sends: [] };
  let handler;
  const previousFetch = globalThis.fetch;
  const previousNow = Date.now;
  let clock = now;
  Date.now = () => clock;
  globalThis.Deno = {
    env: { get: key => ({ SUPABASE_SERVICE_ROLE_KEY: 'fixture-service', SUPABASE_URL: 'https://example.invalid',
      ADMIN_API_TOKEN: 'fixture-admin', SUBSCRIPTION_RECONCILE_SECRET: 'fixture-monitor', APPLE_IAP_KEY_B64: btoa('fixture-key'),
      APPLE_IAP_KEY_ID: 'fixture-kid', APPLE_IAP_ISSUER_ID: 'fixture-issuer', ...env })[key] },
    serve: value => { handler = value; },
  };
  globalThis.__reconcileJose = { importPKCS8: async () => 'key', SignJWT: class {
    setProtectedHeader() { return this; } setIssuer() { return this; } setIssuedAt() { return this; }
    setExpirationTime() { return this; } setAudience() { return this; } async sign() { return 'fixture-apple-jwt'; }
  } };
  globalThis.__reconcileAlerts = { fingerprint: async value => value,
    sendIncident: async (...args) => { calls.sends.push(args); return delivered; } };
  globalThis.__reconcileClient = () => ({ from(table) {
    assert.equal(table, 'device_subscriptions', 'monitor may only read subscription records');
    const call = { table, cursor: null };
    calls.queries.push(call);
    return {
      select(columns, options) { call.columns = columns; assert.equal(options.count, 'exact'); return this; },
      eq(column, value) { assert.equal(column, 'subscription_state'); assert.equal(value, 'SUBSCRIPTION_STATE_ACTIVE'); return this; },
      like(column, value) { assert.equal(column, 'product_id'); assert.equal(value, 'com.kingboard.app.monthly\\_%'); return this; },
      order(column) { assert.equal(column, 'device_id'); return this; },
      limit(value) { call.limit = value; return this; },
      gt(column, value) { assert.equal(column, 'device_id', 'must not exclude expired active rows'); call.cursor = value; return this; },
      abortSignal() { return this; },
      then(resolve, reject) {
        const remaining = rows.filter(r => !call.cursor || r.device_id > call.cursor);
        afterQuery?.({ advance: ms => { clock += ms; } });
        return Promise.resolve(queryError ? { error: { message: 'private transaction or token' } }
          : { data: remaining.slice(0, call.limit), count: remaining.length, error: null }).then(resolve, reject);
      },
    };
  } });
  globalThis.fetch = async (url, options) => {
    assert.match(url, /^https:\/\/api\.storekit(-sandbox)?\.apple\.com\/inApps\/v1\/subscriptions\/[0-9]+$/);
    assert.equal(options.headers.Authorization, 'Bearer fixture-apple-jwt');
    calls.lookups.push(url);
    const id = url.split('/').at(-1);
    return fetcher ? fetcher(url, id) : appleResponse([item(tx(id))]);
  };
  try {
    await import(`data:text/javascript,${encodeURIComponent(runnable)}#${crypto.randomUUID()}`);
    const response = await handler(new Request('https://example.invalid/reconcile', {
      method, headers, ...(method === 'GET' ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    }));
    const raw = await response.text();
    return { status: response.status, body: raw.startsWith('{') ? JSON.parse(raw) : raw, calls };
  } finally { globalThis.fetch = previousFetch; Date.now = previousNow; }
}

test('monitor admin auth fails closed and rejects public keys and invalid methods', async () => {
  for (const headers of [{}, { 'x-admin-token': 'wrong' }, { Authorization: 'Bearer undefined' }]) {
    const result = await run({ headers });
    assert.equal(result.status, 401);
    assert.equal(result.calls.queries.length, 0);
  }
  assert.equal((await run({ method: 'GET' })).status, 405);
  assert.equal((await run({ headers: { 'x-monitor-secret': 'fixture-monitor' } })).status, 200);
  assert.equal((await run({ headers: { Authorization: 'Bearer fixture-service' } })).status, 200);
  assert.equal((await run({ env: { ADMIN_API_TOKEN: undefined, SUBSCRIPTION_RECONCILE_SECRET: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined } })).status, 401);
});

test('monitor rejects malformed bodies and removes the self-test send endpoint', async () => {
  for (const body of ['{', [], null, { self_test: true }, { summary_only: 'true' }]) {
    const result = await run({ body });
    assert.equal(result.status, 400);
    assert.equal(result.calls.sends.length, 0);
  }
});

test('all 5001 active Apple records are paged; stale local expiry does not hide them', async () => {
  const rows = Array.from({ length: 5001 }, (_, i) => row(i + 1, { expiry_time_millis: i % 2 ? null : now - 1 }));
  const result = await run({ rows });
  assert.equal(result.status, 200);
  assert.equal(result.body.active, 5001);
  assert.equal(result.body.checked, 5001);
  assert.equal(result.body.notChecked, 0);
  assert.equal(result.body.expiryMismatch, 5001);
  assert.equal(result.calls.queries.length, 6);
  assert.equal(result.calls.sends.length, 0, 'no messages before approval, even when problems exist');
});

test('latest Apple transaction wins and independent mismatch checks are not else-if hidden', async () => {
  const result = await run({ fetcher: async () => appleResponse([
    item(tx('1', { signedDate: now - 1000 })),
    item(tx('1', { productId: 'com.kingboard.app.monthly_pro', expiresDate: expiry + 1 })),
  ]) });
  assert.equal(result.body.planMismatch, 1);
  assert.equal(result.body.expiryMismatch, 1);
  assert.equal(result.body.refundedButActive, 0);
  assert.equal(JSON.stringify(result.body).includes('fixture-'), false);
});

test('revoked, expired, retry, and grace statuses are not all called refunds', async () => {
  for (const [status, refunded, inactive, grace] of [[5, 1, 0, 0], [2, 0, 1, 0], [3, 0, 1, 0], [4, 0, 0, 1]]) {
    const result = await run({ fetcher: async () => appleResponse([item(tx(), status)]) });
    assert.equal(result.body.refundedButActive, refunded);
    assert.equal(result.body.inactiveButActive, inactive);
    assert.equal(result.body.gracePeriod, grace);
  }
  assert.equal((await run({ fetcher: async () => appleResponse([item(tx('1', { revocationDate: now }))]) })).body.refundedButActive, 1);
});

test('only Apple not-found error 4040010 falls back to Sandbox and excludes tests', async () => {
  const result = await run({ fetcher: async url => url.includes('sandbox')
    ? appleResponse([item(tx('1', { environment: 'Sandbox', productId: 'com.kingboard.app.monthly_pro' }))])
    : Response.json({ errorCode: 4040010 }, { status: 404 }) });
  assert.equal(result.body.sandbox, 1);
  assert.equal(result.body.planMismatch, 0);
  assert.equal(result.calls.lookups.length, 2);
  const wrong404 = await run({ fetcher: async () => Response.json({ errorCode: 4040000 }, { status: 404 }) });
  assert.equal(wrong404.body.lookupFailures, 1);
  assert.equal(wrong404.calls.lookups.length, 1);
});

test('one failed lookup among 100 is visible, incomplete, and never silently healthy', async () => {
  const result = await run({ rows: Array.from({ length: 100 }, (_, i) => row(i + 1)),
    fetcher: async (_url, id) => id === '100' ? new Response('', { status: 500 }) : appleResponse([item(tx(id))]) });
  assert.equal(result.status, 503);
  assert.equal(result.body.lookupFailures, 1);
  assert.equal(result.body.checked, 100);
  assert.equal(result.body.complete, false);
  assert.equal(result.body.needsAlert, true);
  assert.deepEqual(result.body.failureReasons, { http_500: 1 });
});

test('invalid bundle, environment, ID, status, payload, and ambiguous answers count as lookup failures', async () => {
  for (const payload of [tx('2'), tx('1', { bundleId: 'other' }), tx('1', { environment: 'Sandbox' }),
    tx('1', { expiresDate: null }), tx('1', { signedDate: undefined })]) {
    assert.equal((await run({ fetcher: async () => appleResponse([item(payload)]) })).body.lookupFailures, 1);
  }
  assert.equal((await run({ fetcher: async () => appleResponse([item(tx(), 99)]) })).body.lookupFailures, 1);
  assert.equal((await run({ fetcher: async () => appleResponse([item(tx()), item(tx('1', { productId: 'different' }))]) })).body.lookupFailures, 1);
  assert.equal((await run({ rows: [row(1, { purchase_token: 'invalid' })] })).body.lookupFailures, 1);
});

test('time budget exhaustion exposes unchecked count and returns incomplete', async () => {
  const result = await run({ rows: [row(1), row(2)], afterQuery: ({ advance }) => advance(111_000) });
  assert.equal(result.status, 503);
  assert.equal(result.body.notChecked, 2);
  assert.equal(result.body.complete, false);
});

test('summary-only success and errors never send, even when alert env is enabled', async () => {
  for (const queryError of [false, true]) {
    const result = await run({ queryError, body: { summary_only: true }, env: { SUBSCRIPTION_RECONCILE_ALERTS_ENABLED: 'true' },
      fetcher: async () => { throw new Error('private failure'); } });
    assert.equal(result.calls.sends.length, 0);
    assert.equal(JSON.stringify(result.body).includes('private'), false);
  }
});

test('query errors return structured unknown counts, with alerts disabled by default', async () => {
  const result = await run({ queryError: true });
  assert.equal(result.status, 503);
  assert.deepEqual(result.body.error, { code: 'reconciliation_failed', stage: 'subscription_query' });
  assert.equal(result.body.counts, null);
  assert.equal(result.calls.sends.length, 0);
});

test('empty active population does not need Apple credentials', async () => {
  const result = await run({ rows: [], env: { APPLE_IAP_KEY_B64: undefined } });
  assert.equal(result.status, 200);
  assert.equal(result.body.checked, 0);
});

test('post-approval delivery state reflects the actual sender result without a real send', async () => {
  const result = await run({ env: { SUBSCRIPTION_RECONCILE_ALERTS_ENABLED: 'true' }, delivered: false,
    fetcher: async () => appleResponse([item(tx('1', { productId: 'different' }))]) });
  assert.equal(result.body.needsAlert, true);
  assert.equal(result.body.delivered, false);
  assert.equal(result.calls.sends.length, 1);
});
