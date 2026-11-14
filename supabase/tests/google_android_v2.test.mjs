// Android (Google Play) v2: plan mapping, sync_subscription current-plan path, and the
// real-time notification receiver. Edge Functions run with their imports replaced by fakes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const fn = (path) => new URL(`../functions/${path}`, import.meta.url);
const pure = (path) => stripTypeScriptTypes(readFileSync(fn(path), 'utf8')).replace(/^import .*$/gm, '').replace(/^export /gm, '');
const v2Source = pure('_shared/google_subscription_v2.ts');
const { googleV2SyncInput, isGoogleV2Product, GOOGLE_V2_PLAN_CREDITS, GoogleSubscriptionInputError } =
  await import(`data:text/javascript,${encodeURIComponent(v2Source + '\nexport { googleV2SyncInput, isGoogleV2Product, GOOGLE_V2_PLAN_CREDITS, GoogleSubscriptionInputError };')}`);

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const BASIC = 'com.kingboard.app.monthly_basic';
const TOKEN = '6f1c2a5e-8d3b-4c7a-9e21-0b4d5f6a7c8e';

test('android plans give exactly the iOS plan credits', () => {
  const credits = readFileSync(fn('sync_subscription/_shared/credits.ts'), 'utf8');
  const plan = (n) => Number(new RegExp(`PLAN${n}_MONTHLY_CREDITS = (\\d+)`).exec(credits)[1]);
  assert.deepEqual({ ...GOOGLE_V2_PLAN_CREDITS }, {
    'com.kingboard.app.monthly_basic': plan(1), 'com.kingboard.app.monthly_premium': plan(2),
    'com.kingboard.app.monthly_pro': plan(3), 'com.kingboard.app.monthly_max': plan(4),
  });
  assert.equal(isGoogleV2Product('kingboard_monthly_500'), false, 'old Android plans keep the old path');
});

test('plan mapping: paid period is active (even with auto-renew off), everything else never grants', () => {
  const v = (state, expiry, linked = null) => ({ active: true, state, expiryTimeMillis: expiry, linkedPurchaseToken: linked });
  assert.deepEqual(googleV2SyncInput(v('SUBSCRIPTION_STATE_ACTIVE', NOW + DAY), BASIC, 'tok', NOW),
    { state: 'SUBSCRIPTION_STATE_ACTIVE', expiryTimeMillis: NOW + DAY, amount: 4000, linkedPurchaseToken: null,
      cycleKey: `tok:${BASIC}:${NOW + DAY}` });
  assert.equal(googleV2SyncInput(v('SUBSCRIPTION_STATE_CANCELED', NOW + DAY), BASIC, 'tok', NOW).state, 'SUBSCRIPTION_STATE_ACTIVE');
  assert.equal(googleV2SyncInput(v('SUBSCRIPTION_STATE_CANCELED', NOW - 1), BASIC, 'tok', NOW).state, 'SUBSCRIPTION_STATE_EXPIRED');
  assert.equal(googleV2SyncInput(v('SUBSCRIPTION_STATE_ACTIVE', NOW - 1), BASIC, 'tok', NOW).cycleKey, null);
  for (const state of ['SUBSCRIPTION_STATE_IN_GRACE_PERIOD', 'SUBSCRIPTION_STATE_ON_HOLD', 'SUBSCRIPTION_STATE_PAUSED']) {
    const r = googleV2SyncInput(v(state, NOW + DAY), BASIC, 'tok', NOW);
    assert.deepEqual([r.state, r.cycleKey], [state, null]);
  }
  for (const state of ['SUBSCRIPTION_STATE_EXPIRED', 'SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED', 'SOMETHING_NEW']) {
    assert.equal(googleV2SyncInput(v(state, NOW + DAY), BASIC, 'tok', NOW).state, 'SUBSCRIPTION_STATE_EXPIRED');
  }
  assert.throws(() => googleV2SyncInput(v('SUBSCRIPTION_STATE_PENDING', NOW + DAY), BASIC, 'tok', NOW), /subscription_pending/);
  assert.throws(() => googleV2SyncInput(v('SUBSCRIPTION_STATE_ACTIVE', NOW + DAY), BASIC, 'to:k', NOW), /invalid_purchase_token/);
  assert.equal(googleV2SyncInput(v('SUBSCRIPTION_STATE_ACTIVE', NOW + DAY, 'old'), BASIC, 'tok', NOW).linkedPurchaseToken, 'old');
  assert.equal(googleV2SyncInput(v('SUBSCRIPTION_STATE_ACTIVE', NOW + DAY, 'tok'), BASIC, 'tok', NOW).linkedPurchaseToken, null);
});

