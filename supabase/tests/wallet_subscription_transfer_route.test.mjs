import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = readFileSync(new URL('../functions/wallet_link_v2/index.ts', import.meta.url), 'utf8');
const runnable = stripTypeScriptTypes(source
  .replace(/^import \{ createClient \} from .*$/m, 'const createClient = globalThis.__createClient;')
  .replace(/^import \{ verifyAppleIdentityToken \} from .*$/m,
    'const verifyAppleIdentityToken = globalThis.__verifyAppleIdentityToken;')
  .replace(/^import \{ verifyActiveApplePurchase \} from .*$/m,
    'const verifyActiveApplePurchase = globalThis.__verifyActiveApplePurchase;')
  .replace(/^import \{ walletTokenHash \} from .*$/m,
    'const walletTokenHash = globalThis.__walletTokenHash;')
  .replace(/^import \{ enrollBonusCanaryDevice, isBonusCanaryDevice \} from .*$/m,
    'const enrollBonusCanaryDevice = globalThis.__enrollBonusCanaryDevice; const isBonusCanaryDevice = globalThis.__isBonusCanaryDevice;'));

const secret = 'a'.repeat(64);
const walletId = 'v2:11111111-1111-1111-1111-111111111111';
const secretHash = Array.from(new Uint8Array(await crypto.subtle.digest(
  'SHA-256', new TextEncoder().encode(secret),
)), (byte) => byte.toString(16).padStart(2, '0')).join('');

async function run(purchaseActive, action = 'merge_subscribed_guest') {
  let handler;
  const calls = [];
  globalThis.Deno = {
    env: { get: (key) => ({
      WALLET_SESSIONS_ENABLED: 'true', WALLET_LINK_V2_ENABLED: 'true',
      WALLET_LINK_V2_CANARY_APPLE_IDS: 'apple-sub',
      WALLET_SUBSCRIPTION_MERGE_CANARY_APPLE_IDS: 'apple-sub',
      SUPABASE_URL: 'https://example.invalid', SUPABASE_SERVICE_ROLE_KEY: 'test',
    })[key] },
    serve: (value) => { handler = value; },
  };
  globalThis.__verifyAppleIdentityToken = async () => ({ sub: 'apple-sub' });
  globalThis.__verifyActiveApplePurchase = async (...args) => {
    calls.push({ purchaseArgs: args });
    return purchaseActive;
  };
  globalThis.__walletTokenHash = async () => 'b'.repeat(64);
  globalThis.__enrollBonusCanaryDevice = async () => {};
  globalThis.__isBonusCanaryDevice = async () => false;
  globalThis.__createClient = () => ({
    from: (table) => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({
        data: table === 'wallet_v2_credentials'
          ? { secret_hash: secretHash, state: 'active' }
          : { product_id: 'monthly', purchase_token: 'purchase-1' },
        error: null,
      }), single: async () => ({ data: { subscription_credits: 3000 }, error: null }) }) }),
    }),
    rpc: async (name, args) => {
      calls.push({ name, args });
      return { data: [{ decision: name === 'link_apple_wallet_v2' ? 'apple_existing_unmerged' : 'merged',
        canonical_wallet_id: 'apple-wallet',
        free_credits_remaining: 500, paid_credits_remaining: 3000 }], error: null };
    },
  });
  await import(`data:text/javascript,${encodeURIComponent(runnable)}#${crypto.randomUUID()}`);
  const response = await handler(new Request('https://example.invalid/wallet_link_v2', {
    method: 'POST', body: JSON.stringify({ action,
      walletId, walletSecret: secret, identityToken: 'identity',
      sessionToken: 'c'.repeat(64), idempotencyKey: 'merge-1',
    }),
  }));
  return { status: response.status, body: await response.json(), calls };
}

test('existing Apple wallet link tells the app when subscription transfer is needed', async () => {
  const linked = await run(true, 'link');
  assert.equal(linked.status, 200);
  assert.equal(linked.body.decision, 'apple_existing_unmerged');
  assert.equal(linked.body.needsSubscriptionTransfer, true);
  assert.deepEqual(linked.calls.filter((call) => call.name).map((call) => call.name),
    ['link_apple_wallet_v2']);
});

test('subscription merge requires Apple to confirm the stored purchase', async () => {
  const mismatch = await run(false);
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.calls.some((call) => call.name), false);
  const matching = await run(true);
  assert.equal(matching.status, 200);
  assert.deepEqual(matching.calls[0].purchaseArgs,
    ['purchase-1', 'monthly', 'com.kingboard.app']);
  assert.deepEqual(matching.calls.filter((call) => call.name).map((call) => call.name),
    ['merge_verified_v2_subscribed_guest_once']);
});
