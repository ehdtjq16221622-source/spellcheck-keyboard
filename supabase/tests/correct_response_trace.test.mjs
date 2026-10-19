import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../functions/correct/index.ts', import.meta.url), 'utf8');
const uuid = '12345678-1234-4abc-8def-123456789abc';
const secret = 'NEVER_LOG_SOURCE_PROVIDER_PROMPT_DEVICE_WALLET_OR_ERROR';
const complete = (text = 'complete') => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] });

function harness({ code = source, payload = complete(), httpStatus = 200, fetchError, walletError, refundError, accepted = true, alreadyProcessed = false } = {}) {
  const calls = { fetch: [], consume: [], refund: [], wallet: [], logs: [] };
  const context = {
    Request, Response, TextEncoder, crypto,
    setTimeout: (callback) => { callback(); },
    console: Object.fromEntries(['log', 'warn', 'error'].map((level) => [level, (...args) => calls.logs.push(args)])),
    Deno: { env: { get: () => secret }, serve: (handler) => { context.handler = handler; } },
    createClient: () => ({}),
    WalletAccessError: class extends Error { constructor(message, status) { super(message); this.status = status; } },
    resolveCreditWallet: async (...args) => {
      calls.wallet.push(args);
      if (walletError) throw new context.WalletAccessError('Wallet denied.', 401);
      return { walletId: `canonical-${secret}` };
    },
    consumeAIUsage: async (...args) => {
      calls.consume.push(args);
      return { accepted, alreadyProcessed, freeCredits: accepted ? 470 : 0, paidCredits: 0, remaining: accepted ? 470 : 0 };
    },
    refundAIUsage: async (...args) => { calls.refund.push(args); if (refundError) throw new Error(secret); },
    parseProofingEdits: () => [],
    applyValidatedProofingEdits: (text) => ({ result: text, rejected: [] }),
    fetch: async (url, init) => {
      calls.fetch.push({ url: String(url), body: JSON.parse(init.body) });
      if (fetchError) throw new Error(secret);
      return typeof payload === 'string' ? new Response(payload, { status: httpStatus }) : Response.json(payload, { status: httpStatus });
    },
  };
  runInNewContext(stripTypeScriptTypes(code.replace(/^import .*$/gm, '')), context);
  return {
    calls,
    request: async (overrides = {}) => {
      const res = await context.handler(new Request('https://local.test/correct', {
        method: 'POST',
        body: JSON.stringify({ text: secret, formalMode: true, formalLevel: 'smart', deviceId: secret, requestId: `credit-${secret}`, customPrompt: secret, ...overrides }),
      }));
      return { res, body: await res.json() };
    },
  };
}

function traces(h) {
  return h.calls.logs.filter((args) => args[1]?.event === 'tone_response_trace').map((args) => args[1]);
}

function assertPrivate(h) {
  assert.ok(!JSON.stringify(h.calls.logs).includes(secret), 'No original, provider, prompt, account identifier, key, or raw error may enter logs');
  const allowed = new Set(['event', 'diagnostic_id', 'source_utf16_units', 'source_utf8_bytes', 'provider_utf16_units', 'provider_utf8_bytes', 'result_utf16_units', 'result_utf8_bytes', 'provider_http_status', 'provider_status', 'max_output_tokens', 'finish_reason', 'code', 'http_status', 'status', 'failure_stage']);
  for (const trace of traces(h)) for (const key of Object.keys(trace)) assert.ok(allowed.has(key), key);
}

test('optional valid diagnostic UUID correlates body/header/log without replacing the credit request ID', async () => {
  const h = harness();
  const { res, body } = await h.request({ diagnosticId: uuid, diagnosticTrace: true });
  assert.equal(body.diagnostic_id, uuid);
  assert.equal(res.headers.get('X-Kingboard-Diagnostic-ID'), uuid);
  assert.equal(traces(h).length, 1);
  assert.equal(traces(h)[0].diagnostic_id, uuid);
  assert.equal(h.calls.consume[0][2], `credit-${secret}`);
  assert.equal(body.log, undefined);
  assertPrivate(h);
});