// ---------------- sync_subscription (current plans) ----------------

const syncSource = stripTypeScriptTypes(readFileSync(fn('sync_subscription/index.ts'), 'utf8')
  .replace(/^import \{ createClient \} from .*$/m, 'const createClient = globalThis.__db;')
  .replace(/^import \{[\s\S]*?\} from '\.\/_shared\/credits\.ts'$/m,
    'const { getCredits, googleSubscriptionCreditsForProduct, setMonthlySubscriptionCredits } = globalThis.__credits;')
  .replace(/^import \{ acknowledgeSubscription, verifySubscription \} from .*$/m,
    'const { acknowledgeSubscription, verifySubscription } = globalThis.__play;')
  .replace(/^import \{ GoogleSubscriptionInputError, googleV2SyncInput, isGoogleV2Product \} from .*$/m, '')
  .replace(/^import \{ resolveCreditWallet, WalletAccessError \} from .*$/m,
    'const { resolveCreditWallet, WalletAccessError } = globalThis.__wallet;')
  .replace(/^import \{[\s\S]*?\} from '\.\/_shared\/subscription_audit\.ts'$/m,
    'const { logSubscriptionAudit, safeSubscriptionFailureCode, subscriptionFailureHttpStatus, subscriptionTransactionFingerprint, subscriptionWalletFingerprint } = globalThis.__audit;'))
  + '\n' + v2Source;

class WalletAccessError extends Error { constructor(m, s) { super(m); this.status = s; } }
const activeSub = (extra = {}) => ({ active: true, state: 'SUBSCRIPTION_STATE_ACTIVE', expiryTimeMillis: Date.now() + 20 * DAY,
  cycleKey: 'x', orderId: 'GPA.5-5', obfuscatedAccountId: TOKEN, acknowledged: false, linkedPurchaseToken: null, testPurchase: false, ...extra });

