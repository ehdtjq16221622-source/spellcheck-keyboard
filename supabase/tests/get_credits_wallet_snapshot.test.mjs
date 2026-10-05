import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = readFileSync(new URL('../functions/get_credits/index.ts', import.meta.url), 'utf8');
const runnable = stripTypeScriptTypes(source.replace(
  /^import \{ createClient, type SupabaseClient \} from .*;$/m,
  'const createClient = globalThis.__mockCreateClient;',
).replace(
  /^import \{ resolveCreditWallet, WalletAccessError \} from .*;$/m,
  'const resolveCreditWallet = globalThis.__mockResolveWallet; class WalletAccessError extends Error { constructor(message, status) { super(message); this.status = status; } }',
));

async function responseFor({ rows, deviceId, testIds = '', authenticated = true }) {
  let handler;
  globalThis.Deno = {
    env: { get: (key) => key === 'CREDIT_EXACT_WALLET_TEST_IDS' ? testIds : '' },
    serve: (callback) => { handler = callback; },
  };
  globalThis.__mockCreateClient = () => ({
    from: (table) => {
      assert.equal(table, 'device_credits');
      return {
        select: () => ({
          eq: (column, value) => {
            const data = column === 'device_id'
              ? rows.find((row) => row.device_id === value) ?? null
              : rows.filter((row) => row.apple_user_id === value);
            return {
              maybeSingle: async () => ({ data, error: null }),
              then: (resolve, reject) => Promise.resolve({ data, error: null }).then(resolve, reject),
            };
          },
        }),
      };
    },
  });
  globalThis.__mockResolveWallet = async (_request, _client, requestedId) => ({
    walletId: requestedId, authenticated,
  });
  await import(`data:text/javascript,${encodeURIComponent(runnable)}#${crypto.randomUUID()}`);
  assert.equal(typeof handler, 'function');
  const logs = [];
  const originalInfo = console.info;
  const originalError = console.error;
  console.info = (...args) => logs.push({ level: 'info', message: args.join(' ') });
  console.error = (...args) => logs.push({ level: 'error', message: args.join(' ') });
  let response;
  try {
    response = await handler(new Request('http://localhost/get_credits', {
      method: 'POST',
      body: JSON.stringify({ deviceId }),
    }));
  } finally {
    console.info = originalInfo;
    console.error = originalError;
  }
  return {
    ...(await response.json()),
    status: response.status,
    diagnosticHeader: response.headers.get('X-Kingboard-Diagnostic-ID'),
    logs,
  };
}

const created_at = '2026-09-23T00:00:00Z';

test('independent legacy Apple row excludes V2 balances and reports only what it spends', async () => {
  const result = await responseFor({ authenticated: false, deviceId: 'apple', rows: [
    { device_id: 'apple', apple_user_id: null, free_credits: 130, paid_credits: 0, subscription_credits: 4000, created_at },
    { device_id: 'v2:canonical', apple_user_id: 'apple', free_credits: 0, paid_credits: 60, subscription_credits: 790, created_at },
  ] });
  assert.equal(result.status, 200);
  assert.equal(result.credits_remaining, 4130);
  assert.equal(result.free_credits_remaining, 130);
  assert.equal(result.paid_credits_remaining, 4000);
});
const linkedRows = [
  { device_id: 'apple', apple_user_id: null, free_credits: 0, paid_credits: 0, subscription_credits: 0, created_at },
  { device_id: 'local', apple_user_id: 'apple', free_credits: 500, paid_credits: 0, subscription_credits: 0, created_at },
];

test('authenticated clients report only the requested wallet that this request can spend', async () => {
  const apple = await responseFor({ rows: linkedRows, deviceId: 'apple' });
  const local = await responseFor({ rows: linkedRows, deviceId: 'local' });
  assert.equal(apple.credits_remaining, 0);
  assert.equal(local.credits_remaining, 500);
});

