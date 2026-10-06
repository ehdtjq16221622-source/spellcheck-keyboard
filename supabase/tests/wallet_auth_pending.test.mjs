import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = readFileSync(new URL('../functions/_shared/wallet_auth.ts', import.meta.url), 'utf8');
const runnable = stripTypeScriptTypes(source.replace(
  /^import type \{ SupabaseClient \} from .*$/m,
  '',
));
const auth = await import(`data:text/javascript,${encodeURIComponent(runnable)}#${crypto.randomUUID()}`);

function mockSupabase(credential) {
  return {
    from: (table) => {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({
          data: table === 'wallet_v2_credentials'
            ? credential
            : table === 'device_credits' ? { apple_user_id: null } : null,
          error: null,
        }),
      };
      return query;
    },
  };
}

async function resolveWithSecret(secret, credentialState) {
  globalThis.Deno = { env: { get: (key) => key === 'WALLET_SESSIONS_ENABLED' ? 'true' : undefined } };
  const secretHash = await auth.walletTokenHash('a'.repeat(64));
  const req = new Request('http://localhost', {
    headers: { Authorization: `Bearer ${secret}` },
  });
  return auth.resolveCreditWallet(req, mockSupabase({
    secret_hash: secretHash,
    state: credentialState,
  }), 'v2:synthetic-wallet');
}

test('valid possession proof distinguishes pending activation without granting access', async () => {
  await assert.rejects(
    resolveWithSecret('a'.repeat(64), 'pending'),
    (error) => error.code === 'wallet_activation_pending' && error.status === 401,
  );
});

test('wrong possession proof does not reveal that the wallet is pending', async () => {
  await assert.rejects(
    resolveWithSecret('b'.repeat(64), 'pending'),
    (error) => error.code !== 'wallet_activation_pending' && error.status === 401,
  );
});

test('active guest wallet still resolves with its valid possession proof', async () => {
  const result = await resolveWithSecret('a'.repeat(64), 'active');
  assert.deepEqual(result, { walletId: 'v2:synthetic-wallet', authenticated: true });
});
