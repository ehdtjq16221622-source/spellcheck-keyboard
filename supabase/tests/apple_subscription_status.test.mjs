import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = readFileSync(new URL('../functions/_shared/apple_subscription_status.ts', import.meta.url), 'utf8');
const runnable = stripTypeScriptTypes(source
  .replace(/^import \{ Environment, SignedDataVerifier \} from .*$/m,
    'const { Environment, SignedDataVerifier } = globalThis.__appleServerLibrary;')
  .replace(/^import \{ Buffer \} from .*$/m,
    'const { Buffer } = globalThis.__nodeBuffer;')
  .replace(/^import \{ verifyAppleSignedTransactionPortable \} from .*$/m,
    'const { verifyAppleSignedTransactionPortable } = globalThis.__portableVerifier;')
  .replace(/^import \{ installX509ToStringCompatibility \} from .*$/m,
    'const { installX509ToStringCompatibility } = globalThis.__x509Compat;')
  .replace(/^import \{ importPKCS8, SignJWT \} from .*$/m,
    'const { importPKCS8, SignJWT } = globalThis.__jose;'));

async function check({ productionStatus = 200, productionErrorCode = 4040010,
  bundleId = 'com.kingboard.app',
  originalId = '12345', productId = 'monthly', status = 1,
  productionTransactionStatus = status, sandboxTransactionStatus = status,
  expiresDate = Date.now() + 60_000, revocationDate, signatureValid = true,
  transactionEnvironment = 'Sandbox', productionEmptyData = false,
  verificationStatus, strictVerificationFailureStatus, canaryHistorical = false } = {}) {
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
  globalThis.__portableVerifier = {
    verifyAppleSignedTransactionPortable: async (_jws, _bundle, environment) => {
      if (!signatureValid) throw new Error('invalid_jws_signature');
      if (_jws === 'storekit-jws' && environment !== transactionEnvironment) throw new Error('invalid_environment');
      return { bundleId, originalTransactionId: originalId,
        productId, expiresDate, environment,
        ...(revocationDate === undefined ? {} : { revocationDate }) };
    },
  };
  globalThis.__nodeBuffer = { Buffer };
  globalThis.__x509Compat = { installX509ToStringCompatibility: () => {} };
  globalThis.__appleServerLibrary = {
    Environment: { PRODUCTION: 'Production', SANDBOX: 'Sandbox' },
    SignedDataVerifier: class {
      constructor(roots, onlineChecks, environment, expectedBundle, appAppleId) {
        this.environment = environment;
        this.onlineChecks = onlineChecks;
        verifierOptions.push({ roots, onlineChecks, environment, expectedBundle, appAppleId });
      }
      async verifyAndDecodeTransaction(jws) {
        assert.ok(['apple-signed-jws', 'storekit-jws', 'notification-transaction'].includes(jws));
        if (this.onlineChecks && strictVerificationFailureStatus !== undefined) {
          throw Object.assign(new Error('Strict verification failed'), {
            status: strictVerificationFailureStatus,
          });
        }
        if (!signatureValid) {
          throw verificationStatus === undefined
            ? new Error('Invalid signed transaction')
            : Object.assign(new Error('Invalid signed transaction'), { status: verificationStatus });
        }
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
      data: productionEmptyData && url.startsWith('https://api.storekit.apple.com')
        ? []
        : [{ lastTransactions: [{ originalTransactionId: originalId,
          status: url.startsWith('https://api.storekit.apple.com')
            ? productionTransactionStatus : sandboxTransactionStatus,
          signedTransactionInfo: 'apple-signed-jws' }] }] }) };
  };
  const module = await import(`data:text/javascript,${encodeURIComponent(runnable)}#${crypto.randomUUID()}`);
  const accepted = await module.verifyActiveApplePurchase('12345', 'monthly', 'com.kingboard.app');
  const historicalAccepted = await module.verifyAppleSubscriptionRecord(
    '12345', 'monthly', 'com.kingboard.app',
  );
  const detailedWithFallback = await module.verifyAppleSubscriptionRecordDetailed(
    '12345', 'monthly', 'com.kingboard.app', false, true, canaryHistorical,
  );
  return { accepted, historicalAccepted, detailedWithFallback, endpoints, verifierOptions, module };
}

