import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = readFileSync(new URL('../functions/wallet_link_v2/index.ts', import.meta.url), 'utf8');
const runnable = stripTypeScriptTypes(source
  .replace(/^import \{ createClient \} from .*$/m, 'const createClient = globalThis.__createClient;')
  .replace(/^import \{ verifyAppleIdentityToken \} from .*$/m, 'const verifyAppleIdentityToken = globalThis.__verifyApple;')
  .replace(/^import \{[\s\S]*?\} from '\.\.?\/\_shared\/apple_subscription_status\.ts'$/m,
    'const { verifyAppleSubscriptionRecord, verifyAppleSubscriptionRecordDetailed } = globalThis.__appleSubscriptionStatus;')
  .replace(/^import \{ walletTokenHash \} from .*$/m, 'const walletTokenHash = globalThis.__walletTokenHash;')
  .replace(/^import \{ enrollBonusCanaryDevice, isBonusCanaryDevice \} from .*$/m,
    'const enrollBonusCanaryDevice = globalThis.__enrollDevice; const isBonusCanaryDevice = globalThis.__isCanaryDevice;')
  .replace(/^import \{[\s\S]*?\} from '\.\.?\/\_shared\/subscription_audit\.ts'$/m,
    'const { logSubscriptionAudit, subscriptionTransactionFingerprint, subscriptionWalletFingerprint } = globalThis.__subscriptionAudit;'));

