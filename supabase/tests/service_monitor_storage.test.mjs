import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = readFileSync(new URL('../functions/service_monitor/index.ts', import.meta.url), 'utf8');
const runnable = stripTypeScriptTypes(source
  .replace(/^import \{ createClient \} from .*$/m, 'const createClient = globalThis.__monitorDb;')
  .replace(/^import \{ sendTelegram \} from .*$/m, 'const sendTelegram = globalThis.__monitorSender;'));

const GB = 1024 ** 3;

// Runs the real handler with quiet slow/wallet checks and the given storage numbers.
async function run(storage) {
  const messages = [];
  let handler;
  globalThis.Deno = { env: { get: key => ({ SERVICE_MONITOR_SECRET: 's', SUPABASE_URL: 'https://example.invalid',
    SUPABASE_SERVICE_ROLE_KEY: 'k' })[key] }, serve: fn => { handler = fn; } };
  const query = () => {
    const q = { select() { return q; }, eq() { return q; }, gte() { return q; }, lt() { return q; }, delete() { return q; },
      then(resolve) { resolve({ data: [], count: 0, error: null }); } };
    return q;
  };
  globalThis.__monitorDb = () => ({
    from: query,
    async rpc(name) {
      assert.equal(name, 'service_monitor_storage');
      return storage instanceof Error ? { data: null, error: storage } : { data: [storage], error: null };
    },
  });
  globalThis.__monitorSender = async (text, options) => { messages.push({ text, options }); return true; };
  await import(`data:text/javascript,${encodeURIComponent(runnable)}#${crypto.randomUUID()}`);
  const response = await handler(new Request('https://example.invalid/service_monitor', { headers: { 'x-monitor-secret': 's' } }));
  assert.equal(response.status, 200);
  return messages;
}

test('normal storage sends nothing', async () => {
  assert.equal((await run({ database_bytes: 0.83 * GB, http_response_bytes: 32 * 1024 })).length, 0);
});

test('database above the warning line sends a 6-hour warning', async () => {
  const [m, ...rest] = await run({ database_bytes: 5.2 * GB, http_response_bytes: 0 });
  assert.equal(rest.length, 0);
  assert.match(m.text, /^💾 <b>DB 저장공간 경고<\/b>/);
  assert.match(m.text, /DB <b>5\.20GB<\/b> \/ 디스크 8\.00GB \(65%\)/);
  assert.equal(m.options.alertType, 'service_monitor_storage');
  assert.match(m.options.idempotencyKey, /^warn:b\d+$/);
});

test('database near the read-only point sends a critical alert', async () => {
  const [m] = await run({ database_bytes: 7.2 * GB, http_response_bytes: 6.4 * GB });
  assert.match(m.text, /^🚨 <b>DB 저장공간 위험<\/b>/);
  assert.match(m.text, /외부 호출 응답 보관함 6\.40GB/);
  assert.match(m.options.idempotencyKey, /^critical:b\d+$/);
});

test('a growing pg_net response table warns even when the database is small', async () => {
  const [m] = await run({ database_bytes: 1.2 * GB, http_response_bytes: 0.4 * GB });
  assert.match(m.text, /DB 저장공간 경고/);
});

test('a failed storage lookup is logged without failing the monitor', async () => {
  assert.equal((await run(new Error('rpc down'))).length, 0);
});
