import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const auditSource = readFileSync(new URL('../functions/_shared/subscription_audit.ts', import.meta.url), 'utf8');
const auditUrl = `data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(auditSource))}`;
const source = readFileSync(new URL('../functions/daily_digest/index.ts', import.meta.url), 'utf8');
const reporting = readFileSync(new URL('../functions/_shared/subscription_reporting.ts', import.meta.url), 'utf8');
const reportingUrl = `data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(reporting))}`;
const runnable = stripTypeScriptTypes(source
  .replace(/^import \{ createClient \} from .*$/m, 'const createClient = globalThis.__digestClient;')
  .replace(/^import \{ sendTelegram \} from .*$/m, 'const sendTelegram = globalThis.__digestSender;')
  .replace("'../_shared/subscription_audit.ts'", JSON.stringify(auditUrl))
  .replace("'../_shared/subscription_reporting.ts'", JSON.stringify(reportingUrl)));

async function run({ countError = false, range = '', subscriberError = false, deliveryKey } = {}) {
  const queries = [];
  const messages = [];
  const previousFetch = globalThis.fetch;
  let handler;
  globalThis.Deno = { env: { get: key => ({ SUPABASE_URL: 'https://example.invalid',
    SUPABASE_SERVICE_ROLE_KEY: 'fixture-service', CRON_SECRET: 'fixture-cron' })[key] },
    serve: value => { handler = value; } };
  globalThis.__digestSender = async message => { messages.push(message); return true; };
  globalThis.__digestClient = () => ({ from(table) {
    const call = { table };
    queries.push(call);
    return {
      select(columns, options) { call.columns = columns; call.head = options?.head; return this; },
      gte(column, value) { call.start = value; return this; },
      lt(column, value) { call.end = value; return this; },
      in() { return this; }, eq() { return this; }, order() { return this; },
      limit() { return this; }, range() { return this; }, maybeSingle() { return this; },
      upsert() { return this; },
      then(resolve, reject) {
        if (table === 'subscription_sync_failures' && countError) {
          return Promise.resolve({ error: { message: 'sensitive upstream' }, data: null }).then(resolve, reject);
        }
        return Promise.resolve({ count: 0, data: table === 'admin_daily_snapshot' ? null : [], error: null }).then(resolve, reject);
      },
    };
  } });
  globalThis.fetch = async url => {
    assert.equal(url, 'https://example.invalid/functions/v1/subscriber_status?include_history=1');
    if (subscriberError) return Response.json({ error: 'unavailable' }, { status: 503 });
    return Response.json({ active_subscribers_now: 2 });
  };
  try {
    await import(`data:text/javascript,${encodeURIComponent(runnable)}#${crypto.randomUUID()}`);
    const response = await handler(new Request(`https://example.invalid/digest${range}`, {
      method: 'POST', headers: { 'x-cron-secret': 'fixture-cron',
        ...(deliveryKey ? { 'x-report-idempotency-key': deliveryKey } : {}) },
    }));
    return { status: response.status, body: await response.json(), queries, messages };
  } finally { globalThis.fetch = previousFetch; }
}

test('daily digest includes subscription activity without calling the reconcile endpoint or sending for real', async () => {
  const result = await run();
  assert.equal(result.status, 200);
  // Only plan changes written with the versioned marker are counted, so it is 0 here and the text says what it covers.
  assert.equal(result.body.subscriptionActivity.planChangeSuccesses, 0);
  assert.equal(result.messages.length, 1);
  assert.match(result.messages[0], /플랜 변경 지급 성공 0건/);
  assert.match(result.messages[0], /미분류는 변경 0건으로 해석하지 않으며/);
  assert.match(result.messages[0], /갱신 지급 0건/);
  const call = result.queries.find(q => q.table === 'subscription_sync_failures');
  assert.equal(Date.parse(call.end) - Date.parse(call.start), 86400_000);
  assert.equal(new Date(call.start).getUTCHours(), 15);
  assert.equal(new Date(call.end).getUTCHours(), 15);
});

test('today digest preserves the same time window and exposes unknown failure counts in JSON and text', async () => {
  const result = await run({ countError: true, range: '?range=today' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.subscriptionActivity.errors, ['subscription_failure_counts_failed']);
  assert.equal(result.body.subscriptionActivity.groups[0].failures, null);
  assert.match(result.messages[0], /실패 요청 집계 불가/);
  assert.doesNotMatch(result.messages[0], /실패 요청 0건|sensitive upstream/);
  const failures = result.queries.find(q => q.table === 'subscription_sync_failures');
  const grants = result.queries.find(q => q.columns === 'id,metadata');
  assert.equal(failures.start, grants.start);
  assert.equal(failures.end, grants.end);
});

test('one-time current report is not sent when the internal subscriber lookup fails', async () => {
  const result = await run({ range: '?view=subscriptions', deliveryKey: 'one-time-test', subscriberError: true });
  assert.equal(result.status, 503);
  assert.equal(result.body.sent, false);
  assert.equal(result.messages.length, 0);
});
