import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const root = new URL('./', import.meta.url);
// Optional directories execute this same suite against a newly verified live/candidate pair.
const source = (variant, file = 'index.ts') => readFileSync(
  process.env[`CORRECT_RESPONSE_${variant.toUpperCase()}_DIR`]
    ? join(process.env[`CORRECT_RESPONSE_${variant.toUpperCase()}_DIR`], file)
    : new URL(`${variant}/supabase/functions/correct/${file}`, root), 'utf8');
const baseline = source('baseline');
const release = source('release');

function harness(code = release, { response, accepted = true, alreadyProcessed = false } = {}) {
  const calls = { fetch: [], consume: [], refund: [], wallet: [], logs: [] };
  const runnable = stripTypeScriptTypes(code.replace(/^import .*$/gm, ''));
  const context = {
    Request, Response, TextEncoder, crypto, setTimeout,
    console: {
      log: (...args) => calls.logs.push(args),
      warn: (...args) => calls.logs.push(args),
      error: (...args) => calls.logs.push(args),
    },
    Deno: { env: { get: () => 'mock-only' }, serve: (handler) => { context.handler = handler; } },
    createClient: () => ({}),
    WalletAccessError: class extends Error { constructor(message, status) { super(message); this.status = status; } },
    resolveCreditWallet: async (...args) => { calls.wallet.push(args); return { walletId: 'test-wallet' }; },
    consumeAIUsage: async (...args) => {
      calls.consume.push(args);
      return { accepted, alreadyProcessed, freeCredits: accepted ? 470 : 0, paidCredits: 0, remaining: accepted ? 470 : 0 };
    },
    refundAIUsage: async (...args) => { calls.refund.push(args); },
    parseProofingEdits: () => [],
    applyValidatedProofingEdits: (text) => ({ result: text, rejected: [] }),
    fetch: async (url, init) => {
      calls.fetch.push({ url: String(url), body: JSON.parse(init.body) });
      return Response.json(response ?? { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'complete response' }] } }] });
    },
  };
  runInNewContext(runnable, context);
  return { context, calls, request: async (overrides = {}) => {
    const res = await context.handler(new Request('https://local.test/correct', {
      method: 'POST', body: JSON.stringify({ text: 'source text', formalMode: true, formalLevel: 'smart', deviceId: 'test-wallet', requestId: 'test-request', diagnosticTrace: true, ...overrides }),
    }));
    return { res, body: await res.json() };
  } };
}

test('baseline reproduces partial success and dropped second part', async () => {
  const partial = harness(baseline, { response: { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'partial' }] } }] } });
  assert.equal((await partial.request()).body.result, 'partial');
  const multipart = harness(baseline, { response: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'first' }, { text: 'second' }] } }] } });
  assert.equal((await multipart.request()).body.result, 'first');
});

test('release returns all visible parts, excluding thought and non-text parts', async () => {
  const h = harness(release, { response: { candidates: [{ finishReason: 'STOP', content: { parts: [
    { text: 'private thought', thought: true }, { text: 'first' }, { inlineData: {} }, { text: 'second' },
  ] } }] } });
  const { res, body } = await h.request();
  assert.equal(res.status, 200);
  assert.equal(body.result, 'firstsecond');
  assert.equal(h.calls.consume.length, 1);
  assert.equal(h.calls.consume[0][3], 'formal');
  assert.equal(h.calls.refund.length, 0);
});

for (const reason of ['MAX_TOKENS', 'SAFETY', 'RECITATION', undefined]) {
  test(`rejects ${reason ?? 'missing finish reason'} and attempts one existing refund`, async () => {
    const h = harness(release, { response: { candidates: [{ finishReason: reason, content: { parts: [{ text: 'DO_NOT_RETURN_PARTIAL' }] } }] } });
    const { res, body } = await h.request();
    assert.equal(res.status, 500);
    assert.equal(body.result, undefined);
    assert.equal(h.calls.consume.length, 1);
    assert.equal(h.calls.refund.length, 1);
    assert.equal(h.calls.fetch.length, 1);
    assert.ok(!JSON.stringify(h.calls.logs).includes('DO_NOT_RETURN_PARTIAL'));
    const log = h.calls.logs.find((args) => args[1]?.code === 'AI_INCOMPLETE_RESPONSE');
    assert.equal(log[1].diagnostic_id, body.diagnostic_id);
  });
}

