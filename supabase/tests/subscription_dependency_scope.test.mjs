import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const rows = JSON.parse(readFileSync(path.join(root, 'source-baselines/subscription-integration-dependencies.json'), 'utf8'));
const changedShared = new Set([
  '_shared/apple_receipt.ts', '_shared/apple_subscription_status.ts', '_shared/wallet_auth.ts',
  '_shared/subscription_audit.ts', '_shared/subscription_alerts.ts',
]);

test('subscription shared changes reach only the documented subscription entrypoint', () => {
  const affected = [];
  for (const row of rows) {
    const seen = new Set();
    const visit = (file) => {
      if (seen.has(file)) return;
      const full = path.join(root, 'functions', file);
      if (!existsSync(full)) return;
      seen.add(file);
      const source = readFileSync(full, 'utf8');
      for (const match of source.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]|import\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
        visit(path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1] ?? match[2])));
      }
    };
    visit(`${row.slug}/index.ts`);
    if ([...seen].some((file) => changedShared.has(file))) affected.push(row.slug);
  }
  assert.equal(rows.length, 36);
  for (const row of rows) assert.equal(row.sourceExists, existsSync(path.join(root, 'functions', row.slug, 'index.ts')), row.slug);
  assert.deepEqual(affected.sort(), ['sync_subscription_ios']);
});
