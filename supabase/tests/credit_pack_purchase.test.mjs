import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const dir = new URL('../functions/credit_pack_purchase/', import.meta.url);
const validation = stripTypeScriptTypes(readFileSync(new URL('_shared/credit_pack_validation.ts', dir), 'utf8'))
  .replace(/^export /gm, '');
const runnable = stripTypeScriptTypes(readFileSync(new URL('index.ts', dir), 'utf8')
  .replace(/^import \{ createClient \} from .*$/m, 'const createClient = globalThis.__db;')
  .replace(/^import \{ fetchCurrentAppleTransaction, verifyAppleTransactionJws \} from .*$/m,
    'const { fetchCurrentAppleTransaction, verifyAppleTransactionJws } = globalThis.__apple;')
  .replace(/^import \{ resolveCreditWallet, WalletAccessError \} from .*$/m,
    'const { resolveCreditWallet, WalletAccessError } = globalThis.__wallet;')
  .replace(/^import \{ CreditPackClaimError, validateCreditPackClaim \} from .*$/m, '')
  .replace(/^import \{ sendTelegram \} from .*$/m, 'const sendTelegram = async (t) => { globalThis.__telegram.push(t); return true; };'))
  + '\n' + validation;

const TOKEN = '6f1c2a5e-8d3b-4c7a-9e21-0b4d5f6a7c8e';
const tx = { bundleId: 'com.kingboard.app', environment: 'Production', transactionId: '4000001', originalTransactionId: '4000001',
  productId: 'com.kingboard.app.credits_7000', appAccountToken: TOKEN, quantity: 1, inAppOwnershipType: 'PURCHASED' };

class WalletAccessError extends Error { constructor(m, s) { super(m); this.status = s; } }

async function call(body, { appleUser = 'apple-sub', authenticated = true, current = tx, submitted = tx,
  grant = { data: [{ result: 'granted', credits: 7000, paid_credits: 7100 }], error: null }, walletError } = {}) {
  const rpc = [];
  globalThis.__telegram = [];
  let handler;
  globalThis.Deno = { env: { get: (k) => ({ SUPABASE_URL: 'u', SUPABASE_SERVICE_ROLE_KEY: 's' })[k] }, serve: (fn) => { handler = fn; } };
  globalThis.__wallet = { WalletAccessError, resolveCreditWallet: async (_req, _db, id, force) => {
    assert.equal(force, true, 'packs always require a wallet session');
    if (walletError) throw walletError;
    return { walletId: id, authenticated };
  } };
  globalThis.__apple = { verifyAppleTransactionJws: async () => submitted, fetchCurrentAppleTransaction: async () => current };
  globalThis.__db = () => ({
    from: () => ({ select() { return this; }, eq() { return this; },
      async maybeSingle() { return { data: { apple_user_id: appleUser }, error: null }; } }),
    async rpc(name, args) {
      rpc.push({ name, args });
      if (name === 'credit_pack_account_token') return { data: TOKEN, error: null };
      if (name === 'grant_credit_pack_once') return grant;
      return { data: [{ result: 'recorded_unclaimed' }], error: null };
    },
  });
  await import(`data:text/javascript,${encodeURIComponent(runnable)}#${crypto.randomUUID()}`);
  const res = await handler(new Request('https://x/credit_pack_purchase', { method: 'POST', body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json(), rpc, telegram: globalThis.__telegram };
}

test('account token is issued only to an Apple-linked wallet session', async () => {
  const ok = await call({ action: 'account_token', wallet_id: 'v2:a' });
  assert.deepEqual(ok, { status: 200, body: { account_token: TOKEN }, rpc: ok.rpc, telegram: [] });
  assert.equal((await call({ action: 'account_token', wallet_id: 'v2:a' }, { appleUser: null })).status, 403);
  assert.equal((await call({ action: 'account_token', wallet_id: 'v2:a' }, { authenticated: false })).status, 403);
  const rejected = await call({ action: 'account_token', wallet_id: 'v2:a' }, { walletError: new WalletAccessError('x', 401) });
  assert.equal(rejected.status, 401);
});

test('a verified claim grants through the database function with the wallet token', async () => {
  const r = await call({ action: 'claim', wallet_id: 'v2:a', signed_transaction: 'jws' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { result: 'granted', credits: 7000, paid_credits: 7100 });
  const g = r.rpc.find((c) => c.name === 'grant_credit_pack_once');
  assert.deepEqual(g.args, { p_wallet_id: 'v2:a', p_account_token: TOKEN, p_transaction_id: '4000001',
    p_original_transaction_id: '4000001', p_product_id: 'com.kingboard.app.credits_7000', p_environment: 'Production' });
  assert.match(r.telegram[0], /묶음 구매 · 7,000 크레딧 지급/);
});

test('a purchase Apple already refunded is recorded as refunded and never granted', async () => {
  const r = await call({ action: 'claim', wallet_id: 'v2:a', signed_transaction: 'jws' }, { current: { ...tx, revocationDate: 1 } });
  assert.deepEqual(r.body, { result: 'refunded', credits: 0 });
  assert.deepEqual(r.rpc.map((c) => c.name), ['credit_pack_account_token', 'refund_credit_pack_once']);
});

test('mismatched or foreign purchases are rejected with 409 and no grant', async () => {
  for (const submitted of [{ ...tx, appAccountToken: '00000000-0000-4000-8000-000000000000' },
    { ...tx, productId: 'com.kingboard.app.monthly_pro' }]) {
    const r = await call({ action: 'claim', wallet_id: 'v2:a', signed_transaction: 'jws' }, { submitted, current: submitted });
    assert.equal(r.status, 409);
    assert.equal(r.rpc.some((c) => c.name === 'grant_credit_pack_once'), false);
  }
});

test('database rejections are reported as final 409s; unknown failures as retryable', async () => {
  const mismatch = await call({ action: 'claim', wallet_id: 'v2:a', signed_transaction: 'jws' },
    { grant: { data: null, error: { message: 'account_binding_mismatch' } } });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.error, 'account_binding_mismatch');
  const down = await call({ action: 'claim', wallet_id: 'v2:a', signed_transaction: 'jws' },
    { grant: { data: null, error: { message: 'connection reset' } } });
  assert.equal(down.status, 500);
  const limit = await call({ action: 'claim', wallet_id: 'v2:a', signed_transaction: 'jws' },
    { grant: { data: [{ result: 'sandbox_limit', credits: 0, paid_credits: null }], error: null } });
  assert.equal(limit.body.result, 'sandbox_limit');
  assert.match(limit.telegram[0], /한도 초과/);
});

test('bad requests never reach Apple or the database', async () => {
  assert.equal((await call({ action: 'buy', wallet_id: 'v2:a' })).status, 400);
  const r = await call({ action: 'claim', wallet_id: 'v2:a', signed_transaction: '' });
  assert.equal(r.status, 400);
  assert.equal(r.rpc.some((c) => c.name === 'grant_credit_pack_once'), false);
});
