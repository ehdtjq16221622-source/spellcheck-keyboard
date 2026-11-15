import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = readFileSync(new URL('../functions/correct/index.ts', import.meta.url), 'utf8');
const deadlineSource = readFileSync(new URL('../functions/correct/_shared/ai_deadline.ts', import.meta.url),'utf8').replace(/^export /gm,'');
const languageSource = readFileSync(new URL('../functions/correct/language_prompts.ts', import.meta.url),'utf8').replace(/^export /gm,'');
const runnable = stripTypeScriptTypes(deadlineSource + '\n' + languageSource + '\n' + source
  .replace(/^import \{ buildForeignProofingPrompt.*$/m,'')
  .replace(/^import \{ AIRequestDeadline.*$/m,'')
  .replace(/^import \{ applyValidatedProofingEdits, parseProofingEdits \} from .*;?$/m,
    'const applyValidatedProofingEdits = globalThis.__applyValidatedProofingEdits; const parseProofingEdits = globalThis.__parseProofingEdits;')
  .replace(/^import \{ createClient \} from .*;?$/m,
    'const createClient = globalThis.__createClient;')
  .replace(/^import \{ consumeAIUsage, refundAIUsage \} from .*;?$/m,
    'const consumeAIUsage = globalThis.__consumeAIUsage; const refundAIUsage = globalThis.__refundAIUsage;')
  .replace(/^import \{ resolveCreditWallet, WalletAccessError \} from .*;?$/m,
    'const resolveCreditWallet = globalThis.__resolveCreditWallet; class WalletAccessError extends Error {}'));

async function createHandler({ consumeResult = { accepted: true, alreadyProcessed: false } } = {}) {
  let handler;
  const calls = [];
  const consumeCalls = [];
  globalThis.Deno = {
    env: { get: (key) => key === 'OPENAI_API_KEY' ? 'openai-test' : 'gemini-test' },
    serve: (callback) => { handler = callback; },
  };
  globalThis.__applyValidatedProofingEdits = (_source, _edits) => ({ result: _source, rejected: [] });
  globalThis.__parseProofingEdits = () => [];
  globalThis.__createClient = () => ({});
  globalThis.__consumeAIUsage = async (...args) => {
    consumeCalls.push(args);
    return consumeResult;
  };
  globalThis.__refundAIUsage = async () => {};
  globalThis.__resolveCreditWallet = async (_request, _client, walletId) => ({ walletId, authenticated: false });
  globalThis.fetch = async (url, init) => {
    const request = { url: String(url), body: JSON.parse(init.body) };
    calls.push(request);
    const body = request.url.includes('api.openai.com')
      ? { status: 'completed', output_text: 'luna result' }
      : { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'gemini result' }] } }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  await import(`data:text/javascript,${encodeURIComponent(runnable)}#${crypto.randomUUID()}`);
  return { handler, calls, consumeCalls };
}

function assertDiagnostic(response, body, stage) {
  assert.match(body.diagnostic_id, /^[0-9a-f-]{36}$/i);
  assert.equal(body.failure_stage, stage);
  assert.equal(response.headers.get('X-Kingboard-Diagnostic-ID'), body.diagnostic_id);
}

test('smart tone keeps Gemini and receives the source ending instruction', async () => {
  const { handler, calls } = await createHandler();
  const response = await handler(new Request('http://localhost/correct', {
    method: 'POST',
    body: JSON.stringify({ deviceId: 'fixture', requestId: 'fixture-request', text: '이렇게 하면 되겠어.', formalMode: true, formalLevel: 'smart' }),
  }));
  const result = await response.json();

  assert.equal(result.result, 'gemini result');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /gemini-3\.1-flash-lite/);
  assert.match(calls[0].body.system_instruction.parts[0].text, /문장 종결형과 높임 단계를 원문에 맞춰 유지하라/);
  assert.doesNotMatch(calls[0].body.system_instruction.parts[0].text, /예외 규칙:|"얼만큼"/);
});

test('custom tone uses Luna low with a bounded stateless Responses request', async () => {
  const { handler, calls } = await createHandler();
  const response = await handler(new Request('http://localhost/correct', {
    method: 'POST',
    body: JSON.stringify({
      deviceId: 'fixture', requestId: 'fixture-request', text: '오늘 안으로 보내줘.',
      formalMode: true,
      formalLevel: 'custom',
      customPrompt: '친구에게 부드럽게 말해줘.',
    }),
  }));
  const result = await response.json();

  assert.equal(result.result, 'luna result');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(calls[0].body.model, 'gpt-6-luna');
  assert.deepEqual(calls[0].body.reasoning, { effort: 'low' });
  assert.equal(calls[0].body.max_output_tokens, 4000);
  assert.equal(calls[0].body.store, false);
  assert.equal(calls[0].body.input, '오늘 안으로 보내줘.');
  assert.match(calls[0].body.instructions, /친구에게 부드럽게 말해줘/);
  assert.doesNotMatch(calls[0].body.instructions, /예외 규칙:|"얼만큼"/);
});

test('proofing safety fallback warning carries the response diagnostic ID', async () => {
  const { handler } = await createHandler();
  let warning;
  const originalWarn = console.warn;
  console.warn = (...args) => { warning = args; };
  globalThis.fetch = async () => new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: '좋습니다.' }] } }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  try {
    const response = await handler(new Request('http://localhost/correct', {
      method: 'POST',
      body: JSON.stringify({ deviceId: 'fixture', requestId: 'fixture-request', text: '오늘은 날씨가 정말 좋고 산책을 가고 싶습니다.' }),
    }));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(warning?.[0], '[correct]');
    assert.equal(warning?.[1]?.diagnostic_id, body.diagnostic_id);
    assert.equal(warning?.[1]?.failure_stage, 'proofing_safety_fallback');
    assert.equal(warning?.[1]?.code, 'SUSPICIOUS_DELETION_FALLBACK');
  } finally {
    console.warn = originalWarn;
  }
});