test('Apple subscription status accepts the exact live app purchase', async () => {
  const result = await check();
  assert.equal(result.accepted, true);
  assert.equal(result.endpoints.length, 3);
  assert.equal(result.verifierOptions.every((option) => option.onlineChecks), true);
  assert.equal(result.verifierOptions.every((option) => option.expectedBundle === 'com.kingboard.app'), true);
  assert.equal(result.verifierOptions.every((option) => option.appAppleId === 6762074672), true);
  assert.equal(result.verifierOptions.every((option) => option.roots.length === 2), true);
});

test('TestFlight subscription status falls back to Apple sandbox', async () => {
  const result = await check({ productionStatus: 404 });
  assert.equal(result.accepted, true);
  assert.equal(result.endpoints.length, 6);
  assert.match(result.endpoints[1], /storekit-sandbox\.apple\.com/);
  assert.deepEqual(result.verifierOptions.map((option) => option.environment),
    ['Sandbox', 'Sandbox', 'Sandbox']);
});

test('canary historical verification tries sandbox when production returns no matching transaction', async () => {
  const result = await check({ productionEmptyData: true });
  assert.equal(result.historicalAccepted, false, 'the default verifier keeps its existing single-environment behavior');
  assert.deepEqual(result.detailedWithFallback, { verified: true, environment: 'Sandbox' });
  assert.equal(result.endpoints.filter((url) => url.startsWith('https://api.storekit.apple.com')).length, 3);
  assert.equal(result.endpoints.filter((url) => url.startsWith('https://api.storekit-sandbox.apple.com')).length, 1);
});

test('canary verification does not use sandbox to override a matching revoked production transaction', async () => {
  const result = await check({ productionTransactionStatus: 5, sandboxTransactionStatus: 1 });
  assert.deepEqual(result.detailedWithFallback, {
    verified: false, reason: 'subscription_status_not_eligible', environment: 'Production',
  });
});

test('canary audit reason preserves Apple verification status without exposing transaction data', async () => {
  const result = await check({ productionEmptyData: true, signatureValid: false, verificationStatus: 4 });
  assert.deepEqual(result.detailedWithFallback, {
    verified: false, reason: 'signed_transaction_invalid_environment', environment: 'Sandbox',
  });
});

test('canary historical transfer verifies a signed transaction at its signed date when strict verification fails', async () => {
  const result = await check({ productionStatus: 404, strictVerificationFailureStatus: 1,
    canaryHistorical: true });
  assert.equal(result.accepted, false, 'active grants never use the historical fallback');
  assert.equal(result.historicalAccepted, false, 'the ordinary historical path remains strict');
  assert.deepEqual(result.detailedWithFallback, {
    verified: true, environment: 'Sandbox', verificationMode: 'portable_signed_date',
  });
  assert.equal(result.verifierOptions.at(-1).onlineChecks, true);
  assert.equal(result.verifierOptions.at(-1).environment, 'Sandbox');
});

test('invalid signatures and mismatched products stay blocked in the canary historical fallback', async () => {
  const invalid = await check({ productionStatus: 404, strictVerificationFailureStatus: 1,
    signatureValid: false, verificationStatus: 1, canaryHistorical: true });
  assert.deepEqual(invalid.detailedWithFallback, {
    verified: false, reason: 'portable_invalid_jws_signature',
    environment: 'Sandbox',
  });

  const wrongProduct = await check({ productionStatus: 404, strictVerificationFailureStatus: 1,
    productId: 'other-plan', canaryHistorical: true });
  assert.deepEqual(wrongProduct.detailedWithFallback, {
    verified: false, reason: 'signed_transaction_mismatch', environment: 'Sandbox',
  });
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

test('live plan verification uses portable signatures even when active and the Edge library fails', async () => {
  const result = await check({ productionStatus: 404, strictVerificationFailureStatus: 1 });
  const verified = await result.module.verifyAppleSubscriptionRecordWithReason('12345', 'monthly', 'com.kingboard.app', true);
  assert.deepEqual(verified, { verified: true, reason: 'confirmed' });
  const transaction = await result.module.verifyAppleTransactionJws('storekit-jws', 'com.kingboard.app', 'monthly');
  assert.equal(transaction.environment, 'Sandbox');
});

test('portable active plan verification keeps invalid, expired and revoked purchases blocked', async () => {
  for (const variant of [
    { signatureValid: false }, { productId: 'wrong' },
    { expiresDate: Date.now() - 1000 }, { revocationDate: Date.now() - 1000 },
  ]) {
    const result = await check({ productionStatus: 404, strictVerificationFailureStatus: 1, ...variant });
    const verified = await result.module.verifyAppleSubscriptionRecordWithReason('12345', 'monthly', 'com.kingboard.app', true);
    assert.equal(verified.verified, false);
  }
});