test('invalid diagnostic IDs are replaced, never reflected or logged', async () => {
  for (const diagnosticId of [undefined, null, 1, {}, secret, `${uuid}\n${secret}`, '12345678-1234-0abc-8def-123456789abc', '12345678-1234-4abc-0def-123456789abc']) {
    const h = harness();
    const { body } = await h.request({ diagnosticId, diagnosticTrace: true });
    assert.match(body.diagnostic_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assertPrivate(h);
  }
});

test('uppercase valid UUID is accepted without normalizing the correlation value', async () => {
  const h = harness();
  assert.equal((await h.request({ diagnosticId: uuid.toUpperCase() })).body.diagnostic_id, uuid.toUpperCase());
});

test('normal successes and non-boolean opt-ins add zero trace logs', async () => {
  for (const diagnosticTrace of [undefined, false, 'true', 1, {}, null]) {
    const h = harness();
    assert.equal((await h.request({ diagnosticTrace })).res.status, 200);
    assert.equal(h.calls.logs.length, 0);
  }
});

test('trace authorization precedes all extra count logging; unauthenticated previews are excluded', async () => {
  const denied = harness({ walletError: true });
  const { res } = await denied.request({ diagnosticTrace: true });
  assert.equal(res.status, 401);
  assert.equal(traces(denied).length, 0);
  assert.equal(denied.calls.fetch.length, 0);
  const legacy = harness();
  assert.equal((await legacy.request({ diagnosticTrace: true, requestId: undefined })).res.status, 409);
  assert.equal(traces(legacy).length, 0);
  const preview = harness({ payload: { status: 'completed', output_text: secret } });
  assert.equal((await preview.request({ diagnosticTrace: true, formalLevel: 'custom', preview: true, requestId: undefined, deviceId: undefined })).res.status, 200);
  assert.equal(traces(preview).length, 0);
  assert.equal(preview.calls.consume.length, 0);
});

test('UTF-16 units and UTF-8 bytes are explicit, not mislabeled as Swift grapheme counts', async () => {
  const text = 'A\u{1f600}e\u0301\uac00';
  const h = harness({ payload: complete(` ${text} `) });
  const { body } = await h.request({ text, diagnosticTrace: true });
  const trace = traces(h)[0];
  assert.equal(body.result, text);
  assert.equal(trace.source_utf16_units, 6);
  assert.equal(trace.source_utf8_bytes, 11);
  assert.equal(trace.provider_utf16_units, 8);
  assert.equal(trace.provider_utf8_bytes, 13);
  assert.equal(trace.result_utf16_units, 6);
  assert.equal(trace.result_utf8_bytes, 11);
  assert.equal(trace.provider_status, 'completed');
  assert.equal(trace.finish_reason, 'STOP');
  assert.equal(trace.provider_http_status, 200);
  assert.equal(trace.http_status, 200);
  assert.equal(trace.max_output_tokens, 4096);
});

test('long multipart visible output is not sliced and thought parts are not counted', async () => {
  const first = 'a'.repeat(6000);
  const second = 'b'.repeat(6000);
  const h = harness({ payload: { candidates: [{ finishReason: 'STOP', content: { parts: [
    { text: secret, thought: true }, { text: first }, null, { inlineData: { data: secret } }, { text: second },
  ] } }] } });
  const { body } = await h.request({ diagnosticTrace: true });
  assert.equal(body.result, first + second);
  assert.equal(traces(h)[0].provider_utf16_units, 12000);
  assert.equal(traces(h)[0].result_utf16_units, 12000);
  assertPrivate(h);
});

test('final counts follow existing post-processing, not raw provider output', async () => {
  const h = harness({ payload: complete('\ubd88\uc54c') });
  const { body } = await h.request({ text: '\ubd80\ub77c\ub9ac', diagnosticTrace: true });
  assert.equal(body.result, '\ubd80\ub77c\ub9ac');
  assert.equal(traces(h)[0].provider_utf16_units, 2);
  assert.equal(traces(h)[0].result_utf16_units, 3);
});

for (const reason of ['MAX_TOKENS', 'SAFETY', 'RECITATION', undefined, secret]) {
  test(`incomplete finish category ${reason === secret ? 'untrusted' : reason ?? 'missing'} rejects, counts partial output, and refunds once`, async () => {
    const h = harness({ payload: { candidates: [{ finishReason: reason, content: { parts: [{ text: secret }] } }] } });
    const { res, body } = await h.request({ diagnosticTrace: true, diagnosticId: uuid, requestId: uuid });
    assert.equal(res.status, 500);
    assert.equal(body.result, undefined);
    assert.equal(body.diagnostic_id, uuid);
    assert.equal(h.calls.fetch.length, 1);
    assert.equal(h.calls.consume.length, 1);
    assert.equal(h.calls.refund.length, 1);
    assert.equal(h.calls.consume[0][2], uuid);
    assert.equal(h.calls.refund[0][2], uuid);
    const trace = traces(h)[0];
    assert.equal(trace.finish_reason, reason === secret ? 'OTHER' : reason ?? 'MISSING');
    assert.equal(trace.code, 'AI_INCOMPLETE_RESPONSE');
    assert.equal(trace.provider_utf16_units, secret.length);
    assert.equal(trace.result_utf16_units, 0);
    assert.equal(trace.http_status, 500);
    assertPrivate(h);
  });
}

test('incomplete response without diagnostic opt-in still rejects, with no new trace', async () => {
  const h = harness({ payload: { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: secret }] } }] } });
  assert.equal((await h.request()).res.status, 500);
  assert.equal(traces(h).length, 0);
  assertPrivate(h);
});

