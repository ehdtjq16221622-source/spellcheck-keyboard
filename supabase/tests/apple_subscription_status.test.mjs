import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = readFileSync(new URL('../functions/_shared/apple_subscription_status.ts', import.meta.url), 'utf8');
const runnable = stripTypeScriptTypes(source
  .replace(/^import \{ Environment, SignedDataVerifier \} from .*$/m,
    'const { Environment, SignedDataVerifier } = globalThis.__appleServerLibrary;')
  .replace(/^import \{ importPKCS8, SignJWT \} from .*$/m,
    'const { importPKCS8, SignJWT } = globalThis.__jose;'));

async function check({ productionStatus = 200, productionErrorCode = 4040010,
  bundleId = 'com.kingboard.app',
  originalId = '12345', productId = 'monthly', status = 1,
  expiresDate = Date.now() + 60_000, revocationDate, signatureValid = true,
  transactionEnvironment = 'Sandbox' } = {}) {
  const endpoints = [];
  const verifierOptions = [];
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
  };
  globalThis.__appleServerLibrary = {
    Environment: { PRODUCTION: 'Production', SANDBOX: 'Sandbox' },
    SignedDataVerifier: class {
      constructor(roots, onlineChecks, environment, expectedBundle, appAppleId) {
        this.environment = environment;
        verifierOptions.push({ roots, onlineChecks, environment, expectedBundle, appAppleId });
      }
      async verifyAndDecodeTransaction(jws) {
        assert.ok(['apple-signed-jws', 'storekit-jws', 'notification-transaction'].includes(jws));
        if (!signatureValid) throw new Error('Invalid signed transaction');
        if (jws === 'storekit-jws' && transactionEnvironment !== this.environment) {
          throw new Error('Wrong environment');
        }
        return { bundleId, originalTransactionId: originalId,
          transactionId: '54321', productId, expiresDate,
          environment: jws === 'apple-signed-jws' || jws === 'notification-transaction'
            ? this.environment : transactionEnvironment,
          ...(revocationDate === undefined ? {} : { revocationDate }) };
      }
      async verifyAndDecodeNotification(jws) {
        assert.equal(jws, 'notification-jws');
        if (!signatureValid || transactionEnvironment !== this.environment) {
          throw new Error('Notification signature or environment invalid');
        }
        return { data: { bundleId, environment: this.environment } };
      }
      async verifyAndDecodeRenewalInfo(jws) {
        assert.equal(jws, 'renewal-jws');
        if (!signatureValid || transactionEnvironment !== this.environment) {
          throw new Error('Renewal signature or environment invalid');
        }
        return { originalTransactionId: originalId, environment: this.environment };
      }
    },
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
  const historicalAccepted = await module.verifyAppleSubscriptionRecord(
    '12345', 'monthly', 'com.kingboard.app',
  );
  return { accepted, historicalAccepted, endpoints, verifierOptions, module };
}

test('Apple subscription status accepts the exact live app purchase', async () => {
  const result = await check();
  assert.equal(result.accepted, true);
  assert.equal(result.endpoints.length, 2);
  assert.equal(result.verifierOptions.every((option) => option.onlineChecks), true);
  assert.equal(result.verifierOptions.every((option) => option.expectedBundle === 'com.kingboard.app'), true);
  assert.equal(result.verifierOptions.every((option) => option.appAppleId === 6762074672), true);
  assert.equal(result.verifierOptions.every((option) => option.roots.length === 2), true);
});

test('TestFlight subscription status falls back to Apple sandbox', async () => {
  const result = await check({ productionStatus: 404 });
  assert.equal(result.accepted, true);
  assert.equal(result.endpoints.length, 4);
  assert.match(result.endpoints[1], /storekit-sandbox\.apple\.com/);
  assert.deepEqual(result.verifierOptions.map((option) => option.environment),
    ['Sandbox', 'Sandbox']);
});

test('Apple API outage or unrelated 404 never authorizes transfer', async () => {
  for (const options of [
    { productionStatus: 500 },
    { productionStatus: 404, productionErrorCode: 4040002 },
  ]) {
    await assert.rejects(() => check(options), /Apple subscription status request failed/);
  }
});

test('an invalid Apple transaction signature never authorizes transfer', async () => {
  const result = await check({ signatureValid: false });
  assert.equal(result.accepted, false);
  assert.equal(result.historicalAccepted, false);
});

test('StoreKit transaction JWS uses Apple chain verification and selects its signed environment', async () => {
  const sandbox = await check({ transactionEnvironment: 'Sandbox' });
  const transaction = await sandbox.module.verifyAppleTransactionJws(
    'storekit-jws', 'com.kingboard.app', 'monthly',
  );
  assert.equal(transaction.environment, 'Sandbox');
  assert.deepEqual(sandbox.verifierOptions.slice(-2).map((option) => option.environment),
    ['Production', 'Sandbox']);
  assert.ok(sandbox.verifierOptions.slice(-2).every((option) => option.onlineChecks));

  const production = await check({ transactionEnvironment: 'Production' });
  const productionTransaction = await production.module.verifyAppleTransactionJws(
    'storekit-jws', 'com.kingboard.app', 'monthly',
  );
  assert.equal(productionTransaction.environment, 'Production');
  assert.equal(production.verifierOptions.at(-1).appAppleId, 6762074672);
});

test('StoreKit transaction JWS rejects identifier mismatch and invalid signatures', async () => {
  const wrongProduct = await check({ productId: 'other-plan' });
  await assert.rejects(() => wrongProduct.module.verifyAppleTransactionJws(
    'storekit-jws', 'com.kingboard.app', 'monthly',
  ));

  const invalid = await check({ signatureValid: false });
  await assert.rejects(() => invalid.module.verifyAppleTransactionJws(
    'storekit-jws', 'com.kingboard.app', 'monthly',
  ));
});

test('Apple notifications and renewal JWS use the same verified app and environment', async () => {
  const sandbox = await check({ transactionEnvironment: 'Sandbox' });
  const verified = await sandbox.module.verifyAppleNotificationJws(
    'notification-jws', 'com.kingboard.app',
  );
  assert.equal(verified.environment, 'Sandbox');
  assert.equal(verified.notification.data.bundleId, 'com.kingboard.app');
  const renewal = await sandbox.module.verifyAppleRenewalInfoJws(
    'renewal-jws', 'Sandbox', 'com.kingboard.app',
  );
  assert.equal(renewal.originalTransactionId, '12345');

  const wrongApp = await check({ bundleId: 'another.app' });
  await assert.rejects(() => wrongApp.module.verifyAppleNotificationJws(
    'notification-jws', 'com.kingboard.app',
  ));
  const invalidSignature = await check({ signatureValid: false });
  await assert.rejects(() => invalidSignature.module.verifyAppleNotificationJws(
    'notification-jws', 'com.kingboard.app',
  ));
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

test('historical Apple verification permits expired, non-revoked subscriptions only', async () => {
  const expired = await check({ status: 2, expiresDate: Date.now() - 1000 });
  assert.equal(expired.accepted, false, 'active verification must continue rejecting expired subscriptions');
  assert.equal(expired.historicalAccepted, true);

  for (const variant of [
    { status: 5, expiresDate: Date.now() - 1000 },
    { status: 2, expiresDate: Date.now() - 1000, revocationDate: Date.now() - 2000 },
    { status: 2, expiresDate: 0 },
    { status: 2, expiresDate: Date.now() - 1000, productId: 'other-plan' },
    { status: 2, expiresDate: Date.now() - 1000, bundleId: 'other.app' },
  ]) {
    assert.equal((await check(variant)).historicalAccepted, false);
  }
});
