import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const baseline = JSON.parse(readFileSync(path.join(root, 'source-baselines/20261018-live-recovery.json'), 'utf8'));
const normalize = (text) => text.replace(/\r\n/g, '\n');

for (const [slug, entry] of Object.entries(baseline.functions)) {
  test(`${slug}: recorded live code and relative dependencies are preserved`, () => {
    for (const file of entry.files) {
      const snapshot = normalize(readFileSync(path.join(root, 'live-functions', file.snapshot), 'utf8'));
      assert.equal(createHash('sha256').update(snapshot).digest('hex'), file.sha256);
      const actualPath = path.join(root, 'functions', file.source);
      const actual = normalize(readFileSync(actualPath, 'utf8'));
      const expected = file.source === `${slug}/index.ts`
        ? snapshot.replace(/(['"])\.\.\/_shared\//g, '$1./_shared/') : snapshot;
      assert.equal(actual, expected, file.source);
      for (const match of actual.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]|import\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
        assert.ok(existsSync(path.resolve(path.dirname(actualPath), match[1] ?? match[2])), file.source);
      }
    }
  });
}

for (const slug of ['correct', 'translate']) {
  test(`${slug}: working entrypoint rejects missing request ID before wallet, debit and AI`, async () => {
    const calls = { wallet: 0, debit: 0, ai: 0 };
    let handler;
    const context = {
      Deno: { env: { get: () => 'fixture' }, serve: (value) => { handler = value; } },
      Response, Request, URL, TextEncoder, crypto,
      console: { log() {}, info() {}, warn() {}, error() {} },
      createClient() { throw new Error('DB access before rejection'); },
      resolveCreditWallet() { calls.wallet++; throw new Error('Unexpected wallet lookup'); },
      consumeAIUsage() { calls.debit++; throw new Error('Unexpected debit'); },
      refundAIUsage() { throw new Error('Unexpected refund'); },
      fetch() { calls.ai++; throw new Error('Unexpected network request'); },
      WalletAccessError: class extends Error {},
    };
    const source = readFileSync(path.join(root, 'functions', slug, 'index.ts'), 'utf8');
    vm.runInNewContext(stripTypeScriptTypes(source.replace(/^import .*$/gm, '')), context);
    const response = await handler(new Request(`https://fixture.invalid/${slug}`, {
      method: 'POST', body: JSON.stringify({ deviceId: 'legacy-fixture', text: 'fixture', targetLang: 'en' }),
    }));
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'APP_UPDATE_REQUIRED');
    assert.deepEqual(calls, { wallet: 0, debit: 0, ai: 0 });
  });
}
