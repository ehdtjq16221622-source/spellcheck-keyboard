import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = readFileSync(new URL('../functions/wallet_link_v2/index.ts', import.meta.url), 'utf8');
const runnable = stripTypeScriptTypes(source
  .replace(/^import \{ createClient \} from .*$/m, 'const createClient = globalThis.__createClient;')
  .replace(/^import \{ verifyAppleIdentityToken \} from .*$/m, 'const verifyAppleIdentityToken = globalThis.__verifyApple;')
  .replace(/^import \{ walletTokenHash \} from .*$/m, 'const walletTokenHash = globalThis.__walletTokenHash;')
  .replace(/^import \{ enrollBonusCanaryDevice, isBonusCanaryDevice \} from .*$/m,
    'const enrollBonusCanaryDevice = globalThis.__enrollDevice; const isBonusCanaryDevice = globalThis.__isCanaryDevice;'));

async function invoke(action, extras = {}, options = {}) {
  let handler;
  const rpcCalls = [];
  const deviceCalls = [];
  let appleVerified = false;
  const walletId = 'v2:11111111-1111-1111-1111-111111111111';
  globalThis.Deno = {
    env: { get: (key) => ({
      WALLET_SESSIONS_ENABLED: options.sessionsEnabled === false ? undefined : 'true',
      WALLET_GUEST_V2_ENABLED: options.guestEnabled === false ? undefined : 'true',
      WALLET_DEVICECHECK_BONUS_ENABLED: options.deviceCheckBonusEnabled ? 'true' : undefined,
      WALLET_BONUS_CANARY_ENABLED: options.canaryEnabled ? 'true' : undefined,
      WALLET_LINK_V2_ENABLED: options.appleEnabled ? 'true' : undefined,
      WALLET_LINK_V2_CANARY_APPLE_IDS: options.appleEnabled || options.canaryEnabled ? 'apple' : undefined,
      WALLET_LEGACY_MERGE_ENABLED: options.legacyEnabled ? 'true' : undefined,
      WALLET_LEGACY_MERGE_CANARY_PAIRS: options.legacyPairs,
    })[key] },
    serve: (callback) => { handler = callback; },
  };
  globalThis.__verifyApple = async () => {
    appleVerified = true;
    if (options.appleEnabled || options.canaryEnabled) return { sub: 'apple' };
    throw new Error('Guest flow should not verify Apple JWT');
  };
  globalThis.__walletTokenHash = async (value) => value;
  globalThis.__isCanaryDevice = async (token) => {
    deviceCalls.push({ action: 'query', token });
    return options.marked === true;
  };
  globalThis.__enrollDevice = async (token) => {
    deviceCalls.push({ action: 'enroll', token });
    if (options.enrollFails) throw new Error('DeviceCheck enrollment failed');
  };
  globalThis.__createClient = () => ({
    rpc: async (name, args) => {
      rpcCalls.push({ name, args });
      return { data: name === 'register_guest_wallet_v2' ? walletId
        : name === 'merge_verified_v2_guest_wallet_once' ? [{
          decision: 'merged', canonical_wallet_id: 'apple-wallet',
          free_credits_remaining: 500, paid_credits_remaining: 100,
        }] : name === 'merge_verified_legacy_wallet_once' ? [{
          decision: 'merged', canonical_wallet_id: 'apple-wallet',
          free_credits_remaining: 500, paid_credits_remaining: 100,
        }] : true, error: null };
    },
    from: (table) => ({
      select: () => ({
        eq: () => ({
          lt: () => ({ limit: async () => ({ data: options.freeUsed ? [{ id: 1 }] : [], error: null }) }),
          maybeSingle: async () => ({ data: options.session ?? null, error: null }),
          single: async () => ({
            data: table === 'device_credits'
              ? { free_credits: options.balance ?? 500, paid_credits: 0, apple_user_id: null }
              : { state: 'pending' },
            error: null,
          }),
        }),
      }),
    }),
  });
  await import(`data:text/javascript,${encodeURIComponent(runnable)}#${crypto.randomUUID()}`);
  const response = await handler(new Request('http://localhost/wallet_link_v2', {
    method: 'POST',
    body: JSON.stringify({ action, walletSecret: 'a'.repeat(64), walletId, ...extras }),
  }));
  return { status: response.status, body: await response.json(), rpcCalls, deviceCalls, appleVerified };
}

