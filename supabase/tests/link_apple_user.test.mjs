import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = readFileSync(new URL('../functions/link_apple_user/index.ts', import.meta.url), 'utf8');
const runnable = stripTypeScriptTypes(source
  .replace(/^import \{ createClient \} from .*$/m, 'const createClient = globalThis.__createClient;')
  .replace(/^import \{ verifyAppleIdentityToken \} from .*$/m, 'const verifyAppleIdentityToken = globalThis.__verifyApple;')
  .replace(/^import \{ requiresWalletSession \} from .*$/m, 'const requiresWalletSession = globalThis.__requiresWalletSession;'));

async function invoke({ linked = null, current = null, currentError = null, subject = 'apple', deviceId = 'device', protectedIds = [], protectionError = false, claimDecision = 'linked' } = {}) {
  let handler;
  const writes = [];
  globalThis.Deno = {
    env: { get: () => 'mock-secret' },
    serve: (callback) => { handler = callback; },
  };
  globalThis.__verifyApple = async () => ({ sub: subject });
  globalThis.__requiresWalletSession = async (_, id) => {
    if (protectionError) throw new Error('Protection lookup unavailable');
    return protectedIds.includes(id);
  };
  globalThis.__createClient = () => ({
    rpc: (name, args) => {
      writes.push({ kind: 'claim', name, args });
      return { single: async () => ({ data: { decision: claimDecision, free_credits: current?.free_credits ?? 0, paid_credits: current?.paid_credits ?? 0, subscription_credits: current?.subscription_credits ?? 0 }, error: null }) };
    },
    from: (table) => {
      assert.equal(table, 'device_credits');
      return {
        select: () => ({
          eq: (field, value) => ({
            maybeSingle: async () => ({
              data: field === 'apple_user_id' && value === subject ? linked : current,
              error: field === 'device_id' ? currentError : null,
            }),
          }),
        }),
        update: (value) => ({
          eq: async (field, id) => { writes.push({ kind: 'update', value, field, id }); return { error: null }; },
        }),
        delete: () => ({
          eq: async (field, id) => { writes.push({ kind: 'delete', field, id }); return { error: null }; },
        }),
        insert: async (value) => { writes.push({ kind: 'insert', value }); return { error: null }; },
      };
    },
  });
  await import(`data:text/javascript,${encodeURIComponent(runnable)}#${crypto.randomUUID()}`);
  const result = await handler(new Request('http://localhost/link_apple_user', {
    method: 'POST',
    body: JSON.stringify({ deviceId, appleUserId: subject, identityToken: 'mock-token' }),
  }));
  return { status: result.status, body: await result.json(), writes };
}

test('Apple login cannot create a wallet or claim the install bonus', async () => {
  const result = await invoke();
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'WALLET_REGISTRATION_REQUIRED');
  assert.match(result.body.error, /최신 버전으로 업데이트/);
  assert.deepEqual(result.writes, []);
});

test('verified Apple can read its separate legacy row without transferring or exposing V2 credits', async () => {
  const result = await invoke({ deviceId: 'apple', linked: {
    device_id: 'v2:canonical', free_credits: 0, paid_credits: 60, subscription_credits: 790,
  }, current: {
    device_id: 'apple', apple_user_id: null, free_credits: 130, paid_credits: 0, subscription_credits: 4000,
  } });
  assert.equal(result.status, 200);
  assert.equal(result.body.credits_remaining, 4130);
  assert.equal(result.body.canonical_device_id, 'apple');
  assert.equal(result.body.migrated, false);
  assert.deepEqual(result.writes, []);
});

test('a failed device wallet lookup never creates a replacement wallet', async () => {
  const result = await invoke({ currentError: { message: 'lookup unavailable' } });
  assert.equal(result.status, 500);
  assert.deepEqual(result.writes, []);
});

for (const [decision, status, code] of [
  ['linked', 200, undefined], ['already_linked', 200, undefined],
  ['other_owner', 409, 'WALLET_OWNERSHIP_CONFLICT'],
  ['missing', 409, 'WALLET_REGISTRATION_REQUIRED'],
  ['protected', 409, 'WALLET_UPDATE_REQUIRED'],
  ['apple_existing', 409, 'WALLET_UPDATE_REQUIRED'],
]) {
  test(`legacy one-time claim handles ${decision} without direct balance writes`, async () => {
    const result = await invoke({ current: { device_id: 'device', apple_user_id: null,
      free_credits: 350, paid_credits: 20, subscription_credits: 100 }, claimDecision: decision });
    assert.equal(result.status, status);
    assert.equal(result.body.code, code);
    assert.deepEqual(result.writes.map(w => w.kind), ['claim']);
    assert.equal(result.writes[0].name, 'claim_unprotected_legacy_apple_wallet');
    if (status === 200) {
      assert.equal(result.body.credits_remaining, 470);
      assert.equal(result.body.granted_install_bonus, false);
    }
  });
}

test('linked wallet on this device is not deleted or moved', async () => {
  const result = await invoke({ linked: {
    device_id: 'device', free_credits: 20, paid_credits: 10, subscription_credits: 30,
  } });
  assert.equal(result.status, 200);
  assert.equal(result.body.canonical_device_id, 'device');
  assert.equal(result.body.credits_remaining, 60);
  assert.deepEqual(result.writes, []);
});

test('subscription credits are included in the returned usable balance without changing wallet amounts', async () => {
  const result = await invoke({ linked: {
    device_id: 'device', free_credits: 100, paid_credits: 50, subscription_credits: 400,
  } });
  assert.equal(result.status, 200);
  assert.equal(result.body.free_credits_remaining, 100);
  assert.equal(result.body.paid_credits_remaining, 450);
  assert.equal(result.body.credits_remaining, 550);
  assert.deepEqual(result.writes, []);
});

test('a different Apple account cannot take an already-linked device wallet', async () => {
  const result = await invoke({ current: {
    device_id: 'device', apple_user_id: 'another-apple-user',
    free_credits: 120, paid_credits: 40, subscription_credits: 200,
  } });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'WALLET_OWNERSHIP_CONFLICT');
  assert.deepEqual(result.writes, []);
});

test('upgraded account blocks legacy linking for both canonical and alternate request IDs', async () => {
  for (const deviceId of ['apple', 'old-device', 'new-device']) {
    const result = await invoke({ deviceId, protectedIds: ['apple'] });
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'WALLET_UPDATE_REQUIRED');
    assert.deepEqual(result.writes, []);
  }
});

test('protection lookup failure never falls through to a wallet write', async () => {
  const result = await invoke({ protectionError: true });
  assert.equal(result.status, 500);
  assert.deepEqual(result.writes, []);
});

test('a link appearing between reads is returned without writing ownership again', async () => {
  const result = await invoke({ current: { device_id: 'device', apple_user_id: 'apple',
    free_credits: 40, paid_credits: 20, subscription_credits: 30 } });
  assert.equal(result.status, 200);
  assert.equal(result.body.credits_remaining, 90);
  assert.deepEqual(result.writes, []);
});
