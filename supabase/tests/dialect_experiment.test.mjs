import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';
import { buildPipeline, dialectOnlyCandidate } from '../experiments/20261019-dialect-standardization/prepare.mjs';
import { plan, run } from '../experiments/20261019-dialect-standardization/run.mjs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const samples = JSON.parse(read('../experiments/20261019-dialect-standardization/cases.json'));
const makeContext = (extras = {}) => vm.createContext({
  Request, Response, Headers, URL, TextEncoder, TextDecoder, Uint8Array, AbortSignal,
  crypto, setTimeout: (fn) => setTimeout(fn, 0), clearTimeout,
  fetch: () => { throw new Error('REAL_NETWORK_FORBIDDEN'); }, ...extras,
});
function factory(source, edits) {
  const context = makeContext();
  vm.runInContext(stripTypeScriptTypes(buildPipeline(source, edits).replace(/^export /gm, '')) + '\nglobalThis.factory = createPipeline;', context);
  return context.factory;
}
const baseline = '../deploy-bundles/20261019-dialect-proofing-release/baseline/supabase/functions/correct/';
const before = factory(read(baseline + 'index.ts'), read(baseline + 'proofing_edits.ts'));
const projectedAfter = dialectOnlyCandidate(read('../functions/correct/index.ts'));
const after = factory(projectedAfter, read('../functions/correct/proofing_edits.ts'));
const actual = factory(read('../functions/correct/index.ts'), read('../functions/correct/proofing_edits.ts'));
const initial = before;
const providerReply = (text, status = 200) => Response.json({
  candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
}, { status });
const productionRequest = (text, includeDialect) => new Request('https://local.invalid/correct', {
  method: 'POST', body: JSON.stringify({
    text, includeDialect, formalMode: false, removePunct: true,
    deviceId: 'synthetic-dialect-only', requestId: crypto.randomUUID(),
  }),
});
const fixedNow = Date.parse('2026-10-19T00:00:00Z');
function experiment(overrides = {}, network = async (_input, init) => {
  return providerReply(JSON.parse(init.body).contents[0].parts[0].text);
}) {
  const values = {
    DIALECT_EXPERIMENT_OPEN: 'true', DIALECT_EXPERIMENT_TOKEN: 'a'.repeat(64),
    DIALECT_EXPERIMENT_STARTS_AT: new Date(fixedNow - 1000).toISOString(),
    DIALECT_EXPERIMENT_EXPIRES_AT: new Date(fixedNow + 60_000).toISOString(),
    GEMINI_API_KEY: 'synthetic-provider-key', ...overrides,
  };
  let attempts = 0;
  const context = makeContext({ beforePipeline: before, afterPipeline: after, beforeHash: 'before-hash', afterHash: 'after-hash', cases: samples, Deno: { serve: () => {} } });
  const source = read('../functions/dialect_standardization_experiment/index.ts').replace(/^import .*$/gm, '').replace(/^export /gm, '');
  vm.runInContext(stripTypeScriptTypes(source) + '\nglobalThis.factory = createExperimentHandler;', context);
  return {
    attempts: () => attempts,
    set: (name, value) => { values[name] = value; },
    handle: context.factory({ env: (name) => values[name], now: () => fixedNow,
      fetch: async (...args) => { attempts++; return network(...args); } }),
  };
}
const request = (body = { caseId: 1, variant: 'after', includeDialect: true }, headers = {}) => new Request('https://local.invalid/experiment', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'x-dialect-experiment-token': 'a'.repeat(64), ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('prepared pipelines and corpus are deterministic copies of current exact sources', () => {
  for (const [variant, source, edits] of [
    ['before', baseline + 'index.ts', baseline + 'proofing_edits.ts'],
    ['after', '../functions/correct/index.ts', '../functions/correct/proofing_edits.ts'],
  ]) {
    assert.equal(read(`../functions/dialect_standardization_experiment/generated-${variant}.ts`), buildPipeline(variant === 'after' ? projectedAfter : read(source), read(edits)));
  }
  const generated = makeContext();
  vm.runInContext(read('../functions/dialect_standardization_experiment/generated-cases.ts').replace('export const cases', 'globalThis.cases'), generated);
  assert.equal(JSON.stringify(generated.cases), JSON.stringify(samples));
  assert.equal(samples.length, 30);
  assert.equal(new Set(samples.map((row) => row.id)).size, 30);
  const comparisons = JSON.parse(read('../experiments/20261019-dialect-standardization/prompt-comparison.json'));
  assert.equal(comparisons.offIdentical, 67);
  assert.equal(comparisons.toneIdentical, 64);
  assert.ok([...comparisons.off, ...comparisons.tone].every((row) => row.beforeSha256 === row.afterSha256 && row.identical));
  for (const row of comparisons.spellingOn) {
    assert.match(row.after, /문장 전체를 자연스러운 표준어로/);
    assert.doesNotMatch(row.after, /말투 변경이 아니다|반말로만 바꿔라/);
  }
});

test('runner defaults to 60 ON slots; optional 120 slots require separate OFF approval; no implicit network', async () => {
  const slots = plan();
  assert.equal(slots.length, 60);
  assert.ok(slots.every((slot) => slot.includeDialect === true));
  assert.equal(new Set(slots.map((slot) => JSON.stringify(slot))).size, 60);
  assert.equal(plan({ includePaidOff: true }).length, 120);
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('REAL_NETWORK_FORBIDDEN'); };
  try {
    await run([]);
    await run(['--run']);
    await run(['--approve-paid-ai']);
    await run(['--include-paid-off']);
    await assert.rejects(() => run(['--run', '--approve-paid-ai', '--include-paid-off']), /Separate paid OFF approval required/);
  } finally { globalThis.fetch = original; }
});