test('empty or missing visible output fails closed', async () => {
  for (const parts of [undefined, {}, [], [{ text: secret, thought: true }], [{ text: ' \n ' }]]) {
    const h = harness({ payload: { candidates: [{ finishReason: 'STOP', content: { parts } }] } });
    assert.equal((await h.request({ diagnosticTrace: true })).res.status, 500);
    assert.equal(traces(h)[0].provider_status, 'empty');
    assert.equal(h.calls.refund.length, 1);
    assertPrivate(h);
  }
});

test('provider HTTP errors keep the existing two attempts and never log the provider message', async () => {
  for (const httpStatus of [400, 429, 503]) {
    const h = harness({ payload: { error: { message: secret } }, httpStatus });
    assert.equal((await h.request({ diagnosticTrace: true })).res.status, 500);
    assert.equal(h.calls.fetch.length, httpStatus === 400 ? 1 : 2);
    assert.equal(traces(h)[0].provider_http_status, httpStatus);
    assert.equal(traces(h)[0].provider_status, 'http_error');
    assert.equal(traces(h)[0].provider_utf16_units, null);
    assert.equal(h.calls.refund.length, 1);
    assertPrivate(h);
  }
});

test('network and malformed JSON errors are categorical and never log exception content', async () => {
  for (const options of [{ fetchError: true }, { payload: secret }]) {
    const h = harness(options);
    assert.equal((await h.request({ diagnosticTrace: true })).res.status, 500);
    assert.equal(traces(h)[0].provider_status, options.fetchError ? 'network_error' : 'invalid_response');
    assert.equal(h.calls.refund.length, 1);
    assertPrivate(h);
  }
});

test('insufficient credits stop before provider; authorized trace has unknown provider lengths, not invented zeros', async () => {
  const h = harness({ accepted: false });
  assert.equal((await h.request({ diagnosticTrace: true })).res.status, 429);
  assert.equal(h.calls.fetch.length, 0);
  assert.equal(h.calls.refund.length, 0);
  const trace = traces(h)[0];
  assert.equal(trace.provider_utf16_units, null);
  assert.equal(trace.provider_status, 'not_called');
  assert.equal(trace.http_status, 429);
  assertPrivate(h);
});

test('duplicate credit requests are not refunded again; refund errors remain categorical', async () => {
  for (const options of [{ alreadyProcessed: true }, { refundError: true }]) {
    const h = harness({ ...options, payload: { candidates: [{ finishReason: 'MAX_TOKENS' }] } });
    assert.equal((await h.request({ diagnosticTrace: true })).res.status, 500);
    assert.equal(h.calls.refund.length, options.alreadyProcessed ? 0 : 1);
    if (options.refundError) assert.ok(h.calls.logs.some((args) => args[1]?.code === 'AI_CREDIT_REFUND_FAILED'));
    assertPrivate(h);
  }
});

test('custom completed/incomplete output keeps its 4000 budget and categorical private counts', async () => {
  for (const status of ['completed', 'incomplete']) {
    const h = harness({ payload: { status, output: [{ type: 'message', content: [{ type: 'output_text', text: secret }, { type: 'output_text', text: 'tail' }] }], incomplete_details: { reason: secret } } });
    const { res, body } = await h.request({ diagnosticTrace: true, formalLevel: 'custom' });
    assert.equal(res.status, status === 'completed' ? 200 : 500);
    assert.equal(traces(h)[0].provider_status, status);
    assert.equal(traces(h)[0].max_output_tokens, 4000);
    assert.equal(traces(h)[0].provider_utf16_units, secret.length + 4);
    assert.equal(body.result, status === 'completed' ? secret + 'tail' : undefined);
    assert.equal(h.calls.refund.length, status === 'completed' ? 0 : 1);
    assertPrivate(h);
  }
});