test('only verified canary owner with recorded free use can enroll a device', async () => {
  const rejected = await invoke('enroll_bonus_canary', {
    identityToken: 'apple-token', deviceToken: 'a'.repeat(64),
  }, { canaryEnabled: true, guestEnabled: false });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.deviceCalls.length, 0);
  const enrolled = await invoke('enroll_bonus_canary', {
    identityToken: 'apple-token', deviceToken: 'a'.repeat(64),
  }, { canaryEnabled: true, guestEnabled: false, freeUsed: true });
  assert.equal(enrolled.status, 200);
  assert.deepEqual(enrolled.deviceCalls, [{ action: 'enroll', token: 'a'.repeat(64) }]);
  assert.equal(enrolled.rpcCalls.length, 0);
});

test('only marked canary device receives a zero-credit fresh wallet', async () => {
  const unmarked = await invoke('register_canary', {
    deviceToken: 'a'.repeat(64), identityToken: 'apple-token',
  },
    { canaryEnabled: true, guestEnabled: false });
  assert.equal(unmarked.status, 404);
  assert.equal(unmarked.rpcCalls.length, 0);
  const marked = await invoke('register_canary', {
    deviceToken: 'a'.repeat(64), identityToken: 'apple-token',
  },
    { canaryEnabled: true, guestEnabled: false, marked: true, balance: 0 });
  assert.equal(marked.status, 201);
  assert.equal(marked.body.freeCredits, 0);
  assert.equal(marked.rpcCalls[0].args.p_initial_bonus, 0);
  const generic = await invoke('register', {},
    { canaryEnabled: true, guestEnabled: true, marked: true });
  assert.equal(generic.status, 201);
  assert.equal(generic.rpcCalls[0].args.p_initial_bonus, 500);
});

test('canary registration requires the Apple identity even on a marked device', async () => {
  const denied = await invoke('register_canary', { deviceToken: 'a'.repeat(64) },
    { canaryEnabled: true, marked: true });
  assert.equal(denied.status, 404);
  assert.equal(denied.rpcCalls.length, 0);
});

test('canary alone leaves ordinary registration and activation disabled', async () => {
  const settings = { canaryEnabled: true, sessionsEnabled: false,
    guestEnabled: false, marked: true, balance: 0 };
  const trial = await invoke('register_canary', {
    deviceToken: 'a'.repeat(64), identityToken: 'apple-token',
  }, settings);
  assert.equal(trial.status, 201);
  assert.equal(trial.rpcCalls[0].args.p_initial_bonus, 0);
  for (const action of ['register', 'register_after_logout', 'activate', 'sign_in']) {
    const denied = await invoke(action, { identityToken: 'apple-token' }, settings);
    assert.equal(denied.status, 404, action);
    assert.equal(denied.rpcCalls.length, 0, action);
  }
});

test('new guest registers for 500 without Apple authentication', async () => {
  const result = await invoke('register');
  assert.equal(result.status, 201);
  assert.equal(result.body.freeCredits, 500);
  assert.equal(result.rpcCalls[0].args.p_initial_bonus, 500);
  assert.equal(result.appleVerified, false);
});

test('DeviceCheck blocks a repeat install bonus when enabled', async () => {
  const token = 'a'.repeat(64);
  const repeated = await invoke('register', { deviceToken: token }, {
    deviceCheckBonusEnabled: true, marked: true, balance: 0,
  });
  assert.equal(repeated.status, 201);
  assert.equal(repeated.rpcCalls[0].args.p_initial_bonus, 0);
  assert.deepEqual(repeated.deviceCalls, [{ action: 'query', token }]);

  const first = await invoke('register', { deviceToken: token }, {
    deviceCheckBonusEnabled: true, balance: 500,
  });
  assert.equal(first.status, 201);
  assert.equal(first.rpcCalls[0].args.p_initial_bonus, 500);
  assert.deepEqual(first.deviceCalls, [
    { action: 'query', token }, { action: 'enroll', token },
  ]);
});

