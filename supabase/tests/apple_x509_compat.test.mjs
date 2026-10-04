import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = readFileSync(new URL('../functions/_shared/apple_x509_compat.ts', import.meta.url), 'utf8');
const runnable = stripTypeScriptTypes(source
  .replace(/^import \{ Buffer \} from .*$/m, 'const { Buffer } = globalThis.__buffer;')
  .replace(/^import \{ X509Certificate \} from .*$/m, 'const { X509Certificate } = globalThis.__crypto;'));

function loadWithUnsupportedToString() {
  globalThis.__buffer = { Buffer };
  globalThis.__crypto = {
    X509Certificate: class {
      raw;
      constructor(raw) { this.raw = Uint8Array.from(raw); }
      toString() { throw new Error('Not implemented: crypto.X509Certificate.prototype.toString'); }
    },
  };
  return import(`data:text/javascript,${encodeURIComponent(runnable)}#${crypto.randomUUID()}`);
}

test('fills the Deno X509 toString gap with standard PEM while leaving verification to Apple library', async () => {
  const { installX509ToStringCompatibility } = await loadWithUnsupportedToString();
  installX509ToStringCompatibility(Uint8Array.from([1, 2, 3]));
  const certificate = new globalThis.__crypto.X509Certificate(Uint8Array.from([1, 2, 3]));
  assert.equal(certificate.toString(), [
    '-----BEGIN CERTIFICATE-----', 'AQID', '-----END CERTIFICATE-----', '',
  ].join('\n'));
});

test('does not replace a working X509 toString implementation', async () => {
  globalThis.__buffer = { Buffer };
  class WorkingX509Certificate {
    raw;
    constructor(raw) { this.raw = Uint8Array.from(raw); }
    toString() { return 'native-pem'; }
  }
  globalThis.__crypto = { X509Certificate: WorkingX509Certificate };
  const { installX509ToStringCompatibility } = await import(
    `data:text/javascript,${encodeURIComponent(runnable)}#${crypto.randomUUID()}`
  );
  const original = WorkingX509Certificate.prototype.toString;
  installX509ToStringCompatibility(Uint8Array.from([1]));
  assert.equal(WorkingX509Certificate.prototype.toString, original);
});