async function invoke(action, extras = {}, options = {}) {
  let handler;
  const rpcCalls = [];
  const deviceCalls = [];
  const purchaseChecks = [];
  const failureLogs = [];
  const auditLogs = [];
  let appleVerified = false;
  const walletId = 'v2:11111111-1111-1111-1111-111111111111';
  globalThis.Deno = {
    env: { get: (key) => ({
      WALLET_SESSIONS_ENABLED: options.sessionsEnabled === false ? undefined : 'true',
      WALLET_GUEST_V2_ENABLED: options.guestEnabled === false ? undefined : 'true',
      WALLET_DEVICECHECK_BONUS_ENABLED: options.deviceCheckBonusEnabled ? 'true' : undefined,
      WALLET_BONUS_CANARY_ENABLED: options.canaryEnabled ? 'true' : undefined,
      WALLET_LINK_V2_ENABLED: options.appleEnabled ? 'true' : undefined,
      WALLET_LINK_V2_ALL_USERS_ENABLED: options.allUsersEnabled ? 'true' : undefined,
      WALLET_AUTO_MERGE_ALL_USERS_ENABLED: options.autoMergeEnabled ? 'true' : undefined,
      WALLET_LINK_V2_CANARY_APPLE_IDS: options.appleEnabled || options.canaryEnabled ? 'apple' : undefined,
      WALLET_LEGACY_MERGE_ENABLED: options.legacyEnabled ? 'true' : undefined,
      WALLET_LEGACY_MERGE_ALL_USERS_ENABLED: options.legacyAllUsersEnabled ? 'true' : undefined,
      WALLET_LEGACY_MERGE_CANARY_PAIRS: options.legacyPairs,
      SUPABASE_SERVICE_ROLE_KEY: options.serviceRoleKey,
    })[key] },
    serve: (callback) => { handler = callback; },
  };
  globalThis.__verifyApple = async () => {
    appleVerified = true;
    if (options.appleEnabled || options.canaryEnabled) return { sub: options.appleSubject ?? 'apple' };
    return null;
  };
  globalThis.__verifyActiveApplePurchase = async () => {
    throw new Error('Unexpected Apple subscription status lookup');
  };
  globalThis.__appleSubscriptionStatus = {
    verifyAppleSubscriptionRecord: async () => options.historicalPurchaseValid ?? false,
    verifyAppleSubscriptionRecordDetailed: async (...args) => {
      purchaseChecks.push(args);
      return options.historicalPurchaseValid
        ? { verified: true, environment: 'Sandbox', verificationMode: 'portable_signed_date' }
        : { verified: false, reason: 'subscription_not_found', environment: 'Production' };
    },
  };
  globalThis.__subscriptionAudit = {
    logSubscriptionAudit: () => {},
    subscriptionTransactionFingerprint: async () => 'transaction-fingerprint',
    subscriptionWalletFingerprint: async () => 'wallet-fingerprint',
  };
  globalThis.__walletTokenHash = async (value) => value;
  globalThis.__isCanaryDevice = async (token) => {
    deviceCalls.push({ action: 'query', token });
    if (options.queryFails) throw new Error('DeviceCheck query failed');
    return options.marked === true;
  };
  globalThis.__enrollDevice = async (token) => {
    deviceCalls.push({ action: 'enroll', token });
    if (options.enrollFails) throw new Error('DeviceCheck enrollment failed');
  };
  globalThis.__createClient = () => ({
    rpc: async (name, args) => {
      rpcCalls.push({ name, args });
        if (name === options.failRpc) {
          return { data: null, error: { code: 'P0001', message: 'Service role required' } };
        }
      if (name === 'register_guest_wallet_v2' && options.registrationFails) {
        return { data: null, error: { message: 'simulated registration failure' } };
      }
      if (name === 'reserve_guest_install_bonus') {
        return { data: options.reservation ?? 'pending', error: null };
      }
      if (name === 'acquire_guest_bonus_devicecheck_lock') {
        return { data: options.lockAvailable !== false, error: null };
      }
      if (name === 'confirm_guest_install_bonus_devicecheck') {
        return { data: true, error: null };
      }
      if (name === 'complete_guest_install_bonus_guarded') {
        return options.completeFails
          ? { data: null, error: { message: 'simulated completion failure' } }
          : { data: options.pendingClaim ?? true, error: null };
      }
      return { data: name === 'register_guest_wallet_v2' ? walletId
        : name === 'merge_verified_v2_guest_wallet_once' ? [{
          decision: 'merged', canonical_wallet_id: 'apple-wallet',
          free_credits_remaining: 500, paid_credits_remaining: 100,
        }] : name === 'merge_verified_legacy_wallet_once' ||
            name === 'merge_verified_legacy_wallet_v2_once' ? [{
          decision: 'merged', canonical_wallet_id: 'apple-wallet',
          free_credits_remaining: 500, paid_credits_remaining: 100,
          subscription_credits_remaining: 0,
        }] : true, error: null };
    },
    from: (table) => {
      const query = {
          eq: () => query,
          order: () => query,
          limit: () => query,
          lt: () => ({ limit: async () => ({ data: options.freeUsed ? [{ id: 1 }] : [], error: null }) }),
          maybeSingle: async () => ({ data: table === 'device_credits'
            ? { subscription_credits: options.sourceSubscriptionCredits ?? 0 }
            : table === 'device_subscriptions' ? options.sourcePurchase ?? null
            : table === 'guest_install_bonus_claims'
              ? options.claim ?? null
              : table === 'credit_wallet_aliases' ? options.alias ?? null
              : table === 'credit_protected_wallets' ? (options.activated ? { wallet_id: 'apple-wallet' } : null)
              : options.session ?? null, error: null }),
          single: async () => ({
            data: table === 'device_credits'
              ? { free_credits: options.balance ?? 500, paid_credits: 0, apple_user_id: null }
              : { state: 'pending' },
            error: null,
          }),
      };
      return { select: () => query };
    },
  });
  await import(`data:text/javascript,${encodeURIComponent(runnable)}#${crypto.randomUUID()}`);
  const originalError = console.error;
  const originalInfo = console.info;
  console.info = (line) => auditLogs.push(JSON.parse(line));
  console.error = (...args) => failureLogs.push(args.join(' '));
  try {
    const response = await handler(new Request('http://localhost/wallet_link_v2', {
      method: 'POST',
      body: JSON.stringify({ action, walletSecret: 'a'.repeat(64), walletId, ...extras }),
    }));
    return { status: response.status, body: await response.json(), rpcCalls, deviceCalls,
      appleVerified, purchaseChecks, failureLogs, auditLogs,
      auditId: response.headers.get('X-Wallet-Audit-ID'),
      diagnosticId: response.headers.get('X-Kingboard-Diagnostic-ID') };
  } finally {
    console.error = originalError;
    console.info = originalInfo;
  }
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
  assert.equal(generic.status, 503);
  assert.equal(generic.rpcCalls.length, 0);
});

test('canary registration requires the Apple identity even on a marked device', async () => {
  const denied = await invoke('register_canary', { deviceToken: 'a'.repeat(64) },
    { canaryEnabled: true, marked: true });
  assert.equal(denied.status, 404);
  assert.equal(denied.rpcCalls.length, 0);
});

