import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const audit = readFileSync(new URL('../functions/_shared/subscription_audit.ts', import.meta.url), 'utf8');
const source = readFileSync(new URL('../functions/sync_subscription_ios/_shared/subscription_alerts.ts', import.meta.url), 'utf8');
const auditUrl = `data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(audit))}`;
const runnable = stripTypeScriptTypes(source.replace("'../../_shared/subscription_audit.ts'", JSON.stringify(auditUrl)));
const { summarizeFailure, buildFailureMessage, reportFailure, readFailureGrantEvidence } = await import(`data:text/javascript,${encodeURIComponent(runnable)}`);

function events({ environment = 'Production', active = true, stage = 'atomic_subscription_and_grant', verified = true } = {}) {
  return [
    { event: 'wallet_authenticated' },
    { event: 'request_accepted', product: 'pro', walletFingerprint: 'fixture-fingerprint' },
    ...(verified ? [{ event: 'verification_completed', environment, active,
      state: active ? 'SUBSCRIPTION_STATE_ACTIVE' : 'SUBSCRIPTION_STATE_EXPIRED' }] : []),
    { event: 'rejected', stage, failureCode: 'apple_plan_not_confirmed:subscription_not_found', auditId: 'fixture-audit', product: 'pro' },
  ];
}

test('only verified active Production failures before application get priority', () => {
  const text = buildFailureMessage(summarizeFailure(events()), { failures: 12, wallets: 3, unresolved: 2 }, 'fixture-time');
  assert.equal(text, [
    '🔴 구독 반영 실패 · 프로 · 우선 확인',
    'fixture-time · 오늘 구독 오류 12건',
    '이유: 플랜 변경 확인 안 됨',
    '할 일: Codex에 진단 ID fixture-audit 전달',
  ].join('\n'));
  assert.doesNotMatch(text, /fixture-fingerprint/);
  for (const options of [{ environment: 'Unknown' }, { environment: 'Sandbox' }, { active: false },
    { verified: false }, { stage: 'balance_readback' }]) {
    assert.doesNotMatch(buildFailureMessage(summarizeFailure(events(options)), null, 'time'), /우선 확인/);
  }
});

test('Sandbox is test-labeled and unknown counts are explicit', () => {
  const text = buildFailureMessage(summarizeFailure(events({ environment: 'Sandbox' })), null, 'time');
  assert.match(text, /^🧪 테스트 결제 오류 · 프로 \(무시해도 돼요\)$/m);
  assert.equal(text.split('\n').length, 3);
  const unknownCounts = buildFailureMessage(summarizeFailure(events()), null, 'time');
  assert.match(unknownCounts, /오늘 오류 수 확인 실패/);
  assert.doesNotMatch(unknownCounts, /0건/);
});

test('same-cycle evidence is authenticated, readonly, and does not claim a fresh charge', async () => {
  let queries = 0;
  let result = { data: null, error: null };
  const filters = [];
  const db = { from(table) {
    queries += 1;
    assert.equal(table, 'credit_transactions');
    return { select() { return this; }, eq(...args) { filters.push(args); return this; },
      async maybeSingle() { return result; } };
  } };
  const context = { walletId: 'fixture-owner', grantKey: 'fixture-cycle' };
  assert.equal(await readFailureGrantEvidence(db, false, context), 'not_checked');
  assert.equal(queries, 0);
  assert.equal(await readFailureGrantEvidence(db, true, context), 'same_cycle_grant_missing');
  assert.deepEqual(filters, [['transaction_type', 'subscription_monthly_grant'], ['idempotency_key', 'fixture-cycle']]);
  result = { data: { device_id: 'fixture-owner' }, error: null };
  assert.equal(await readFailureGrantEvidence(db, true, context), 'same_cycle_grant_found');
  result = { data: { device_id: 'fixture-other' }, error: null };
  assert.equal(await readFailureGrantEvidence(db, true, context), 'grant_record_other_wallet');
  result = { data: null, error: { message: 'private upstream' } };
  assert.equal(await readFailureGrantEvidence(db, true, context), 'lookup_failed');
  const text = buildFailureMessage(summarizeFailure(events()), null, 'time', 'same_cycle_grant_missing');
  assert.match(text, /^이번 달 지급 기록: 없음$/m);
  assert.doesNotMatch(buildFailureMessage(summarizeFailure(events()), null, 'time'), /지급 기록/);
  assert.doesNotMatch(text, /fixture-owner|fixture-cycle|private upstream/);
});

test('verified rejection preserves environment without trusting a request-supplied environment', () => {
  const value = events({ verified: false });
  value.at(-1).environment = 'Sandbox';
  assert.equal(summarizeFailure(value).environment, 'Sandbox');
  assert.equal(summarizeFailure(value).verifiedActive, false);
  assert.equal(summarizeFailure([{ event: 'request_accepted', environment: 'Sandbox' },
    { event: 'sync_failed' }]).environment, 'Unknown');
  assert.equal(summarizeFailure([{ event: 'sync_completed' }]), null);
});

test('failed count query or missing failure record renders unknown counts, with no real send', async () => {
  const messages = [];
  const logs = [];
  const previousFetch = globalThis.fetch;
  const previousError = console.error;
  globalThis.Deno = { env: { get: key => ({ TELEGRAM_BOT_TOKEN: 'fixture-token', TELEGRAM_CHAT_ID: 'fixture-chat' })[key] } };
  globalThis.fetch = async (url, options) => {
    assert.ok(url.startsWith('https://api.telegram.org/'));
    messages.push(JSON.parse(options.body).text);
    return Response.json({ ok: true });
  };
  console.error = value => { if (typeof value === 'string' && value.startsWith('{')) logs.push(JSON.parse(value)); };
  const db = { from(table) {
    const query = {
      select() { return this; }, gte() { return this; }, lt() { return this; },
      order() { return this; }, eq() { return this; },
      async range() { return { error: { message: 'secret upstream' }, data: null }; },
      async insert() { assert.equal(table, 'telegram_alert_logs'); return { error: null }; },
      update() { return this; },
      then(resolve) { return Promise.resolve({ error: null }).then(resolve); },
    };
    return query;
  } };
  try {
    await reportFailure(db, events());
    await reportFailure(db, events(), false);
  } finally { globalThis.fetch = previousFetch; console.error = previousError; }
  assert.equal(messages.length, 2);
  assert.ok(messages.every(message => message.includes('오늘 오류 수 확인 실패')));
  assert.ok(messages.every(message => !message.includes('secret upstream')));
  assert.equal(logs.filter(log => log.event === 'failure_counts_unavailable').length, 2);
});
