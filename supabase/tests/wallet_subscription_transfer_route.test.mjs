import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = readFileSync(new URL('../functions/wallet_link_v2/index.ts', import.meta.url), 'utf8');
const runnable = stripTypeScriptTypes(source
  .replace(/^import \{ createClient \} from .*$/m, 'const createClient = globalThis.__createClient;')
  .replace(/^import \{ verifyAppleIdentityToken \} from .*$/m,
    'const verifyAppleIdentityToken = globalThis.__verifyAppleIdentityToken;')
  .replace(/^import \{ verifyAppleSubscriptionRecord \} from .*$/m,
    'const verifyAppleSubscriptionRecord = globalThis.__verifyAppleSubscriptionRecord;')
  .replace(/^import \{ walletTokenHash \} from .*$/m,
    'const walletTokenHash = globalThis.__walletTokenHash;')
  .replace(/^import \{ enrollBonusCanaryDevice, isBonusCanaryDevice \} from .*$/m,
    'const enrollBonusCanaryDevice = globalThis.__enrollBonusCanaryDevice; const isBonusCanaryDevice = globalThis.__isBonusCanaryDevice;'));

const secret = 'a'.repeat(64);
const walletId = 'v2:11111111-1111-1111-1111-111111111111';
const secretHash = Array.from(new Uint8Array(await crypto.subtle.digest(
  'SHA-256', new TextEncoder().encode(secret),
)), (byte) => byte.toString(16).padStart(2, '0')).join('');
const deployedCanaryHash = '014252a83ff1048722f43fecfec725a43c4ce151af89bc1aad535f0609de8c45';
const fixtureCanaryHash = Array.from(new Uint8Array(await crypto.subtle.digest(
  'SHA-256', new TextEncoder().encode('apple-sub'),
)), (byte) => byte.toString(16).padStart(2, '0')).join('');

