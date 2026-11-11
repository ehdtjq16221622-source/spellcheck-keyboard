import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = readFileSync(new URL('../functions/credit_pack_purchase/_shared/credit_pack_validation.ts', import.meta.url), 'utf8');
const { validateCreditPackClaim } = await import(`data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`);

const TOKEN = '6f1c2a5e-8d3b-4c7a-9e21-0b4d5f6a7c8e';
const base = {
  bundleId: 'com.kingboard.app', environment: 'Production', transactionId: '3000001', originalTransactionId: '3000001',
  productId: 'com.kingboard.app.credits_18000', appAccountToken: TOKEN, quantity: 1, inAppOwnershipType: 'PURCHASED',
};
const check = (submitted = {}, current = {}) => validateCreditPackClaim({
  submitted: { ...base, ...submitted }, current: { ...base, ...current }, expectedBundleId: 'com.kingboard.app',
  expectedAccountToken: TOKEN,
});
const rejects = (code, submitted, current) => assert.throws(() => check(submitted, current), (e) => e.code === code, code);

test('a matching, unrevoked pack purchase yields its credits', () => {
  assert.deepEqual(check(), { transactionId: '3000001', originalTransactionId: '3000001',
    productId: 'com.kingboard.app.credits_18000', environment: 'Production', credits: 18000 });
  assert.equal(check({ environment: 'Sandbox' }, { environment: 'Sandbox' }).environment, 'Sandbox');
});

test('purchases that are not ours, not packs or not this wallet are rejected', () => {
  rejects('transaction_context_mismatch', { bundleId: 'com.other.app' });
  rejects('transaction_context_mismatch', {}, { environment: 'Sandbox' });
  rejects('invalid_environment', { environment: 'Xcode' }, { environment: 'Xcode' });
  rejects('unknown_product', { productId: 'com.kingboard.app.monthly_pro' }, { productId: 'com.kingboard.app.monthly_pro' });
  rejects('unknown_product', { productId: 'com.kingboard.app.features_lifetime' }, { productId: 'com.kingboard.app.features_lifetime' });
  rejects('account_binding_mismatch', { appAccountToken: undefined });
  rejects('account_binding_mismatch', { appAccountToken: '00000000-0000-4000-8000-000000000000' });
  rejects('unsupported_purchase', { quantity: 2 });
  rejects('unsupported_purchase', {}, { inAppOwnershipType: 'FAMILY_SHARED' });
  rejects('invalid_transaction_id', { transactionId: '12a' });
});

test('the app copy must match Apple\'s current record, and refunds stop the claim', () => {
  rejects('transaction_mismatch', { transactionId: '3000002' });
  rejects('transaction_mismatch', { productId: 'com.kingboard.app.credits_7000' });
  rejects('transaction_revoked', {}, { revocationDate: Date.now() });
  rejects('transaction_revoked', {}, { revocationReason: 0 });
});

test('a missing expected token is a server error, not a pass', () => {
  assert.throws(() => validateCreditPackClaim({ submitted: base, current: base, expectedBundleId: 'com.kingboard.app',
    expectedAccountToken: '' }), (e) => e.code === 'missing_account_binding');
});
