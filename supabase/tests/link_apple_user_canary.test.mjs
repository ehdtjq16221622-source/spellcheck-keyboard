import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = readFileSync(new URL('../functions/link_apple_user_canary/index.ts', import.meta.url), 'utf8');
const runnable = stripTypeScriptTypes(source
  .replace(/^import \{ createClient \} from .*$/m, 'const createClient = globalThis.__createClient;')
  .replace(/^import \{ verifyAppleIdentityToken \} from .*$/m, 'const verifyAppleIdentityToken = globalThis.__verifyApple;'));
const owner = '000746.03654e929ba94917a878e09aec00402c.1144';

async function invoke({ subject = owner, rows = [], tokenValid = true, appleUserId = subject, method = 'POST', guestWalletId, existingGuestRow } = {}) {
  let handler;
  const reads = [];
  const writes = [];
  let guestRow = existingGuestRow;
  globalThis.Deno = {
    env: { get: () => 'mock-secret' },
    serve: (callback) => { handler = callback; },
  };
  globalThis.__verifyApple = async () => tokenValid ? { sub: subject } : null;
  globalThis.__createClient = () => ({
    from: (table) => {
      assert.equal(table, 'device_credits');
      return {
        select: (columns) => {
          reads.push(columns);
          return {
            eq: (column, value) => {
              if (column === 'apple_user_id') {
                assert.equal(value, owner);
                return { limit: async (count) => {
                  assert.equal(count, 2);
                  return { data: rows.slice(0, count), error: null };
                } };
              }
              assert.equal(column, 'device_id');
              assert.equal(value, guestWalletId);
              return { single: async () => ({ data: guestRow, error: null }) };
            },
          };
        },
        upsert: async (row, options) => {
          writes.push(['upsert', row, options]);
          if (!guestRow) guestRow = { ...row, apple_user_id: null };
          return { error: null };
        },
        insert: (...args) => { writes.push(['insert', ...args]); throw new Error('write not allowed'); },
        update: (...args) => { writes.push(['update', ...args]); throw new Error('write not allowed'); },
        delete: (...args) => { writes.push(['delete', ...args]); throw new Error('write not allowed'); },
      };
    },
  });
  await import(`data:text/javascript,${encodeURIComponent(runnable)}#${crypto.randomUUID()}`);
  const response = await handler(new Request('http://localhost/link_apple_user_canary', {
    method,
    ...(method === 'POST' ? { body: JSON.stringify({ appleUserId, identityToken: 'mock-token', guestWalletId }) } : {}),
  }));
  return { status: response.status, body: await response.json(), reads, writes };
}

test('owner receives the existing canonical wallet, including subscription credits, without a write', async () => {
  const result = await invoke({ rows: [{
    device_id: 'apple-wallet', free_credits: 0, paid_credits: 200, subscription_credits: 8960,
  }] });
  assert.equal(result.status, 200);
  assert.equal(result.body.canonical_device_id, 'apple-wallet');
  assert.equal(result.body.paid_credits_remaining, 9160);
  assert.equal(result.body.granted_install_bonus, false);
  assert.deepEqual(result.writes, []);
});

test('owner can prepare a zero-credit logout wallet without changing the Apple wallet', async () => {
  const guestWalletId = 'canary-guest:12345678-1234-1234-1234-123456789abc';
  const result = await invoke({
    rows: [{ device_id: owner, free_credits: 120, paid_credits: 80, subscription_credits: 0 }],
    guestWalletId,
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.credits_remaining, 200);
  assert.equal(result.body.logout_guest_wallet_id, guestWalletId);
  assert.equal(result.body.logout_guest_free_credits, 0);
  assert.equal(result.body.logout_guest_paid_credits, 0);
  assert.equal(result.writes.length, 1);
  assert.equal(result.writes[0][1].free_credits, 0);
  assert.equal(result.writes[0][2].ignoreDuplicates, true);
});

test('invalid guest wallet ID cannot create a row', async () => {
  const result = await invoke({
    rows: [{ device_id: owner, free_credits: 120, paid_credits: 80, subscription_credits: 0 }],
    guestWalletId: 'canary-guest:other',
  });
  assert.equal(result.status, 400);
  assert.deepEqual(result.writes, []);
});

test('preparing an existing logout wallet preserves credits already earned there', async () => {
  const guestWalletId = 'canary-guest:12345678-1234-1234-1234-123456789abc';
  const result = await invoke({
    rows: [{ device_id: owner, free_credits: 120, paid_credits: 80, subscription_credits: 0 }],
    guestWalletId,
    existingGuestRow: {
      device_id: guestWalletId, apple_user_id: null,
      free_credits: 30, paid_credits: 20, subscription_credits: 0,
    },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.logout_guest_free_credits, 30);
  assert.equal(result.body.logout_guest_paid_credits, 20);
});

test('non-owner and invalid tokens never query a wallet', async () => {
  for (const options of [{ subject: 'other' }, { tokenValid: false }, { appleUserId: 'other' }]) {
    const result = await invoke(options);
    assert.equal(result.status, 404);
    assert.deepEqual(result.reads, []);
    assert.deepEqual(result.writes, []);
  }
});

test('missing or ambiguous wallet fails closed without granting or moving credits', async () => {
  for (const rows of [[], [{ device_id: 'one' }, { device_id: 'two' }]]) {
    const result = await invoke({ rows });
    assert.equal(result.status, 409);
    assert.deepEqual(result.writes, []);
  }
});

test('other HTTP methods are rejected before Apple verification or database access', async () => {
  const result = await invoke({ method: 'GET' });
  assert.equal(result.status, 404);
  assert.deepEqual(result.reads, []);
});