test('all 30 synthetic sentences traverse actual handler + primary pipeline locally with no network', async () => {
  for (const create of [before, after]) {
    for (const includeDialect of [false, true]) {
      for (const sample of samples) {
        let calls = 0;
        const pipeline = create(async (_url, init) => {
          calls++;
          assert.equal(JSON.parse(init.body).contents[0].parts[0].text, sample.text);
          return providerReply(sample.text);
        }, 'not-a-secret');
        const response = await pipeline.handleCorrection(productionRequest(sample.text, includeDialect));
        assert.equal(response.status, 200);
        assert.equal((await response.json()).result, sample.text);
        assert.equal(calls, 1);
        assert.equal(pipeline.metrics.wallet, 1);
        assert.equal(pipeline.metrics.charge, 1);
        assert.equal(pipeline.metrics.refund, 0);
      }
    }
  }
});

test('actual working handler still rejects missing device/request IDs before wallet or provider', async () => {
  const pipeline = actual(async () => { throw new Error('PROVIDER_MUST_NOT_BE_CALLED'); }, 'not-a-secret');
  const response = await pipeline.handleCorrection(new Request('https://local.invalid/correct', {
    method: 'POST', body: JSON.stringify({ text: samples[0].text, includeDialect: true, formalMode: false }),
  }));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'APP_UPDATE_REQUIRED');
  assert.equal(pipeline.metrics.wallet, 0);
  assert.equal(pipeline.metrics.charge, 0);
});

test('OFF actual primary, safety fallback and provider configs preserve initial dirty state', async () => {
  const source = '엄니가 보낸 서류를 오늘 오후에 확인하고 동생한테 전화혀.';
  const runs = [];
  for (const create of [initial, actual]) {
    const calls = [];
    const pipeline = create(async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      return providerReply(calls.length === 1 ? '확인해.' : JSON.stringify({ edits: [{ find: '전화혀', replace: '전화해' }] }));
    }, 'not-a-secret');
    const response = await pipeline.handleCorrection(productionRequest(source, false));
    runs.push({ calls, result: (await response.json()).result });
    assert.equal(calls.length, 2);
  }
  assert.deepEqual(runs[1], runs[0]);
});