test('marked canary uses normal guest registration and activation without enabling everyone', async () => {
  const settings = { canaryEnabled: true, sessionsEnabled: false,
    guestEnabled: false, marked: true, balance: 0 };
  const trial = await invoke('register_canary', {
    deviceToken: 'a'.repeat(64), identityToken: 'apple-token',
  }, settings);
  assert.equal(trial.status, 201);
  assert.equal(trial.rpcCalls[0].args.p_initial_bonus, 0);
  const registered = await invoke('register', { deviceToken: 'a'.repeat(64) }, settings);
  assert.equal(registered.status, 201);
  assert.equal(registered.rpcCalls[0].args.p_initial_bonus, 0);
  const activated = await invoke('activate', {}, settings);
  assert.equal(activated.status, 200);
  assert.equal(activated.rpcCalls[0].name, 'activate_guest_wallet_v2');
  const deniedLogin = await invoke('sign_in', { identityToken: 'apple-token' }, settings);
  assert.equal(deniedLogin.status, 404);
  assert.equal(deniedLogin.rpcCalls.length, 0);
  const deniedLogout = await invoke('register_after_logout', {
    sessionToken: 'b'.repeat(64),
  }, { ...settings, session: { apple_sub: 'other-apple', revoked_at: null,
    expires_at: new Date(Date.now() + 60_000).toISOString() } });
  assert.equal(deniedLogout.status, 404);
  assert.equal(deniedLogout.rpcCalls.length, 0);
  const unmarked = await invoke('register', { deviceToken: 'a'.repeat(64) }, {
    ...settings, marked: false,
  });
  assert.equal(unmarked.status, 404);
  assert.equal(unmarked.rpcCalls.length, 0);
});

test('service-role guard failures log only action, RPC stage, and key classification', async () => {
  const result = await invoke('register', { deviceToken: 'a'.repeat(64) }, {
    deviceCheckBonusEnabled: true,
    failRpc: 'acquire_guest_bonus_devicecheck_lock',
    serviceRoleKey: 'test-only-not-a-jwt',
  });
  assert.equal(result.status, 500);
  assert.equal(result.body.diagnostic_id, result.auditId);
  assert.equal(result.diagnosticId, result.auditId);
  assert.equal(result.body.failure_stage, 'rpc_acquire_guest_bonus_devicecheck_lock');
  assert.equal(result.failureLogs.length, 1);
  const diagnostic = JSON.parse(result.failureLogs[0]);
  assert.equal(diagnostic.auditId, result.auditId);
  assert.equal(diagnostic.walletFingerprints.length, 1);
  assert.match(diagnostic.walletFingerprints[0], /^[a-f0-9]{64}$/);
  delete diagnostic.auditId;
  delete diagnostic.walletFingerprints;
  assert.deepEqual(diagnostic, {
    event: 'wallet_link_v2_failure',
    action: 'register',
    stage: 'rpc_acquire_guest_bonus_devicecheck_lock',
    sqlstate: 'P0001',
    reason: 'service_role_required',
    serviceRoleKeyKind: 'not_jwt',
  });
  assert.equal(result.failureLogs[0].includes('v2:'), false);
  assert.equal(result.failureLogs[0].includes('a'.repeat(64)), false);
});

