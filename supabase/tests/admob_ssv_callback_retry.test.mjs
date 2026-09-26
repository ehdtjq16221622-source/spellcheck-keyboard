import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = readFileSync(new URL('../functions/admob_ssv_callback/index.ts', import.meta.url), 'utf8');
const runnable = stripTypeScriptTypes(source
  .replace(/^import \{ createClient \} from .*$/m, 'const createClient = globalThis.__createClient;')
  .replace(/^import \{ verifyAdMobCallback \} from .*$/m,
    'const verifyAdMobCallback = globalThis.__verifyAdMobCallback;'));

async function callback({ priorGrant = null, sessionsEnabled = false, createdAt = null } = {}) {
  let handler;
  let grant;
  globalThis.Deno = {
    env: { get: (key) => ({
      SUPABASE_URL: 'https://example.invalid',
      SUPABASE_SERVICE_ROLE_KEY: 'test',
      WALLET_SESSIONS_ENABLED: sessionsEnabled ? 'true' : undefined,
    })[key] },
    serve: (value) => { handler = value; },
  };
  globalThis.__verifyAdMobCallback = async () => ({
    valid: true, customData: 'legacy-device', transactionId: 'ad-123',
    adUnit: 'test-unit', rewardAmount: 1,
  });
  globalThis.__createClient = () => ({
    from(table) {
      return {
        select() {
          return {
            eq() {
              return {
                eq() {
                  return { maybeSingle: async () => ({ data: priorGrant, error: null }) };
                },
                maybeSingle: async () => ({
                  data: table === 'device_credits'
                    ? (createdAt ? { created_at: createdAt } : null)
                    : { canonical_wallet_id: 'apple-wallet' },
                  error: null,
                }),
              };
            },
          };
        },
      };
    },
    rpc: async (name, args) => {
      assert.equal(name, 'grant_ad_credits_once');
      grant = args;
      return { error: null };
    },
  });
  await import(`data:text/javascript,${encodeURIComponent(runnable)}#${crypto.randomUUID()}`);
  const response = await handler(new Request('https://example.invalid/admob_ssv_callback'));
  return { response, grant };
}

test('a retry keeps the original wallet and 200-credit amount after linking', async () => {
  for (const sessionsEnabled of [false, true]) {
    const result = await callback({
      sessionsEnabled,
      priorGrant: { device_id: 'legacy-device', paid_delta: 200 },
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.grant.p_device_id, 'legacy-device');
    assert.equal(result.grant.p_amount, 200);
  }
});

test('a new callback uses the linked wallet but original install date for reward tier', async () => {
  const result = await callback({
    sessionsEnabled: true,
    createdAt: '2026-09-19T14:59:00.000Z',
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.grant.p_device_id, 'apple-wallet');
  assert.equal(result.grant.p_amount, 200);
});