test('verified live custom missing-status success is reproduced; candidate rejects with an identical provider request', async () => {
  const code = readFileSync(new URL('../live-functions/correct/correct/index.ts', import.meta.url), 'utf8');
  const before = harness({ code, payload: { output_text: secret } });
  const after = harness({ payload: { output_text: secret } });
  assert.equal((await before.request({ formalLevel: 'custom' })).body.result, secret);
  assert.equal((await after.request({ formalLevel: 'custom' })).res.status, 500);
  assert.deepEqual(after.calls.fetch, before.calls.fetch);
  assert.equal(before.calls.refund.length, 0);
  assert.equal(after.calls.refund.length, 1);
  assertPrivate(before);
  assertPrivate(after);
});

for (const status of [undefined, 'in_progress', 'incomplete', 'failed']) {
  test(`custom ${status ?? 'missing status'} with content rejects and refunds using the original request ID`, async () => {
    for (const content of [
      { output_text: secret },
      { output: [{ type: 'message', content: [{ type: 'output_text', text: secret }] }] },
    ]) {
      const h = harness({ payload: { status, ...content, error: { message: secret }, incomplete_details: { reason: secret } } });
      const { res, body } = await h.request({ formalLevel: 'custom', diagnosticId: uuid, diagnosticTrace: true });
      assert.equal(res.status, 500);
      assert.equal(body.result, undefined);
      assert.equal(body.diagnostic_id, uuid);
      assert.equal(h.calls.fetch.length, 1);
      assert.equal(h.calls.consume.length, 1);
      assert.equal(h.calls.consume[0][2], `credit-${secret}`);
      assert.equal(h.calls.refund.length, 1);
      assert.equal(h.calls.refund[0][1], h.calls.consume[0][1]);
      assert.equal(h.calls.refund[0][2], h.calls.consume[0][2]);
      const trace = traces(h)[0];
      assert.equal(trace.code, 'AI_INCOMPLETE_RESPONSE');
      assert.equal(trace.provider_status, status === undefined ? 'missing_status' : 'incomplete');
      assert.equal(trace.provider_http_status, 200);
      assert.equal(trace.http_status, 500);
      assert.equal(trace.provider_utf16_units, secret.length);
      assert.equal(trace.result_utf16_units, 0);
      assert.equal(trace.result_utf8_bytes, 0);
      assertPrivate(h);
    }
  });
}

test('custom missing status preserves duplicate-refund protection and requires no trace opt-in to reject', async () => {
  for (const alreadyProcessed of [false, true]) {
    const h = harness({ alreadyProcessed, payload: { output_text: secret } });
    const { res, body } = await h.request({ formalLevel: 'custom' });
    assert.equal(res.status, 500);
    assert.equal(body.result, undefined);
    assert.equal(h.calls.fetch.length, 1);
    assert.equal(h.calls.refund.length, alreadyProcessed ? 0 : 1);
    assert.equal(traces(h).length, 0);
    assertPrivate(h);
  }
});

test('custom network failure is network_error, with one provider attempt and the original refund path', async () => {
  const h = harness({ fetchError: true });
  const { res, body } = await h.request({ formalLevel: 'custom', diagnosticTrace: true });
  assert.equal(res.status, 500);
  assert.equal(body.result, undefined);
  assert.equal(h.calls.fetch.length, 1);
  assert.equal(h.calls.refund.length, 1);
  assert.equal(h.calls.refund[0][2], h.calls.consume[0][2]);
  const trace = traces(h)[0];
  assert.equal(trace.provider_status, 'network_error');
  assert.equal(trace.provider_http_status, null);
  assert.equal(trace.provider_utf16_units, null);
  assert.equal(trace.provider_utf8_bytes, null);
  assert.equal(trace.result_utf16_units, 0);
  assert.equal(trace.http_status, 500);
  assertPrivate(h);
});

test('spelling does not acquire tone traces even with opt-in', async () => {
  const h = harness({ payload: complete(secret) });
  assert.equal((await h.request({ diagnosticTrace: true, formalMode: false })).res.status, 200);
  assert.equal(traces(h).length, 0);
});