test('ON fallback uses full original source and real edit validation, rejects ambiguous/overlapping edits', async () => {
  const source = '니가 준 자료 자료 확인하고 엄니한테 전화혀.';
  const calls = [];
  const pipeline = after(async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return providerReply(calls.length === 1 ? '확인해.' : JSON.stringify({ edits: [
      { find: '자료', replace: '서류' },
      { find: '전화혀', replace: '전화해' },
      { find: '전화혀.', replace: '연락해.' },
    ] }));
  }, 'not-a-secret');
  const result = await (await pipeline.handleCorrection(productionRequest(source, true))).json();
  assert.equal(result.result, source.replace('전화혀', '전화해'));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].contents[0].parts[0].text, source);
  assert.match(calls[1].system_instruction.parts[0].text, /문장 전체를 자연스러운 표준어로/);
  assert.equal(calls[1].generationConfig.responseMimeType, 'application/json');
});

test('real retry and malformed JSON fallback paths preserve source without DB/credit writes', async () => {
  let calls = 0;
  const pipeline = after(async () => {
    calls++;
    if (calls === 1) return providerReply('', 503);
    return providerReply(calls === 2 ? '.' : 'not json');
  }, 'not-a-secret');
  const source = '엄니한테 받은 서류는 책상에 두고 동생한테 전화혀.';
  const result = await (await pipeline.handleCorrection(productionRequest(source, true))).json();
  assert.equal(result.result, source);
  assert.equal(calls, 3);
  assert.equal(pipeline.metrics.refund, 0);
});

test('records existing deletion-guard blind spot without changing truncation ownership', async () => {
  let calls = 0;
  const pipeline = after(async () => { calls++; return providerReply('확인해.'); }, 'not-a-secret');
  const source = '엄니한테 받은 서류는 책상에 두고 동생한테 전화혀.';
  const result = await (await pipeline.handleCorrection(productionRequest(source, true))).json();
  assert.equal(result.result, '확인해.');
  assert.equal(calls, 1, 'Existing LCS guard may accept a shortened replacement; report, do not edit here');
});

test('closed/missing/expired/overlong/future windows reject before provider access', async () => {
  for (const config of [
    { DIALECT_EXPERIMENT_OPEN: undefined }, { DIALECT_EXPERIMENT_TOKEN: undefined },
    { DIALECT_EXPERIMENT_EXPIRES_AT: 'invalid' },
    { DIALECT_EXPERIMENT_EXPIRES_AT: new Date(fixedNow).toISOString() },
    { DIALECT_EXPERIMENT_EXPIRES_AT: new Date(fixedNow + 16 * 60_000).toISOString() },
    { DIALECT_EXPERIMENT_STARTS_AT: new Date(fixedNow + 1000).toISOString() },
  ]) {
    const subject = experiment(config);
    assert.equal((await subject.handle(request())).status, 410);
    assert.equal(subject.attempts(), 0);
  }
});

test('missing, malformed and wrong experiment token reject before body/AI; no public OPTIONS', async () => {
  const subject = experiment();
  for (const token of ['', 'b'.repeat(64), 'a'.repeat(63)]) {
    assert.equal((await subject.handle(request({}, { 'x-dialect-experiment-token': token }))).status, 401);
  }
  assert.equal((await subject.handle(new Request('https://local.invalid', { method: 'OPTIONS' }))).status, 405);
  assert.equal(subject.attempts(), 0);
});

test('fixed corpus only: rejects custom text, model, tone, URL, invalid flags and oversized body', async () => {
  const subject = experiment();
  for (const body of [
    { caseId: 1, variant: 'after', includeDialect: true, text: 'arbitrary user input' },
    { caseId: 1, variant: 'after', includeDialect: true, model: 'other' },
    { caseId: 1, variant: 'after', includeDialect: true, formalMode: true },
    { caseId: 1, variant: 'after', includeDialect: true, url: 'https://other.invalid' },
    { caseId: 31, variant: 'after', includeDialect: true },
    { caseId: 1, variant: 'after', includeDialect: 'true' },
    { caseId: 1, variant: 'unknown', includeDialect: true }, null, [], '{bad json',
  ]) assert.equal((await subject.handle(request(body))).status, 400);
  assert.equal((await subject.handle(request('x'.repeat(1025)))).status, 413);
  assert.equal(subject.attempts(), 0);
});

