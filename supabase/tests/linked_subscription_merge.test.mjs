import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = readFileSync(new URL('../functions/wallet_link_v2/index.ts', import.meta.url), 'utf8');
const start = source.indexOf('    async function mergeLinkedAppleSubject(');
const end = source.indexOf("    if (body.action === 'enroll_bonus_canary')", start);
assert.ok(start >= 0 && end > start);
const code = stripTypeScriptTypes(source.slice(start, end));
const makeMerge = new Function('supabase', 'auditedRpc', 'audit', 'verifySubscribedGuestPurchase',
  `${code}; return mergeLinkedAppleSubject;`);

async function run({ enabled = true, verified = true, reason = 'Second wallet subscription requires transaction review', mergeError = null } = {}) {
  globalThis.Deno = { env: { get: () => enabled ? 'true' : undefined } };
  const calls = [];
  const db = { from: table => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({
    data: table === 'device_subscriptions' ? { product_id: 'basic', purchase_token: 'purchase' } : null,
    error: null,
  }) }) }) }) };
  const rpc = async (name, args) => {
    calls.push({ name, args });
    if (name === 'merge_linked_apple_subject_wallets_once') return { error: { code: 'P0001', message: reason } };
    return mergeError ? { error: mergeError } : { data: [{ decision: 'merged', canonical_wallet_id: 'current' }] };
  };
  const merge = makeMerge(db, rpc, () => {}, async () => verified);
  return { result: await merge('apple', 'current', 'session-hash', 'request'), calls };
}

test('subscription merge requires feature gate, Apple verification and the specific review reason', async () => {
  for (const options of [{ enabled: false }, { verified: false }, { reason: 'Wallet ownership changed during merge' }]) {
    const { result, calls } = await run(options);
    assert.equal(result.decision, 'review_required');
    assert.equal(calls.length, 1);
  }
  const { result, calls } = await run();
  assert.equal(result.decision, 'merged');
  assert.equal(calls[1].args.p_source_wallet_id, 'apple');
  assert.equal(calls[1].args.p_session_token_hash, 'session-hash');
  assert.equal(calls[1].args.p_verified_subscription_token, 'purchase');
});

test('recent usage defers and other review errors do not merge', async () => {
  for (const [message, expected] of [
    ['Recent AI usage must settle before wallet merge', 'retry_later'],
    ['Wallet ownership changed during merge', 'review_required'],
  ]) {
    const { result } = await run({ mergeError: { code: 'P0001', message } });
    assert.equal(result.decision, expected);
  }
});
