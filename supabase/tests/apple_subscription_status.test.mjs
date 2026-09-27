import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = readFileSync(new URL('../functions/_shared/apple_subscription_status.ts', import.meta.url), 'utf8');
const runnable = stripTypeScriptTypes(source.replace(/^import \{ decodeJwt, importPKCS8, SignJWT \} from .*$/m,
  'const { decodeJwt, importPKCS8, SignJWT } = globalThis.__jose;'));

async function check({ productionStatus = 200, productionErrorCode = 4040010,
  bundleId = 'com.kingboard.app',
  originalId = '12345', productId = 'monthly', status = 1,
  expiresDate = Date.now() + 60_000 } = {}) {
  const endpoints = [];
  globalThis.Deno = { env: { get: (key) => ({
    APPLE_IAP_KEY_B64: btoa('private-key'), APPLE_IAP_KEY_ID: 'key-id',
    APPLE_IAP_ISSUER_ID: 'issuer-id',
  })[key] } };
  globalThis.__jose = {
    importPKCS8: async () => 'key',
    SignJWT: class {
      setProtectedHeader() { return this; }
      setIssuer() { return this; }
      setIssuedAt() { return this; }
      setExpirationTime() { return this; }
      setAudience() { return this; }
      async sign() { return 'apple-api-token'; }
    },
    decodeJwt: () => ({ bundleId, originalTransactionId: originalId,
      productId, expiresDate }),
  };
  globalThis.fetch = async (url, options) => {
    endpoints.push(url);
    assert.equal(options.headers.Authorization, 'Bearer apple-api-token');
    if (url.startsWith('https://api.storekit.apple.com') && productionStatus !== 200) {
      return { ok: false, status: productionStatus,
        json: async () => ({ errorCode: productionErrorCode }) };
    }
    return { ok: true, status: 200, json: async () => ({ bundleId,
      data: [{ lastTransactions: [{ originalTransactionId: originalId,
        status, signedTransactionInfo: 'apple-signed-jws' }] }] }) };
  };
  const module = await import(`data:text/javascript,${encodeURIComponent(runnable)}#${crypto.randomUUID()}`);
  const accepted = await module.verifyActiveApplePurchase('12345', 'monthly', 'com.kingboard.app');
  return { accepted, endpoints };
}

test('Apple subscription status accepts the exact live app purchase', async () => {
  const result = await check();
  assert.equal(result.accepted, true);
  assert.equal(result.endpoints.length, 1);
});

test('TestFlight subscription status falls back to Apple sandbox', async () => {
  const result = await check({ productionStatus: 404 });
  assert.equal(result.accepted, true);
  assert.equal(result.endpoints.length, 2);
  assert.match(result.endpoints[1], /storekit-sandbox\.apple\.com/);
});

test('Apple API outage or unrelated 404 never authorizes transfer', async () => {
  for (const options of [
    { productionStatus: 500 },
    { productionStatus: 404, productionErrorCode: 4040002 },
  ]) {
    await assert.rejects(() => check(options), /Apple subscription status request failed/);
  }
});

test('wrong app, purchase, product, expired, or inactive subscription cannot transfer', async () => {
  for (const variant of [
    { bundleId: 'another.app' }, { originalId: '99999' },
    { productId: 'other-plan' }, { expiresDate: Date.now() - 1000 },
    { status: 2 },
  ]) {
    assert.equal((await check(variant)).accepted, false);
  }
});