async function run(purchaseActive, action = 'merge_subscribed_guest', options = {}) {
  let handler;
  const calls = [];
  globalThis.Deno = {
    env: { get: (key) => ({
      WALLET_SESSIONS_ENABLED: 'true', WALLET_LINK_V2_ENABLED: 'true',
      WALLET_GUEST_V2_ENABLED: options.guestEnabled ? 'true' : undefined,
      WALLET_LINK_V2_ALL_USERS_ENABLED: options.allUsersEnabled ? 'true' : undefined,
      WALLET_AUTO_MERGE_ALL_USERS_ENABLED: options.autoMergeAllUsersEnabled ? 'true' : undefined,
      WALLET_LINK_V2_CANARY_APPLE_IDS: options.canaryIds ?? 'apple-sub',
      WALLET_LEGACY_MERGE_ENABLED: 'true',
      WALLET_LEGACY_MERGE_CANARY_PAIRS: JSON.stringify({ 'apple-sub': ['legacy-device'] }),
      WALLET_SUBSCRIPTION_MERGE_CANARY_APPLE_IDS: 'apple-sub',
      SUPABASE_URL: 'https://example.invalid', SUPABASE_SERVICE_ROLE_KEY: 'test',
    })[key] },
    serve: (value) => { handler = value; },
  };
  globalThis.__verifyAppleIdentityToken = async () => ({ sub: options.appleSubject ?? 'apple-sub' });
  globalThis.__verifyActiveApplePurchase = async (...args) => {
    calls.push({ purchaseArgs: args });
    return purchaseActive;
  };
  globalThis.__verifyAppleSubscriptionRecord = async (...args) => {
    calls.push({ historicalPurchaseArgs: args });
    return options.historicalPurchaseValid ?? purchaseActive;
  };
  globalThis.__walletTokenHash = async () => 'b'.repeat(64);
  globalThis.__enrollBonusCanaryDevice = async () => {};
  globalThis.__isBonusCanaryDevice = async () => false;
  globalThis.__createClient = () => ({
    from: (table) => {
      const query = {
        eq: () => query,
        order: () => query,
        limit: () => query,
        maybeSingle: async () => ({
          data: table === 'wallet_v2_credentials'
            ? { secret_hash: secretHash, state: options.linkedCredential ? 'linked' : 'active' }
            : table === 'device_subscriptions'
              ? (options.sourcePurchase === false ? null
                : { product_id: 'monthly', purchase_token: 'purchase-1' })
              : table === 'credit_v2_subscription_transfer_grants'
                ? options.priorTransfer ?? null
              : table === 'device_credits'
                ? { device_id: 'apple-wallet', subscription_credits: options.subscriptionCredits ?? 3000 }
                : table === 'credit_wallet_sessions'
                  ? { apple_sub: options.appleSubject ?? 'apple-sub', wallet_id: 'apple-wallet',
                    expires_at: new Date(Date.now() + 86_400_000).toISOString(), revoked_at: null }
                : { metadata: { originalTransactionId: 'purchase-1', productId: 'monthly' } },
          error: null,
        }),
        single: async () => ({ data: { subscription_credits: 3000 }, error: null }),
      };
      return { select: () => query };
    },
    rpc: async (name, args) => {
      calls.push({ name, args });
      return { data: [{ decision: name === 'link_apple_wallet_v2' ? 'apple_existing_unmerged' : 'merged',
        canonical_wallet_id: 'apple-wallet',
        free_credits_remaining: 500, paid_credits_remaining: 3000,
        subscription_credits_remaining: 6000 }], error: null };
    },
  });
  const executable = options.testAppleAccount
    ? runnable.replaceAll(deployedCanaryHash, fixtureCanaryHash)
    : runnable;
  await import(`data:text/javascript,${encodeURIComponent(executable)}#${crypto.randomUUID()}`);
  const response = await handler(new Request('https://example.invalid/wallet_link_v2', {
    method: 'POST', body: JSON.stringify({ action,
      walletId, walletSecret: secret, identityToken: 'identity',
      sourceWalletId: 'legacy-device',
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
  assert.equal(mismatch.body.error, 'Subscription transfer requires review.');
  assert.equal(mismatch.calls.some((call) => call.name), false);
  const matching = await run(true);
  assert.equal(matching.status, 200);
  assert.deepEqual(matching.calls[0].historicalPurchaseArgs,
    ['purchase-1', 'monthly', 'com.kingboard.app', false]);
  assert.deepEqual(matching.calls.filter((call) => call.name).map((call) => call.name),
    ['merge_verified_v2_subscribed_guest_preserving_once']);
});

test('unapproved accounts still receive a purchase mismatch, without a merge', async () => {
  const result = await run(false, 'merge_subscribed_guest', {
    appleSubject: 'other-apple', allUsersEnabled: true, guestEnabled: true,
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'Apple subscription does not match this wallet.');
  assert.equal(result.calls.some((call) => call.name), false);
});

test('legacy merge verifies subscription source and calls the preserving atomic RPC', async () => {
  const denied = await run(false, 'merge_legacy');
  assert.equal(denied.status, 409);
  assert.equal(denied.calls.some((call) => call.name === 'merge_verified_legacy_wallet_v2_once'), false);

  const allowed = await run(true, 'merge_legacy');
  assert.equal(allowed.status, 200);
  assert.deepEqual(allowed.calls.find((call) => call.historicalPurchaseArgs)?.historicalPurchaseArgs,
    ['purchase-1', 'monthly', 'com.kingboard.app']);
  const rpcCall = allowed.calls.find((call) => call.name === 'merge_verified_legacy_wallet_v2_once');
  assert.deepEqual(rpcCall.args, {
    p_source_wallet_id: 'legacy-device', p_apple_sub: 'apple-sub',
    p_session_token_hash: 'b'.repeat(64), p_request_id: 'merge-1',
    p_verified_subscription_token: 'purchase-1', p_verified_product_id: 'monthly',
  });
});

test('global wallet rollout flags cannot bypass the exact legacy wallet allowlist', async () => {
  const result = await run(true, 'merge_legacy', {
    appleSubject: 'unreviewed-apple-subject',
    allUsersEnabled: true,
    guestEnabled: true,
  });
  assert.equal(result.status, 409);
  assert.equal(result.calls.some((call) => call.name === 'merge_verified_legacy_wallet_v2_once'), false);
});

test('legacy merge accepts a verified expired subscription when unspent credits remain', async () => {
  const result = await run(false, 'merge_legacy', {
    historicalPurchaseValid: true,
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.calls.find((call) => call.historicalPurchaseArgs)?.historicalPurchaseArgs,
    ['purchase-1', 'monthly', 'com.kingboard.app']);
  const rpc = result.calls.find((call) => call.name === 'merge_verified_legacy_wallet_v2_once');
  assert.equal(rpc.args.p_verified_subscription_token, 'purchase-1');
  assert.equal(rpc.args.p_verified_product_id, 'monthly');
});

test('signed-in session can resume a deferred merge without another Apple sign-in prompt', async () => {
  const result = await run(true, 'resume_guest_merge', {
    historicalPurchaseValid: true, testAppleAccount: true,
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.canonicalWalletId, 'apple-wallet');
  assert.deepEqual(result.calls.find((call) => call.historicalPurchaseArgs)?.historicalPurchaseArgs,
    ['purchase-1', 'monthly', 'com.kingboard.app', false]);
  assert.ok(result.calls.some((call) => call.name === 'merge_verified_v2_subscribed_guest_preserving_once'));
});

test('general wallet rollout cannot enable automatic merges without its separate rollout flag', async () => {
  const denied = await run(true, 'resume_guest_merge', {
    appleSubject: 'other-apple', canaryIds: 'other-apple',
    allUsersEnabled: true, guestEnabled: true,
  });
  assert.equal(denied.status, 404);
  assert.equal(denied.calls.some((call) => call.name === 'merge_verified_v2_subscribed_guest_preserving_once'), false);

  const enabled = await run(true, 'resume_guest_merge', {
    appleSubject: 'other-apple', allUsersEnabled: true, guestEnabled: true,
    autoMergeAllUsersEnabled: true,
  });
  assert.equal(enabled.status, 200);
  assert.ok(enabled.calls.some((call) => call.name === 'merge_verified_v2_subscribed_guest_preserving_once'));
});

test('a transferred subscription retry uses the durable proof record and needs no live receipt check', async () => {
  const result = await run(false, 'merge_subscribed_guest', {
    linkedCredential: true,
    priorTransfer: { purchase_token: 'purchase-1', request_id: 'merge-1' },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.canonicalWalletId, 'apple-wallet');
  assert.equal(result.calls.some((call) => call.historicalPurchaseArgs), false);
  assert.ok(result.calls.some((call) => call.name === 'merge_verified_v2_subscribed_guest_preserving_once'));
});

test('a linked non-subscription guest can safely retry its atomic merge after a lost response', async () => {
  const result = await run(false, 'resume_guest_merge', {
    linkedCredential: true, sourcePurchase: false, subscriptionCredits: 0,
    testAppleAccount: true,
  });
  assert.equal(result.status, 200);
  assert.ok(result.calls.some((call) => call.name === 'merge_verified_v2_guest_wallet_once'));
});

test('legacy merge verifies a zero-balance purchase mapping before transferring it', async () => {
  const result = await run(true, 'merge_legacy', { subscriptionCredits: 0 });
  assert.equal(result.status, 200);
  assert.deepEqual(result.calls.find((call) => call.historicalPurchaseArgs)?.historicalPurchaseArgs,
    ['purchase-1', 'monthly', 'com.kingboard.app']);
  assert.equal(result.calls.find((call) => call.name === 'merge_verified_legacy_wallet_v2_once')
    .args.p_verified_subscription_token, 'purchase-1');
});

test('legacy merge rejects revoked or mismatched historical purchase before the RPC', async () => {
  const result = await run(true, 'merge_legacy', {
    subscriptionCredits: 0, historicalPurchaseValid: false,
  });
  assert.equal(result.status, 409);
  assert.equal(result.calls.some((call) => call.name === 'merge_verified_legacy_wallet_v2_once'), false);
});

test('general subscribed guest transfer stays closed until guest and Apple rollout are both enabled', async () => {
  const otherAccount = { appleSubject: 'other-apple', allUsersEnabled: true };
  const denied = await run(true, 'merge_subscribed_guest', otherAccount);
  assert.equal(denied.status, 404);
  assert.equal(denied.calls.length, 0);

  const allowed = await run(true, 'merge_subscribed_guest', {
    ...otherAccount, guestEnabled: true,
  });
  assert.equal(allowed.status, 200);
  assert.deepEqual(allowed.calls.filter((call) => call.name).map((call) => call.name),
    ['merge_verified_v2_subscribed_guest_preserving_once']);
});