test('custom preview does not require a wallet or consume credits', async () => {
  const { handler, calls, consumeCalls } = await createHandler();
  const response = await handler(new Request('http://localhost/correct', {
    method: 'POST',
    body: JSON.stringify({
      text: '오늘 안으로 보내줘.',
      formalMode: true,
      formalLevel: 'custom',
      customPrompt: '친구에게 부드럽게 말해줘.',
      preview: true,
    }),
  }));
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.result, 'luna result');
  assert.equal(calls.length, 1);
  assert.equal(consumeCalls.length, 0);
});

test('insufficient-credit responses include a safe diagnostic ID and failure stage', async () => {
  const { handler } = await createHandler({
    consumeResult: { accepted: false, freeCredits: 0, paidCredits: 0, remaining: 0 },
  });
  let warning;
  const originalWarn = console.warn;
  console.warn = (...args) => { warning = args; };
  let response;
  try {
    response = await handler(new Request('http://localhost/correct', {
      method: 'POST',
      body: JSON.stringify({
        text: '맞춤법을 고쳐줘',
        deviceId: 'test-device',
        requestId: 'test-request-id',
      }),
    }));
  } finally {
    console.warn = originalWarn;
  }
  const result = await response.json();

  assert.equal(response.status, 429);
  assert.equal(result.error, 'NO_CREDITS');
  assert.equal(result.credits_remaining, 0);
  assertDiagnostic(response, result, 'credit_precharge');
  const expectedWalletFingerprint = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('test-device'))),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
  assert.equal(warning?.[1]?.diagnostic_id, result.diagnostic_id);
  assert.equal(warning?.[1]?.requested_wallet_fingerprint, expectedWalletFingerprint);
  assert.equal(warning?.[1]?.canonical_wallet_fingerprint, expectedWalletFingerprint);
  assert.equal(warning?.[1]?.free_credits_remaining, 0);
  assert.equal(warning?.[1]?.paid_credits_remaining, 0);
  assert.equal(JSON.stringify(warning).includes('test-device'), false);
  assert.equal(JSON.stringify(warning).includes('test-request-id'), false);
});

// ---- English / Japanese (overseas launch) ----

async function send(body) {
  const ctx = await createHandler();
  const response = await ctx.handler(new Request('http://localhost/correct', { method: 'POST',
    body: JSON.stringify({ deviceId: 'fixture', requestId: 'fixture-request', ...body }) }));
  return { ...ctx, response, result: await response.json() };
}
const systemOf = (call) => call.body.system_instruction?.parts?.[0]?.text ?? call.body.instructions;

test('no language (every current app) keeps the Korean prompts exactly', async () => {
  const korean = await send({ text: 'hello', formalMode: false });
  const explicitKo = await send({ text: 'hello', formalMode: false, language: 'ko' });
  const unknown = await send({ text: 'hello', formalMode: false, language: 'zh' });
  assert.match(systemOf(korean.calls[0]), /한국어 맞춤법 교정기/);
  assert.equal(systemOf(explicitKo.calls[0]), systemOf(korean.calls[0]));
  assert.equal(systemOf(unknown.calls[0]), systemOf(korean.calls[0]));
});

test('English proofreading uses the English prompt on the same low-cost model and credit kind', async () => {
  const r = await send({ text: 'i dont know where there going', formalMode: false, language: 'en-US' });
  // The fake model answers 'gemini result', which is a different text, so the faithfulness guard
  // keeps the original: that is the safe outcome.
  assert.equal(r.result.result, 'i dont know where there going');
  assert.equal(r.calls.length, 1);
  assert.match(r.calls[0].url, /gemini-3\.1-flash-lite/);
  assert.match(systemOf(r.calls[0]), /proofreading tool/);
  assert.equal(r.calls[0].body.contents[0].parts[0].text, '<message>\ni dont know where there going\n</message>',
    'the writer\'s text is sent as tagged data');
  assert.doesNotMatch(systemOf(r.calls[0]), /한국어/);
  assert.equal(r.consumeCalls[0][3], 'correct');
});

test('Japanese tone keys map to Japanese instructions; custom goes to Luna with the user style', async () => {
  const polite = await send({ text: '明日行ける', formalMode: true, formalLevel: 'polite', language: 'ja' });
  assert.match(systemOf(polite.calls[0]), /です・ます調/);
  assert.equal(polite.consumeCalls[0][3], 'formal');
  const business = await send({ text: '明日行ける', formalMode: true, formalLevel: 'business', language: 'ja' });
  assert.match(systemOf(business.calls[0]), /ビジネス文/);
  const custom = await send({ text: 'see you', formalMode: true, formalLevel: 'custom', customPrompt: 'like a pirate', language: 'en' });
  assert.equal(custom.calls[0].url, 'https://api.openai.com/v1/responses');
  assert.match(custom.calls[0].body.instructions, /like a pirate/);
  assert.match(custom.calls[0].body.instructions, /comes from the user/);
  assert.equal(custom.calls[0].body.input, '<message>\nsee you\n</message>');
  assert.equal(business.calls[0].body.contents[0].parts[0].text, '<message>\n明日行ける\n</message>');
});