import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const functions = fileURLToPath(new URL('../functions/', import.meta.url));
const read = (p) => readFileSync(join(functions, p), 'utf8').replace(/\r\n/g, '\n');

function creditFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return creditFiles(path);
    return name === 'credits.ts' ? [path] : [];
  });
}

test('every copy of credits.ts grants 50,000 credits for the Max plan and keeps the others', () => {
  const files = creditFiles(functions);
  assert.ok(files.length >= 7);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    assert.match(text, /PLAN4_MONTHLY_CREDITS = 50000/, file);
    assert.match(text, /PLAN4_PRODUCT_ID = 'com\.kingboard\.app\.monthly_max'/, file);
    assert.match(text, /productId === PLAN4_PRODUCT_ID\) return PLAN4_MONTHLY_CREDITS/, file);
    assert.match(text, /PLAN3_MONTHLY_CREDITS = 30000/, file);
    assert.match(text, /PLAN2_MONTHLY_CREDITS = 9000/, file);
    assert.match(text, /PLAN1_MONTHLY_CREDITS = 4000/, file);
  }
});

test('the purchase, renewal and reporting paths all know the Max product', () => {
  assert.match(read('sync_subscription_ios/index.ts'), /'com\.kingboard\.app\.monthly_max',\n    \]\.includes\(productId\)/);
  assert.match(read('apple_notifications/index.ts'), /KNOWN_SUBSCRIPTION_PRODUCTS = new Set\(\[[^\]]*monthly_max/s);
  assert.match(read('apple_notifications/index.ts'), /monthly_max': '맥스'/);
  assert.match(read('_shared/subscription_reporting.ts'), /monthly_\(basic\|premium\|pro\|max\)/);
  assert.match(read('_shared/subscription_audit.ts'), /monthly_pro', 'com\.kingboard\.app\.monthly_max'/);
  assert.match(read('wallet_link_v2/index.ts'), /monthly_max'\)\) return 'max'/);
  assert.match(read('subscriber_status/index.ts'), /monthly_max: 9900/);
  assert.match(read('daily_digest/index.ts'), /\['monthly_max', 'monthly_pro'/);
});
