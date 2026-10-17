import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = readFileSync(new URL('../functions/_shared/apple_receipt.ts', import.meta.url), 'utf8');
const { verifyAppleSubscription } = await import(
  `data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`
);
const product = 'com.kingboard.app.monthly_premium';

async function verify(receipt, strict = true) {
  const previousFetch = globalThis.fetch;
  const previousDeno = globalThis.Deno;
  globalThis.Deno = { env: { get: () => undefined } };
  globalThis.fetch = async () => Response.json(receipt);
  try {
    return await verifyAppleSubscription('receipt', product, 'com.kingboard.app', strict);
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.Deno = previousDeno;
  }
}

test('receipt cannot substitute another product for the requested subscription', async () => {
  const result = await verify({
    status: 0, receipt: { bundle_id: 'com.kingboard.app' },
    latest_receipt_info: [{ product_id: 'com.kingboard.app.monthly_basic',
      original_transaction_id: 'purchase-other', expires_date_ms: String(Date.now() + 60_000) }],
  });
  assert.equal(result.state, 'SUBSCRIPTION_STATE_NOT_FOUND');
  assert.equal(result.originalTransactionId, null);
});

test('receipt must include the expected bundle ID', async () => {
  await assert.rejects(verify({ status: 0, receipt: {}, latest_receipt_info: [] }),
    /different app bundle/);
});

test('canceled receipt cannot grant an active subscription', async () => {
  const result = await verify({
    status: 0, receipt: { bundle_id: 'com.kingboard.app' },
    latest_receipt_info: [{ product_id: product, original_transaction_id: 'purchase-1',
      transaction_id: 'order-1', expires_date_ms: String(Date.now() + 60_000),
      cancellation_date_ms: String(Date.now() - 1_000) }],
  });
  assert.equal(result.state, 'SUBSCRIPTION_STATE_CANCELED');
  assert.equal(result.active, false);
});

test('legacy verification retains its previous fallback behavior', async () => {
  const result = await verify({
    status: 0, receipt: {},
    latest_receipt_info: [{ product_id: 'com.kingboard.app.monthly_basic',
      original_transaction_id: 'legacy-purchase', expires_date_ms: String(Date.now() + 60_000),
      cancellation_date_ms: String(Date.now() - 1_000) }],
  }, false);
  assert.equal(result.originalTransactionId, 'legacy-purchase');
  assert.equal(result.active, true);
  assert.equal(result.state, 'SUBSCRIPTION_STATE_CANCELED');
});