async function runSync(body, { verified = activeSub(), owner = 'google:1', authenticated = true, rpcResult, ackError } = {}) {
  let handler;
  const rpc = [];
  const acks = [];
  const forced = [];
  globalThis.Deno = { env: { get: (k) => ({ SUPABASE_URL: 'u', SUPABASE_SERVICE_ROLE_KEY: 's' })[k] }, serve: (f) => { handler = f; } };
  globalThis.__wallet = { WalletAccessError, resolveCreditWallet: async (_r, _d, id, force) => { forced.push(force); return { walletId: id, authenticated }; } };
  globalThis.__credits = { getCredits: async () => ({}), googleSubscriptionCreditsForProduct: () => 500, setMonthlySubscriptionCredits: async () => ({}) };
  globalThis.__audit = { logSubscriptionAudit: () => {}, safeSubscriptionFailureCode: () => 'x', subscriptionFailureHttpStatus: () => null,
    subscriptionTransactionFingerprint: async () => 'tf', subscriptionWalletFingerprint: async () => 'wf' };
  globalThis.__play = {
    verifySubscription: async (pkg) => { assert.equal(pkg, 'com.spellcheck.keyboard'); return verified; },
    acknowledgeSubscription: async (...args) => { if (ackError) throw ackError; acks.push(args); },
  };
  globalThis.__db = () => ({
    from: () => ({ select() { return this; }, eq() { return this; }, async maybeSingle() { return { data: { apple_user_id: owner }, error: null }; } }),
    async rpc(name, args) {
      rpc.push({ name, args });
      if (name === 'credit_pack_account_token') return { data: TOKEN, error: null };
      return rpcResult ?? { data: [{ applied: true, free_credits_remaining: 10, paid_credits_remaining: 4000, credits_remaining: 4010 }], error: null };
    },
  });
  await import(`data:text/javascript,${encodeURIComponent(syncSource)}#${crypto.randomUUID()}`);
  const res = await handler(new Request('https://x/sync_subscription', { method: 'POST', body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json(), rpc, acks, forced };
}

const subBody = { deviceId: 'v2:g', productId: BASIC, purchaseToken: 'sub-token', packageName: 'evil.package' };

test('sync v2: verified, bound to the account token, synced atomically, then acknowledged', async () => {
  const r = await runSync(subBody);
  assert.equal(r.status, 200);
  assert.deepEqual(r.forced, [true], 'a wallet session is always required');
  const call = r.rpc.find((c) => c.name === 'sync_google_subscription_v2_once');
  assert.equal(call.args.p_amount, 4000);
  assert.equal(call.args.p_state, 'SUBSCRIPTION_STATE_ACTIVE');
  assert.match(call.args.p_cycle_key, new RegExp(`^sub-token:${BASIC.replace(/\./g, '\\.')}:\\d+$`));
  assert.equal(call.args.p_metadata.google_purchase_verified, true);
  assert.equal(r.body.monthly_credit_granted, true);
  assert.equal(r.body.acknowledged, true);
  assert.deepEqual(r.acks, [['com.spellcheck.keyboard', BASIC, 'sub-token']], 'the client package name is never trusted');
});

test('sync v2: another account\'s subscription, guests and pending purchases never sync', async () => {
  const foreign = await runSync(subBody, { verified: activeSub({ obfuscatedAccountId: 'v2:g' }) });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.rpc.some((c) => c.name === 'sync_google_subscription_v2_once'), false);
  const guest = await runSync(subBody, { owner: null });
  assert.deepEqual([guest.status, guest.body.error], [403, 'google_sign_in_required']);
  const pending = await runSync(subBody, { verified: activeSub({ state: 'SUBSCRIPTION_STATE_PENDING' }) });
  assert.equal(pending.status, 202);
  assert.equal(pending.rpc.some((c) => c.name === 'sync_google_subscription_v2_once'), false);
});

test('sync v2: acknowledgement failure keeps the grant and reports acknowledged:false', async () => {
  const r = await runSync(subBody, { ackError: new Error('busy') });
  assert.equal(r.status, 200);
  assert.equal(r.body.acknowledged, false);
  assert.equal(r.body.monthly_credit_granted, true);
});

// ---------------- google_play_notifications ----------------

const rtdnSource = stripTypeScriptTypes(readFileSync(fn('google_play_notifications/index.ts'), 'utf8')
  .replace(/^import \{ createClient \} from .*$/m, 'const createClient = globalThis.__db;')
  .replace(/^import \{ verifyGooglePushToken \} from .*$/m, 'const verifyGooglePushToken = globalThis.__push;')
  .replace(/^import \{ acknowledgeSubscription, verifySubscription \} from .*$/m, 'const { acknowledgeSubscription, verifySubscription } = globalThis.__play;')
  .replace(/^import \{ consumeProductPurchase, getProductPurchase, purchaseTokenHash \} from .*$/m,
    'const { consumeProductPurchase, getProductPurchase, purchaseTokenHash } = globalThis.__products;')
  .replace(/^import \{ CREDIT_PACK_PRODUCTS, CreditPackClaimError \} from .*$/m, '')
  .replace(/^import \{ validateGooglePackClaim \} from .*$/m, '')
  .replace(/^import \{ googleV2SyncInput, isGoogleV2Product \} from .*$/m, '')
  .replace(/^import \{ sendTelegram \} from .*$/m, 'const sendTelegram = async (t) => { globalThis.__telegram.push(t); return true; };'))
  + '\n' + pure('credit_pack_purchase/_shared/credit_pack_validation.ts')
  + '\n' + pure('credit_pack_purchase/_shared/google_pack_validation.ts') + '\n' + v2Source;

const pack = { orderId: 'GPA.7777-1', purchaseState: 0, consumptionState: 0, quantity: 1, obfuscatedExternalAccountId: TOKEN };

async function rtdn(note, { authorized = true, enabled = true, purchase = pack, verified = activeSub(), subRows = {},
  rpcOverride = {}, known = null } = {}) {
  let handler;
  const rpc = [];
  const consumed = [];
  globalThis.__telegram = [];
  globalThis.Deno = { env: { get: (k) => ({ SUPABASE_URL: 'u', SUPABASE_SERVICE_ROLE_KEY: 's', GOOGLE_RTDN_ENABLED: enabled ? 'true' : undefined,
    GOOGLE_RTDN_PUSH_AUDIENCE: 'aud', GOOGLE_RTDN_PUSH_SERVICE_ACCOUNT: 'push@x' })[k] }, serve: (f) => { handler = f; } };
  globalThis.__push = async () => authorized;
  globalThis.__play = { verifySubscription: async () => verified, acknowledgeSubscription: async () => {} };
  globalThis.__products = {
    purchaseTokenHash: async () => 'f'.repeat(64),
    getProductPurchase: async (_p, productId) => (typeof purchase === 'function' ? purchase(productId) : purchase),
    consumeProductPurchase: async (...a) => { consumed.push(a); },
  };
  globalThis.__db = () => ({
    from: (table) => {
      let value;
      const q = { select() { return q; }, eq(_c, v) { value = v; return q; },
        async maybeSingle() { return { data: table === 'device_subscriptions' ? (subRows[value] ? { device_id: subRows[value] } : null) : known, error: null }; } };
      return q;
    },
    async rpc(name, args) {
      rpc.push({ name, args });
      if (rpcOverride[name]) return rpcOverride[name];
      if (name === 'credit_pack_wallet_for_account_token') return { data: 'v2:g', error: null };
      if (name === 'grant_google_credit_pack_once') return { data: [{ result: 'granted', credits: 7000, paid_credits: 7000 }], error: null };
      if (name === 'refund_google_credit_pack_once') return { data: [{ result: 'recovered', recovered: 7000, shortfall: 0 }], error: null };
      if (name === 'expire_google_subscription_credits') return { data: [{ result: 'cleared', cleared: 4000 }], error: null };
      return { data: [{ applied: true }], error: null };
    },
  });
  await import(`data:text/javascript,${encodeURIComponent(rtdnSource)}#${crypto.randomUUID()}`);
  const data = Buffer.from(JSON.stringify({ packageName: 'com.spellcheck.keyboard', ...note })).toString('base64');
  const res = await handler(new Request('https://x/google_play_notifications', { method: 'POST',
    body: JSON.stringify({ message: { data, messageId: 'm1' } }) }));
  return { status: res.status, body: await res.json(), rpc, consumed, telegram: globalThis.__telegram };
}

test('rtdn: off by default, and only Google\'s signed push is accepted', async () => {
  assert.equal((await rtdn({ testNotification: {} }, { enabled: false })).status, 404);
  const forged = await rtdn({ oneTimeProductNotification: { notificationType: 1, purchaseToken: 't', sku: 'com.kingboard.app.credits_7000' } },
    { authorized: false });
  assert.equal(forged.status, 401);
  assert.equal(forged.rpc.length, 0);
  assert.deepEqual((await rtdn({ packageName: 'other.app', testNotification: {} })).body, { ignored: 'other_package' });
});

test('rtdn: a pack paid outside the app is granted to the account-token wallet and consumed', async () => {
  const r = await rtdn({ oneTimeProductNotification: { notificationType: 1, purchaseToken: 'pt', sku: 'com.kingboard.app.credits_7000' } });
  assert.equal(r.status, 200);
  const g = r.rpc.find((c) => c.name === 'grant_google_credit_pack_once');
  assert.deepEqual([g.args.p_wallet_id, g.args.p_order_id, g.args.p_environment], ['v2:g', 'GPA.7777-1', 'Production']);
  assert.equal(r.consumed.length, 1);
  const pending = await rtdn({ oneTimeProductNotification: { notificationType: 1, purchaseToken: 'pt', sku: 'com.kingboard.app.credits_7000' } },
    { purchase: { ...pack, purchaseState: 2 } });
  assert.equal(pending.rpc.some((c) => c.name === 'grant_google_credit_pack_once'), false);
  const notPack = await rtdn({ oneTimeProductNotification: { notificationType: 1, purchaseToken: 'pt', sku: 'com.kingboard.app.features_lifetime' } });
  assert.equal(notPack.rpc.length, 0, 'the lifetime pass is not a credit pack');
});

test('rtdn: a voided pack is refunded; the product is found from our record or from Google', async () => {
  const known = await rtdn({ voidedPurchaseNotification: { purchaseToken: 'pt', orderId: 'GPA.7777-1', productType: 2 } },
    { known: { product_id: 'com.kingboard.app.credits_18000', environment: 'Production' } });
  assert.equal(known.rpc.find((c) => c.name === 'refund_google_credit_pack_once').args.p_product_id, 'com.kingboard.app.credits_18000');
  const unclaimed = await rtdn({ voidedPurchaseNotification: { purchaseToken: 'pt', orderId: 'GPA.7777-1', productType: 2 } },
    { purchase: (productId) => productId === 'com.kingboard.app.credits_7000' ? { ...pack, purchaseType: 0 } : { orderId: 'GPA.other' } });
  const call = unclaimed.rpc.find((c) => c.name === 'refund_google_credit_pack_once');
  assert.deepEqual([call.args.p_product_id, call.args.p_environment], ['com.kingboard.app.credits_7000', 'Sandbox']);
  const sub = await rtdn({ voidedPurchaseNotification: { purchaseToken: 'pt', orderId: 'GPA.9-9', productType: 1 } });
  assert.equal(sub.rpc.length, 0, 'subscription refunds are reported, never cleared automatically');
  assert.equal(sub.telegram.length, 1);
});

test('rtdn: renewals sync the wallet holding the token; expiry clears subscription credits', async () => {
  const renew = await rtdn({ subscriptionNotification: { notificationType: 2, purchaseToken: 'st', subscriptionId: BASIC } },
    { subRows: { st: 'v2:g' } });
  const s = renew.rpc.find((c) => c.name === 'sync_google_subscription_v2_once');
  assert.deepEqual([s.args.p_device_id, s.args.p_state, s.args.p_amount], ['v2:g', 'SUBSCRIPTION_STATE_ACTIVE', 4000]);
  assert.equal(renew.rpc.some((c) => c.name === 'expire_google_subscription_credits'), false);

  const upgrade = await rtdn({ subscriptionNotification: { notificationType: 4, purchaseToken: 'new', subscriptionId: 'com.kingboard.app.monthly_pro' } },
    { subRows: { old: 'v2:g' }, verified: activeSub({ linkedPurchaseToken: 'old' }) });
  const u = upgrade.rpc.find((c) => c.name === 'sync_google_subscription_v2_once');
  assert.deepEqual([u.args.p_device_id, u.args.p_linked_purchase_token, u.args.p_amount], ['v2:g', 'old', 30000]);

  const expired = await rtdn({ subscriptionNotification: { notificationType: 13, purchaseToken: 'st', subscriptionId: BASIC } },
    { subRows: { st: 'v2:g' }, verified: activeSub({ state: 'SUBSCRIPTION_STATE_EXPIRED', expiryTimeMillis: Date.now() - DAY }) });
  assert.equal(expired.rpc.find((c) => c.name === 'sync_google_subscription_v2_once').args.p_state, 'SUBSCRIPTION_STATE_EXPIRED');
  assert.equal(expired.rpc.at(-1).name, 'expire_google_subscription_credits');

  const old = await rtdn({ subscriptionNotification: { notificationType: 2, purchaseToken: 'st', subscriptionId: 'kingboard_monthly_500' } });
  assert.equal(old.rpc.length, 0, 'old Android plans are not handled here');
});

test('rtdn: review-type rejections are reported once and not retried; outages are retried', async () => {
  const review = await rtdn({ subscriptionNotification: { notificationType: 2, purchaseToken: 'st', subscriptionId: BASIC } },
    { subRows: { st: 'v2:g' }, rpcOverride: { sync_google_subscription_v2_once: { data: null, error: { message: 'Google subscription token change requires review' } } } });
  assert.deepEqual([review.status, review.body.ok, review.telegram.length], [200, 'review_required', 1]);
  const down = await rtdn({ subscriptionNotification: { notificationType: 2, purchaseToken: 'st', subscriptionId: BASIC } },
    { subRows: { st: 'v2:g' }, rpcOverride: { sync_google_subscription_v2_once: { data: null, error: { message: 'connection reset' } } } });
  assert.equal(down.status, 500);
});