test('DeviceCheck fails closed without a device token', async () => {
  const result = await invoke('register', {}, { deviceCheckBonusEnabled: true });
  assert.equal(result.status, 409);
  assert.equal(result.rpcCalls.length, 0);
});

test('a failed DeviceCheck enrollment cannot create a bonus wallet', async () => {
  const result = await invoke('register', { deviceToken: 'a'.repeat(64) }, {
    deviceCheckBonusEnabled: true, enrollFails: true,
  });
  assert.equal(result.status, 500);
  assert.equal(result.rpcCalls.length, 0);
});

test('logout guest requires an active wallet session and receives zero', async () => {
  const denied = await invoke('register_after_logout');
  assert.equal(denied.status, 400);
  assert.equal(denied.rpcCalls.length, 0);

  const result = await invoke('register_after_logout', { sessionToken: 'b'.repeat(64) }, {
    balance: 0,
    session: { apple_sub: 'apple', revoked_at: null,
      expires_at: new Date(Date.now() + 60_000).toISOString() },
  });
  assert.equal(result.status, 201);
  assert.equal(result.body.freeCredits, 0);
  assert.equal(result.rpcCalls[0].args.p_initial_bonus, 0);
  assert.equal(result.appleVerified, false);
});

test('guest activation proves possession before the wallet can be used', async () => {
  const result = await invoke('activate');
  assert.equal(result.status, 200);
  assert.equal(result.body.activated, true);
  assert.equal(result.rpcCalls[0].name, 'activate_guest_wallet_v2');
});

test('guest merge requires canary Apple proof and forwards both wallet proofs', async () => {
  const body = {
    identityToken: 'verified-apple-jwt', sessionToken: 'b'.repeat(64),
    idempotencyKey: 'merge-1',
  };
  const denied = await invoke('merge_guest', body);
  assert.equal(denied.status, 404);
  assert.equal(denied.rpcCalls.length, 0);

  const result = await invoke('merge_guest', body, { appleEnabled: true });
  assert.equal(result.status, 200);
  assert.equal(result.appleVerified, true);
  assert.equal(result.body.canonicalWalletId, 'apple-wallet');
  assert.equal(result.rpcCalls[0].name, 'merge_verified_v2_guest_wallet_once');
  assert.equal(result.rpcCalls[0].args.p_apple_sub, 'apple');
  assert.equal(result.rpcCalls[0].args.p_session_token_hash, body.sessionToken);
});

test('legacy merge is closed unless the exact Apple/source pair is approved', async () => {
  const body = {
    sourceWalletId: 'legacy-wallet', identityToken: 'verified-apple-jwt',
    sessionToken: 'b'.repeat(64), idempotencyKey: 'legacy-merge-1',
  };
  const disabled = await invoke('merge_legacy', body, { appleEnabled: true });
  assert.equal(disabled.status, 409);
  assert.equal(disabled.rpcCalls.length, 0);

  const unrelated = await invoke('merge_legacy', body, {
    appleEnabled: true, legacyEnabled: true,
    legacyPairs: JSON.stringify({ apple: ['someone-elses-wallet'] }),
  });
  assert.equal(unrelated.status, 409);
  assert.equal(unrelated.rpcCalls.length, 0);

  const approved = await invoke('merge_legacy', body, {
    appleEnabled: true, legacyEnabled: true,
    legacyPairs: JSON.stringify({ apple: ['legacy-wallet'] }),
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.rpcCalls[0].name, 'merge_verified_legacy_wallet_once');
  assert.equal(approved.rpcCalls[0].args.p_source_wallet_id, 'legacy-wallet');
});
