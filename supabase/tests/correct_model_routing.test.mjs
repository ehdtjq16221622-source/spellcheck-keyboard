import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = readFileSync(new URL('../functions/correct/index.ts', import.meta.url), 'utf8');
const runnable = stripTypeScriptTypes(source
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
      : { candidates: [{ content: { parts: [{ text: 'gemini result' }] } }] };
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
    body: JSON.stringify({ text: '이렇게 하면 되겠어.', formalMode: true, formalLevel: 'smart' }),
  }));
  const result = await response.json();

  assert.equal(result.result, 'gemini result');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /gemini-3\.1-flash-lite/);
  assert.match(calls[0].body.system_instruction.parts[0].text, /문장 종결형과 높임 단계를 원문에 맞춰 유지하라/);
});

test('custom tone uses Luna low with a bounded stateless Responses request', async () => {
  const { handler, calls } = await createHandler();
  const response = await handler(new Request('http://localhost/correct', {
    method: 'POST',
    body: JSON.stringify({
      text: '오늘 안으로 보내줘.',
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
      body: JSON.stringify({ text: '오늘은 날씨가 정말 좋고 산책을 가고 싶습니다.' }),
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
  const response = await handler(new Request('http://localhost/correct', {
    method: 'POST',
    body: JSON.stringify({
      text: '맞춤법을 고쳐줘',
      deviceId: 'test-device',
      requestId: 'test-request-id',
    }),
  }));
  const result = await response.json();

  assert.equal(response.status, 429);
  assert.equal(result.error, 'NO_CREDITS');
  assert.equal(result.credits_remaining, 0);
  assertDiagnostic(response, result, 'credit_precharge');
});