test('empty visible result rejects and refunds, rather than exposing candidate contents', async () => {
  const h = harness(release, { response: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'private thought', thought: true }] } }] } });
  assert.equal((await h.request()).res.status, 500);
  assert.equal(h.calls.refund.length, 1);
  assert.ok(!JSON.stringify(h.calls.logs).includes('private thought'));
});

test('already-processed request is not refunded again', async () => {
  const h = harness(release, { alreadyProcessed: true, response: { candidates: [{ finishReason: 'MAX_TOKENS' }] } });
  assert.equal((await h.request()).res.status, 500);
  assert.equal(h.calls.refund.length, 0);
});

for (const tone of ['smart', '존댓말', '격식체', '비즈니스', '고객 안내', '학부모 안내', '소개팅체']) {
  test(`${tone}: same prompt/model/thinking and larger completion budget`, async () => {
    const old = harness(baseline);
    const next = harness();
    assert.equal((await old.request({ formalLevel: tone })).res.status, 200);
    assert.equal((await next.request({ formalLevel: tone })).res.status, 200);
    const a = old.calls.fetch[0];
    const b = next.calls.fetch[0];
    assert.equal(a.url, b.url);
    assert.equal(b.body.system_instruction.parts[0].text, a.body.system_instruction.parts[0].text);
    assert.equal(b.body.generationConfig.thinkingConfig.thinkingLevel, 'medium');
    assert.equal(b.body.generationConfig.temperature, a.body.generationConfig.temperature);
    assert.equal(a.body.generationConfig.maxOutputTokens, 1000);
    assert.equal(b.body.generationConfig.maxOutputTokens, 4096);
  });
}

test('spelling provider and budget are unchanged', async () => {
  const old = harness(baseline);
  const next = harness();
  await old.request({ formalMode: false });
  await next.request({ formalMode: false });
  assert.deepEqual(next.calls.fetch, old.calls.fetch);
  assert.equal(next.calls.fetch[0].body.generationConfig.maxOutputTokens, 1000);
});

test('custom tone still joins completed Luna output with 4000 cap', async () => {
  const h = harness(release, { response: { status: 'completed', output: [{ type: 'message', content: [
    { type: 'output_text', text: 'first' }, { type: 'output_text', text: 'second' },
  ] }] } });
  assert.equal((await h.request({ formalLevel: 'custom', customPrompt: 'style' })).body.result, 'firstsecond');
  assert.equal(h.calls.fetch[0].body.model, 'gpt-6-luna');
  assert.equal(h.calls.fetch[0].body.max_output_tokens, 4000);
});

test('custom incomplete response still rejects and refunds', async () => {
  const h = harness(release, { response: { status: 'incomplete', output_text: 'partial' } });
  assert.equal((await h.request({ formalLevel: 'custom', customPrompt: 'style' })).res.status, 500);
  assert.equal(h.calls.refund.length, 1);
});

test('request ID guard and insufficient credits still stop before AI', async () => {
  const legacy = harness();
  const missing = await legacy.request({ requestId: undefined });
  assert.equal(missing.res.status, 409);
  assert.equal(missing.body.code, 'APP_UPDATE_REQUIRED');
  assert.equal(legacy.calls.wallet.length, 0);
  assert.equal(legacy.calls.fetch.length, 0);
  const poor = harness(release, { accepted: false });
  assert.equal((await poor.request()).res.status, 429);
  assert.equal(poor.calls.fetch.length, 0);
});

test('custom preview still has no wallet or credit writes', async () => {
  const h = harness(release, { response: { status: 'completed', output_text: 'preview result' } });
  assert.equal((await h.request({ preview: true, formalLevel: 'custom', customPrompt: 'style', deviceId: undefined, requestId: undefined })).res.status, 200);
  assert.equal(h.calls.wallet.length, 0);
  assert.equal(h.calls.consume.length, 0);
  assert.equal(h.calls.refund.length, 0);
});

test('shared authentication, credits, and proofing files remain identical', () => {
  for (const file of ['_shared/wallet_auth.ts', '_shared/credits.ts', 'proofing_edits.ts']) {
    assert.equal(source('release', file), source('baseline', file));
  }
});
