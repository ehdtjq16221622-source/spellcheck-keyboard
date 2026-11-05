import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = readFileSync(new URL('../functions/sync_subscription_ios/_shared/wallet_auth.ts', import.meta.url), 'utf8');
const runnable = stripTypeScriptTypes(source.replace(/^import type .*$/m, ''));
globalThis.Deno = { env: { get: () => undefined } };
const auth = await import(`data:text/javascript,${encodeURIComponent(runnable)}`);

const hash = (value) => createHash('sha256').update(value).digest('hex');
const OLD = 'a'.repeat(64);
const NEW = 'b'.repeat(64);
const WALLET = 'v2:wallet';
const APPLE = 'apple-sub';

function db({ revokedAgoMs = 700, successor = {}, rotatedTo = hash(NEW) } = {}) {
  const now = Date.now();
  const sessions = {
    [hash(OLD)]: { wallet_id: WALLET, apple_sub: APPLE, expires_at: new Date(now + 4 * 86400000).toISOString(),
      revoked_at: revokedAgoMs === null ? null : new Date(now - revokedAgoMs).toISOString(), rotated_to_hash: rotatedTo },
    [hash(NEW)]: { wallet_id: WALLET, apple_sub: APPLE, expires_at: new Date(now + 29 * 86400000).toISOString(),
      revoked_at: null, rotated_to_hash: null, ...successor },
  };
  const rows = {
    credit_wallet_sessions: (col, val) => (col === 'token_hash' ? sessions[val] ?? null : null),
    device_credits: (col, val) => (col === 'device_id' && val === WALLET ? { apple_user_id: APPLE } : null),
    wallet_v2_credentials: () => null,
    credit_wallet_aliases: () => null,
  };
  return { from: (table) => ({ select: () => ({ eq: (col, val) => ({
    maybeSingle: async () => ({ data: rows[table]?.(col, val) ?? null, error: null }),
  }) }) }) };
}

const request = (token) => new Request('https://example.invalid/sync_subscription_ios', {
  headers: { Authorization: `Bearer ${token}` },
});

test('old token right after rotation resolves to the live successor', async () => {
  const result = await auth.resolveCreditWallet(request(OLD), db(), WALLET);
  assert.deepEqual(result, { walletId: WALLET, authenticated: true });
});

test('old token after the grace window is still rejected', async () => {
  await assert.rejects(auth.resolveCreditWallet(request(OLD), db({ revokedAgoMs: 61_000 }), WALLET),
    (error) => error.status === 401);
});

test('a revoked successor does not rescue the old token', async () => {
  await assert.rejects(auth.resolveCreditWallet(request(OLD),
    db({ successor: { revoked_at: new Date().toISOString() } }), WALLET), (error) => error.status === 401);
});

test('a successor for another wallet does not rescue the old token', async () => {
  await assert.rejects(auth.resolveCreditWallet(request(OLD),
    db({ successor: { wallet_id: 'v2:other' } }), WALLET), (error) => error.status === 401);
});

test('a token revoked without rotation (sign-out) is rejected immediately', async () => {
  await assert.rejects(auth.resolveCreditWallet(request(OLD), db({ rotatedTo: null }), WALLET),
    (error) => error.status === 401);
});

test('the new token keeps working normally', async () => {
  const result = await auth.resolveCreditWallet(request(NEW), db(), WALLET);
  assert.deepEqual(result, { walletId: WALLET, authenticated: true });
});
