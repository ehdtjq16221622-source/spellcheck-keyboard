import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = readFileSync(new URL('../functions/subscriber_status/index.ts', import.meta.url), 'utf8');
const reporting = readFileSync(new URL('../functions/_shared/subscription_reporting.ts', import.meta.url), 'utf8');
const reportingUrl = `data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(reporting))}`;
const runnable = stripTypeScriptTypes(source
  .replace(/^import \{ importPKCS8, SignJWT \} from .*$/m,
    'const { importPKCS8, SignJWT } = globalThis.__jose;')
  .replace(/^import \{ createClient \} from .*$/m,
    'const createClient = globalThis.__createClient;')
  .replace("'../_shared/subscription_reporting.ts'", JSON.stringify(reportingUrl)));
let loadCount = 0;

function setup() {
  let handler;
  let dbCalls = 0;
  let appleCalls = 0;
  globalThis.Deno = {
    env: { get: (key) => ({
      SUPABASE_SERVICE_ROLE_KEY: 'server-only-secret',
      SUBSCRIBER_STATUS_ADMIN_TOKEN: 'admin-only-secret',
      SUPABASE_URL: 'https://example.invalid',
      APPLE_IAP_KEY_B64: btoa('test-key'),
      APPLE_IAP_KEY_ID: 'key',
      APPLE_IAP_ISSUER_ID: 'issuer',
    })[key] },
    serve: (fn) => { handler = fn; },
  };
  globalThis.__jose = {
    importPKCS8: async () => ({}),
    SignJWT: class {
      setProtectedHeader() { return this; }
      setIssuer() { return this; }
      setIssuedAt() { return this; }
      setExpirationTime() { return this; }
      setAudience() { return this; }
      async sign() { return 'signed-test-jwt'; }
    },
  };
  globalThis.__createClient = () => ({
    from: table => ({ select() { return this; }, eq() { return this; }, order() { return this; },
      async range() {
        dbCalls++;
        return { data: table === 'credit_transactions' ? [] : [{ device_id: 'private-wallet-id', purchase_token: 'purchase-1',
          product_id: 'com.kingboard.app.monthly_basic' }], error: null };
      } }),
  });
  globalThis.fetch = async () => {
    appleCalls++;
    const transaction = { transactionId: 'purchase-1', originalTransactionId: 'purchase-1',
      productId: 'com.kingboard.app.monthly_basic', environment: 'Production',
      purchaseDate: Date.now() - 86400_000, expiresDate: Date.now() + 29 * 86400_000 };
    const signed = `h.${Buffer.from(JSON.stringify(transaction)).toString('base64url')}.s`;
    return Response.json({ data: [{ lastTransactions: [{ status: 1, signedTransactionInfo: signed }] }] });
  };
  return import(`data:text/javascript,${encodeURIComponent(runnable)}#${++loadCount}`).then(() => ({
    handler: (request) => handler(request),
    calls: () => ({ dbCalls, appleCalls }),
  }));
}

test('public subscriber status request is rejected before database and Apple calls', async () => {
  const { handler, calls } = await setup();
  const response = await handler(new Request('https://example.invalid/subscriber_status'));
  assert.equal(response.status, 401);
  assert.deepEqual(calls(), { dbCalls: 0, appleCalls: 0 });
});

test('internal subscriber status returns counts without wallet identifiers', async () => {
  const { handler, calls } = await setup();
  const response = await handler(new Request('https://example.invalid/subscriber_status', {
    headers: { Authorization: 'Bearer server-only-secret' },
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.checked, 1);
  assert.equal(body.active_subscribers_now, 1);
  assert.equal('detail' in body, false);
  assert.equal(JSON.stringify(body).includes('private-wallet-id'), false);
  assert.equal(body.auto_renew_off_now, 0);
  assert.equal(body.auto_renew_unknown_now, 1);
  assert.deepEqual(calls(), { dbCalls: 2, appleCalls: 1 });
});

test('dedicated admin token is accepted without exposing subscriber data publicly', async () => {
  const { handler, calls } = await setup();
  const response = await handler(new Request('https://example.invalid/subscriber_status', {
    headers: { Authorization: 'Bearer admin-only-secret' },
  }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).active_subscribers_now, 1);
  assert.deepEqual(calls(), { dbCalls: 2, appleCalls: 1 });
});