test('audit joins failed registration to retry without logging wallet or credentials', async () => {
  const failed = await invoke('register', { deviceToken: 'private-device-token' }, {
    deviceCheckBonusEnabled: true, failRpc: 'acquire_guest_bonus_devicecheck_lock',
  });
  const retry = await invoke('register', { deviceToken: 'private-device-token' }, {
    deviceCheckBonusEnabled: true,
  });
  assert.notEqual(failed.auditId, retry.auditId);
  const failure = JSON.parse(failed.failureLogs[0]);
  const success = retry.auditLogs.find(x => x.event === 'response');
  assert.deepEqual(failure.walletFingerprints, success.walletFingerprints);
  assert.equal(success.status, 201);
  assert.equal(retry.auditLogs.find(x => x.event === 'rpc_completed' && x.stage === 'rpc_complete_guest_install_bonus_guarded').applied, true);
  const serialized = JSON.stringify([...failed.auditLogs, ...retry.auditLogs, failure]);
  for (const secret of ['private-device-token', 'v2:11111111-1111-1111-1111-111111111111', 'a'.repeat(64)]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('handled merge rejection retains hashed ledger key and retry correlation', async () => {
  const args = { identityToken: 'private-apple-token', sessionToken: 'b'.repeat(64), idempotencyKey: 'ledger-operation-123' };
  const rejected = await invoke('merge_guest', args, { appleEnabled: true, failRpc: 'merge_verified_v2_guest_wallet_once' });
  const retry = await invoke('merge_guest', args, { appleEnabled: true });
  assert.equal(rejected.status, 409);
  assert.equal(retry.status, 200);
  const end = rejected.auditLogs.find(x => x.event === 'rpc_completed');
  assert.equal(end.outcome, 'rejected');
  assert.equal(end.operationFingerprint, retry.auditLogs.find(x => x.event === 'rpc_completed').operationFingerprint);
  assert.match(end.operationFingerprint, /^[a-f0-9]{64}$/);
  for (const raw of Object.values(args)) assert.equal(JSON.stringify(rejected.auditLogs).includes(raw), false);
});

test('a missing DeviceCheck proof blocks canary registration, but an outage creates zero-credit wallet', async () => {
  const settings = { canaryEnabled: true, sessionsEnabled: false, guestEnabled: false };
  const missing = await invoke('register', {}, settings);
  assert.equal(missing.status, 404);
  assert.equal(missing.rpcCalls.length, 0);

  const failed = await invoke('register', { deviceToken: 'a'.repeat(64) }, {
    ...settings, queryFails: true, balance: 0,
  });
  assert.equal(failed.status, 201);
  assert.equal(failed.body.freeCredits, 0);
  assert.deepEqual(failed.rpcCalls.map((call) => call.name), ['register_guest_wallet_v2']);
  assert.equal(failed.rpcCalls[0].args.p_initial_bonus, 0);
});

test('new guest registers for 500 without Apple authentication', async () => {
  const result = await invoke('register', { deviceToken: 'a'.repeat(64) }, {
    deviceCheckBonusEnabled: true,
  });
  assert.equal(result.status, 201);
  assert.equal(result.body.freeCredits, 500);
  assert.deepEqual(result.rpcCalls.map((call) => call.name), [
    'register_guest_wallet_v2', 'acquire_guest_bonus_devicecheck_lock',
    'reserve_guest_install_bonus', 'confirm_guest_install_bonus_devicecheck',
    'complete_guest_install_bonus_guarded', 'release_guest_bonus_devicecheck_lock',
  ]);
  assert.equal(result.rpcCalls[0].args.p_initial_bonus, 0);
  assert.equal(result.appleVerified, false);
});

test('DeviceCheck blocks a repeat install bonus when enabled', async () => {
  const token = 'a'.repeat(64);
  const repeated = await invoke('register', { deviceToken: token }, {
    deviceCheckBonusEnabled: true, marked: true, balance: 0,
  });
  assert.equal(repeated.status, 201);
  assert.equal(repeated.rpcCalls[0].args.p_initial_bonus, 0);
  assert.deepEqual(repeated.rpcCalls.map((call) => call.name), [
    'register_guest_wallet_v2', 'acquire_guest_bonus_devicecheck_lock',
    'complete_guest_install_bonus_guarded', 'release_guest_bonus_devicecheck_lock',
  ]);
  assert.deepEqual(repeated.deviceCalls, [{ action: 'query', token }]);

  const first = await invoke('register', { deviceToken: token }, {
    deviceCheckBonusEnabled: true, balance: 500,
  });
  assert.equal(first.status, 201);
  assert.equal(first.rpcCalls[0].args.p_initial_bonus, 0);
  assert.deepEqual(first.deviceCalls, [
    { action: 'query', token }, { action: 'enroll', token },
  ]);
});

test('missing DeviceCheck token opens a zero-credit guest for later verification', async () => {
  const result = await invoke('register', {}, {
    deviceCheckBonusEnabled: true, balance: 0,
  });
  assert.equal(result.status, 201);
  assert.equal(result.body.freeCredits, 0);
  assert.equal(result.body.bonusStatus, 'verification_pending');
  assert.deepEqual(result.rpcCalls.map((call) => call.name), ['register_guest_wallet_v2']);
  assert.equal(result.rpcCalls[0].args.p_initial_bonus, 0);
});

test('a failed DeviceCheck enrollment leaves a zero-credit wallet to retry', async () => {
  const result = await invoke('register', { deviceToken: 'a'.repeat(64) }, {
    deviceCheckBonusEnabled: true, enrollFails: true, balance: 0,
  });
  assert.equal(result.status, 201);
  assert.equal(result.body.freeCredits, 0);
  assert.equal(result.body.bonusStatus, 'verification_pending');
  assert.deepEqual(result.rpcCalls.map((call) => call.name), [
    'register_guest_wallet_v2', 'acquire_guest_bonus_devicecheck_lock',
    'reserve_guest_install_bonus', 'release_guest_bonus_devicecheck_lock',
  ]);
});

test('registration failure cannot mark the device as granted', async () => {
  const token = 'a'.repeat(64);
  const first = await invoke('register', { deviceToken: token }, {
    deviceCheckBonusEnabled: true, registrationFails: true,
  });
  assert.equal(first.status, 500);
  assert.deepEqual(first.deviceCalls, []);
});

test('a completion failure after DeviceCheck enrollment retries the pending claim', async () => {
  const token = 'a'.repeat(64);
  const first = await invoke('register', { deviceToken: token }, {
    deviceCheckBonusEnabled: true, completeFails: true,
  });
  assert.equal(first.status, 500);
  assert.deepEqual(first.deviceCalls, [
    { action: 'query', token }, { action: 'enroll', token },
  ]);
  assert.equal(first.rpcCalls.at(-1).name, 'release_guest_bonus_devicecheck_lock');
  const retry = await invoke('register', { deviceToken: token }, {
    deviceCheckBonusEnabled: true, marked: true, pendingClaim: true,
    balance: 500,
  });
  assert.equal(retry.status, 201);
  assert.equal(retry.rpcCalls[0].args.p_initial_bonus, 0);
  assert.equal(retry.rpcCalls[2].name, 'complete_guest_install_bonus_guarded');
  assert.equal(retry.body.freeCredits, 500);
});

test('live lock contention retries then returns 503 without an unverified grant', async () => {
  const token = 'a'.repeat(64);
  const busy = await invoke('register', { deviceToken: token }, {
    deviceCheckBonusEnabled: true, lockAvailable: false,
  });
  assert.equal(busy.status, 503);
  assert.equal(busy.body.error, 'Device verification is busy.');
  assert.ok(busy.rpcCalls.filter(call => call.name === 'acquire_guest_bonus_devicecheck_lock').length > 1);
  assert.deepEqual(busy.deviceCalls, []);
  assert.equal(busy.rpcCalls.at(-1).name, 'acquire_guest_bonus_devicecheck_lock');
  assert.equal(busy.rpcCalls.some((call) => call.name === 'complete_guest_install_bonus_guarded'), false);

  const first = await invoke('register', { deviceToken: token }, {
    deviceCheckBonusEnabled: true, balance: 500,
  });
  assert.equal(first.body.freeCredits, 500);
  const second = await invoke('register', { deviceToken: token }, {
    deviceCheckBonusEnabled: true, marked: true, balance: 0,
  });
  assert.equal(second.body.freeCredits, 0);
  assert.equal(second.deviceCalls.some((call) => call.action === 'enroll'), false);
});

test('an unconfirmed old claim cannot be paid merely because DeviceCheck is marked', async () => {
  const result = await invoke('register', { deviceToken: 'a'.repeat(64) }, {
    deviceCheckBonusEnabled: true, marked: true, balance: 0,
    claim: { state: 'pending', verification_confirmed_at: null },
  });
  assert.equal(result.status, 201);
  assert.equal(result.body.bonusStatus, 'needs_review');
  assert.equal(result.body.freeCredits, 0);
  assert.equal(result.rpcCalls.some((call) => call.name === 'complete_guest_install_bonus_guarded'), false);
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

test('general Apple access stays closed until guest logout is enabled too', async () => {
  const account = { appleEnabled: true, appleSubject: 'another-apple' };
  for (const settings of [
    account,
    { ...account, allUsersEnabled: true, guestEnabled: false },
    { ...account, allUsersEnabled: true, sessionsEnabled: false },
  ]) {
    const result = await invoke('sign_in', { identityToken: 'apple-token' }, settings);
    assert.equal(result.status, 404);
    assert.equal(result.rpcCalls.length, 0);
  }
});

test('automatic link availability opens only with every rollout guard', async () => {
  const ready = {
    appleEnabled: true, allUsersEnabled: true,
    autoMergeEnabled: true, legacyEnabled: true,
  };
  const disabled = await invoke('availability', {}, { ...ready, legacyEnabled: false });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body.enabled, false);
  const enabled = await invoke('availability', {}, ready);
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.enabled, true);
  assert.equal(enabled.rpcCalls.length, 0);
  assert.equal(enabled.appleVerified, false);
});

test('an allowlisted canary can log out with zero credits while guest rollout is off', async () => {
  const settings = {
    canaryEnabled: true, appleEnabled: true, guestEnabled: false,
    balance: 0,
    session: { apple_sub: 'apple', revoked_at: null,
      expires_at: new Date(Date.now() + 60_000).toISOString() },
  };
  const result = await invoke('register_after_logout', {
    sessionToken: 'b'.repeat(64),
  }, settings);
  assert.equal(result.status, 201);
  assert.equal(result.body.freeCredits, 0);
  assert.equal(result.rpcCalls[0].args.p_initial_bonus, 0);

  const revoked = await invoke('register_after_logout', {
    sessionToken: 'b'.repeat(64),
  }, { ...settings, session: { ...settings.session, revoked_at: new Date().toISOString() } });
  assert.equal(revoked.status, 401);
  assert.equal(revoked.rpcCalls.length, 0);
});

test('general Apple login, zero-credit logout, and re-login use the same guarded path', async () => {
  const settings = {
    appleEnabled: true, allUsersEnabled: true, appleSubject: 'another-apple',
    session: { apple_sub: 'another-apple', revoked_at: null,
      expires_at: new Date(Date.now() + 60_000).toISOString() },
    balance: 0,
  };
  const firstLogin = await invoke('sign_in', { identityToken: 'apple-token' }, settings);
  assert.equal(firstLogin.status, 200);
  assert.equal(firstLogin.rpcCalls[0].name, 'issue_apple_wallet_session');
  assert.equal(firstLogin.rpcCalls[0].args.p_apple_sub, 'another-apple');

  const logout = await invoke('register_after_logout', {
    sessionToken: 'b'.repeat(64),
  }, settings);
  assert.equal(logout.status, 201);
  assert.equal(logout.body.freeCredits, 0);
  assert.equal(logout.body.paidCredits, 0);
  assert.equal(logout.rpcCalls[0].args.p_initial_bonus, 0);

  const activation = await invoke('activate', {}, settings);
  assert.equal(activation.status, 200);
  const revocation = await invoke('revoke_session', {
    sessionToken: 'b'.repeat(64),
  }, settings);
  assert.equal(revocation.status, 200);
  assert.equal(revocation.rpcCalls[0].name, 'revoke_apple_wallet_session');
  const secondLogin = await invoke('sign_in', { identityToken: 'apple-token' }, settings);
  assert.equal(secondLogin.status, 200);
});

test('expired Apple session cannot register a logout wallet or receive credits', async () => {
  const result = await invoke('register_after_logout', {
    sessionToken: 'b'.repeat(64),
  }, {
    appleEnabled: true, allUsersEnabled: true,
    session: { apple_sub: 'another-apple', revoked_at: null,
      expires_at: new Date(Date.now() - 60_000).toISOString() },
  });
  assert.equal(result.status, 401);
  assert.equal(result.rpcCalls.length, 0);
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
  assert.equal(approved.rpcCalls[0].name, 'merge_verified_legacy_wallet_v2_once');
  assert.equal(approved.rpcCalls[0].args.p_source_wallet_id, 'legacy-wallet');
});

test('all-user rollout flags never authorize another unproven legacy wallet', async () => {
  const body = {
    sourceWalletId: 'legacy-wallet', identityToken: 'verified-apple-jwt',
    sessionToken: 'b'.repeat(64), idempotencyKey: 'legacy-merge-1',
  };
  const legacyOnly = await invoke('merge_legacy', body, {
    appleEnabled: true, legacyEnabled: true, legacyAllUsersEnabled: true,
  });
  assert.equal(legacyOnly.status, 409);
  assert.equal(legacyOnly.rpcCalls.length, 0);

  const allUsers = await invoke('merge_legacy', body, {
    appleEnabled: true, allUsersEnabled: true, legacyEnabled: true,
    legacyAllUsersEnabled: true, autoMergeEnabled: true, appleSubject: 'another-apple',
  });
  assert.equal(allUsers.status, 409);
  assert.equal(allUsers.rpcCalls.length, 0);
});

test('verified Apple subject wallet migrates without a canary pair only after rollout', async () => {
  const body = {
    sourceWalletId: 'ordinary-apple', identityToken: 'verified-apple-jwt',
    sessionToken: 'b'.repeat(64), idempotencyKey: 'legacy-merge:ordinary-apple',
  };
  const ready = { appleEnabled: true, allUsersEnabled: true, autoMergeEnabled: true,
    legacyEnabled: true, appleSubject: 'ordinary-apple', activated: true,
    session: { wallet_id: 'apple-wallet', apple_sub: 'ordinary-apple', expires_at: new Date(Date.now() + 60000).toISOString(), revoked_at: null } };
  for (const override of [{}, { autoMergeEnabled: false }, { legacyEnabled: false },
    { allUsersEnabled: false }, { sessionsEnabled: false }, { guestEnabled: false }]) {
    const result = await invoke('merge_legacy', body, { ...ready, ...override });
    if (Object.keys(override).length) {
      assert.notEqual(result.status, 200);
      assert.equal(result.rpcCalls.length, 0);
    } else {
      assert.equal(result.status, 200);
      assert.equal(result.appleVerified, true);
      assert.equal(result.rpcCalls.length, 1);
      assert.equal(result.rpcCalls[0].name, 'merge_verified_legacy_wallet_v2_once');
      assert.equal(result.rpcCalls[0].args.p_apple_sub, body.sourceWalletId);
      assert.equal(result.rpcCalls[0].args.p_session_token_hash, body.sessionToken);
    }
  }
});

test('own Apple wallet still requires purchase verification before moving subscription credits', async () => {
  const result = await invoke('merge_legacy', {
    sourceWalletId: 'ordinary-apple', identityToken: 'verified-apple-jwt',
    sessionToken: 'b'.repeat(64), idempotencyKey: 'legacy-merge:ordinary-apple',
  }, { appleEnabled: true, allUsersEnabled: true, autoMergeEnabled: true,
    legacyEnabled: true, appleSubject: 'ordinary-apple', sourceSubscriptionCredits: 4000, activated: true,
    session: { wallet_id: 'apple-wallet', apple_sub: 'ordinary-apple', expires_at: new Date(Date.now() + 60000).toISOString(), revoked_at: null } });
  assert.equal(result.status, 409);
  assert.equal(result.rpcCalls.length, 0);
});

test('ordinary Apple wallet uses the tested portable verifier and rejects invalid purchases', async () => {
  for (const historicalPurchaseValid of [false, true]) {
    const result = await invoke('merge_legacy', {
      sourceWalletId: 'ordinary-apple', identityToken: 'verified-apple-jwt',
      sessionToken: 'b'.repeat(64), idempotencyKey: 'legacy-merge:ordinary-apple',
    }, { appleEnabled: true, allUsersEnabled: true, autoMergeEnabled: true,
      legacyEnabled: true, appleSubject: 'ordinary-apple', sourceSubscriptionCredits: 4000, activated: true,
      session: { wallet_id: 'apple-wallet', apple_sub: 'ordinary-apple', expires_at: new Date(Date.now() + 60000).toISOString(), revoked_at: null },
      historicalPurchaseValid,
      sourcePurchase: { purchase_token: '12345', product_id: 'com.kingboard.monthly_basic' } });
    assert.equal(result.status, historicalPurchaseValid ? 200 : 409);
    assert.equal(result.rpcCalls.length, historicalPurchaseValid ? 1 : 0);
    assert.deepEqual(result.purchaseChecks, [
      ['12345', 'com.kingboard.monthly_basic', 'com.kingboard.app', false, true, true],
    ]);
    if (historicalPurchaseValid) {
      assert.equal(result.rpcCalls[0].args.p_verified_subscription_token, '12345');
    }
  }
});