test('protected experiment runs fixed case through actual handler, redacts keys and blocks replay', async () => {
  const subject = experiment();
  const response = await subject.handle(request());
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(data.result, samples[0].text);
  assert.equal(data.correctionStatus, 200);
  assert.equal(data.simulated.wallet, 1);
  assert.equal(data.simulated.charge, 1);
  assert.equal(data.realDatabaseCalls, 0);
  assert.equal(data.realCreditOperations, 0);
  assert.equal(data.calls.length, 1);
  assert.equal(JSON.stringify(data).includes('synthetic-provider-key'), false);
  assert.equal((await subject.handle(request())).status, 409);
  assert.equal(subject.attempts(), 1);
});

test('protected experiment bounds retries to four calls and fails original handler with simulated refund', async () => {
  const subject = experiment({}, async () => providerReply('', 503));
  const data = await (await subject.handle(request())).json();
  assert.equal(data.correctionStatus, 500);
  assert.equal(data.calls.length, 2);
  assert.equal(data.simulated.refund, 1);
  assert.equal(subject.attempts(), 2);
});

test('protected primary + JSON fallback + transient retries total at most four provider attempts', async () => {
  let count = 0;
  const subject = experiment({}, async () => {
    count++;
    if (count === 1 || count === 3) return providerReply('', 503);
    return providerReply(count === 2 ? '.' : '{"edits":[]}');
  });
  const data = await (await subject.handle(request())).json();
  assert.equal(data.correctionStatus, 200);
  assert.equal(data.result, samples[0].text);
  assert.equal(subject.attempts(), 4);
  assert.deepEqual(data.calls.map((call) => call.status), [503, 200, 503, 200]);
  assert.deepEqual(data.calls.map((call) => call.structuredEdits), [false, false, true, true]);
});

test('missing existing runtime provider key fails closed without reading any other key', async () => {
  const subject = experiment({ GEMINI_API_KEY: undefined, DIALECT_EXPERIMENT_GEMINI_API_KEY: 'unrelated-key' });
  assert.equal((await subject.handle(request())).status, 503);
  assert.equal(subject.attempts(), 0);
});

test('paid OFF is denied by default and needs its own server gate', async () => {
  const denied = experiment();
  const slot = { caseId: 1, variant: 'after', includeDialect: false };
  assert.equal((await denied.handle(request(slot))).status, 403);
  assert.equal(denied.attempts(), 0);
  const allowed = experiment({ DIALECT_EXPERIMENT_ALLOW_PAID_OFF: 'true' });
  assert.equal((await allowed.handle(request(slot))).status, 200);
  assert.equal(allowed.attempts(), 1);
});

test('auth failure stops outgoing retry and raw provider text cannot leak experiment/provider token', async () => {
  const subject = experiment({}, async () => providerReply('synthetic-provider-key ' + 'a'.repeat(64), 401));
  const data = await (await subject.handle(request())).json();
  assert.equal(data.correctionStatus, 500);
  assert.equal(subject.attempts(), 1);
  assert.equal(JSON.stringify(data).includes('synthetic-provider-key'), false);
  assert.equal(JSON.stringify(data).includes('a'.repeat(64)), false);
});

test('explicit closing gate stops subsequent provider retries and rejects fresh requests', async () => {
  let subject;
  subject = experiment({}, async () => {
    subject.set('DIALECT_EXPERIMENT_OPEN', 'false');
    return providerReply('', 503);
  });
  const data = await (await subject.handle(request())).json();
  assert.equal(data.correctionStatus, 500);
  assert.equal(subject.attempts(), 1);
  assert.equal((await subject.handle(request({ caseId: 2, variant: 'after', includeDialect: true }))).status, 410);
  assert.equal(subject.attempts(), 1);
});