test('untouched old clients retain the live v13 combined display without writes', async () => {
  const rows = [
    { ...linkedRows[0], free_credits: 490, subscription_credits: 4000 },
    { ...linkedRows[1], free_credits: 0, paid_credits: 60, subscription_credits: 790 },
  ];
  for (const deviceId of ['apple', 'local']) {
    const result = await responseFor({ rows, deviceId, authenticated: false });
    assert.equal(result.status, 200);
    assert.equal(result.credits_remaining, 4850);
  }
});

test('legacy display does not create a missing Apple row or grant another 500', async () => {
  const result = await responseFor({ rows: [linkedRows[1]], deviceId: 'local', authenticated: false });
  assert.equal(result.status, 409);
});

test('an allowlisted Apple ID receives only its spendable wallet balance', async () => {
  const apple = await responseFor({ rows: linkedRows, deviceId: 'apple', testIds: 'apple' });
  const local = await responseFor({ rows: linkedRows, deviceId: 'local', testIds: 'apple' });
  assert.equal(apple.credits_remaining, 0);
  assert.equal(local.credits_remaining, 500);
});

test('paid and subscription credits on the requested wallet are preserved', async () => {
  const rows = [{ ...linkedRows[0], paid_credits: 50, subscription_credits: 200 }, linkedRows[1]];
  const apple = await responseFor({ rows, deviceId: 'apple', testIds: 'apple' });
  assert.equal(apple.free_credits_remaining, 0);
  assert.equal(apple.paid_credits_remaining, 250);
  assert.equal(apple.credits_remaining, 250);
});

test('a linked legacy request does not display another wallet balance it cannot spend', async () => {
  const rows = [
    { ...linkedRows[0], paid_credits: 4000 },
    { ...linkedRows[1], free_credits: 460, subscription_credits: 4000 },
  ];
  const existing = await responseFor({ rows, deviceId: 'apple' });
  const exact = await responseFor({ rows, deviceId: 'apple', testIds: 'apple' });
  assert.equal(existing.credits_remaining, 4000);
  assert.equal(exact.credits_remaining, 4000);
  const local = await responseFor({ rows, deviceId: 'local' });
  assert.equal(local.credits_remaining, 4460);
});

test('a wallet without a linked device is unchanged', async () => {
  const rows = [{ ...linkedRows[0], free_credits: 0, paid_credits: 200, subscription_credits: 1770 }];
  const before = await responseFor({ rows, deviceId: 'apple' });
  const after = await responseFor({ rows, deviceId: 'apple', testIds: 'apple' });
  const { diagnostic_id: _beforeId, diagnosticHeader: _beforeHeader, logs: _beforeLogs, ...beforeBalance } = before;
  const { diagnostic_id: _afterId, diagnosticHeader: _afterHeader, logs: _afterLogs, ...afterBalance } = after;
  assert.deepEqual(afterBalance, beforeBalance);
  assert.equal(after.credits_remaining, 1970);
});

test('a missing legacy wallet cannot claim the install bonus through balance lookup', async () => {
  const result = await responseFor({ rows: [], deviceId: 'new-legacy-id', authenticated: false });
  assert.equal(result.status, 409);
  assert.match(result.error, /최신 버전/);
  assert.equal(result.error_code, 'wallet_row_missing');
  assert.equal(result.failure_stage, 'legacy_snapshot');
  assert.match(result.diagnostic_id, /^[0-9a-f-]{36}$/);
  assert.equal(result.diagnosticHeader, result.diagnostic_id);
  const failureLog = JSON.parse(result.logs.find((entry) => entry.level === 'error').message);
  assert.equal(failureLog.diagnostic_id, result.diagnostic_id);
  assert.equal(failureLog.failure_stage, result.failure_stage);
  assert.equal(failureLog.error_code, result.error_code);
  assert.equal(JSON.stringify(failureLog).includes('new-legacy-id'), false);
});

test('successful balance lookup returns the same diagnostic id in body and header', async () => {
  const result = await responseFor({ rows: linkedRows, deviceId: 'local' });
  assert.equal(result.status, 200);
  assert.match(result.diagnostic_id, /^[0-9a-f-]{36}$/);
  assert.equal(result.diagnosticHeader, result.diagnostic_id);
});
