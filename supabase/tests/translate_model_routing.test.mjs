import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = readFileSync(new URL('../functions/translate/index.ts', import.meta.url), 'utf8');
const deadlineSource = readFileSync(new URL('../functions/translate/_shared/ai_deadline.ts', import.meta.url),'utf8').replace(/^export /gm,'');
const runnable = stripTypeScriptTypes(deadlineSource + '\n' + source
  .replace(/^import \{ AIRequestDeadline.*$/m,'')
  .replace(/^import \{ createClient \} from .*;?$/m, 'const createClient = globalThis.__createClient;')
  .replace(/^import \{ consumeAIUsage, refundAIUsage \} from .*;?$/m,
    'const consumeAIUsage = globalThis.__consumeAIUsage; const refundAIUsage = globalThis.__refundAIUsage;')
  .replace(/^import \{ resolveCreditWallet, WalletAccessError \} from .*;?$/m,
    'const resolveCreditWallet = globalThis.__resolveCreditWallet; class WalletAccessError extends Error {}')
  .replace(/^import \{ parseTranslationModelResult, type TranslationModelResult \} from .*;?$/m,
    'const parseTranslationModelResult = globalThis.__parseTranslationModelResult;'));

test('translation uses Luna Responses with structured translation and pronunciation output', async () => {
  let handler;
  let request;
  let responsePayload = {
    status: 'completed',
    output_text: JSON.stringify({ translation: 'こんにちは', pronunciation_ko: '곤니치와' }),
  };
  globalThis.Deno = {
    env: { get: (key) => key === 'OPENAI_API_KEY' ? 'openai-test' : 'test-value' },
    serve: (callback) => { handler = callback; },
  };
  globalThis.__createClient = () => ({});
  globalThis.__consumeAIUsage = async () => ({ accepted: true, alreadyProcessed: false });
  globalThis.__refundAIUsage = async () => {};
  globalThis.__resolveCreditWallet = async () => ({ walletId: 'test-wallet', authenticated: false });
  globalThis.__parseTranslationModelResult = (raw, targetLang) => {
    const parsed = JSON.parse(raw);
    return {
      translation: parsed.translation,
      pronunciationKo: targetLang === 'ko' || !parsed.pronunciation_ko ? null : parsed.pronunciation_ko,
    };
  };
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), body: JSON.parse(init.body) };
    return new Response(JSON.stringify(responsePayload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  await import(`data:text/javascript,${encodeURIComponent(runnable)}#${crypto.randomUUID()}`);

  const response = await handler(new Request('http://localhost/translate', {
    method: 'POST',
    body: JSON.stringify({ deviceId: 'fixture', requestId: 'fixture-request', text: '안녕하세요', targetLang: 'ja' }),
  }));
  const result = await response.json();

  assert.equal(result.result, 'こんにちは');
  assert.equal(result.pronunciation_ko, '곤니치와');
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.body.model, 'gpt-6-luna');
  assert.deepEqual(request.body.reasoning, { effort: 'none' });
  assert.equal(request.body.max_output_tokens, 4000);
  assert.equal(request.body.store, false);
  assert.equal(request.body.input, '안녕하세요');
  assert.equal(request.body.text.format.type, 'json_schema');
  assert.deepEqual(request.body.text.format.schema.required, ['translation', 'pronunciation_ko']);

  responsePayload = {
    status: 'completed',
    output: [{
      type: 'message',
      content: [{
        type: 'output_text',
        text: JSON.stringify({ translation: 'おはよう', pronunciation_ko: '오하요' }),
      }],
    }],
  };
  const rawResponse = await handler(new Request('http://localhost/translate', {
    method: 'POST',
    body: JSON.stringify({ deviceId: 'fixture', requestId: 'fixture-request', text: '좋은 아침', targetLang: 'ja' }),
  }));
  const rawResult = await rawResponse.json();
  assert.equal(rawResult.result, 'おはよう');
  assert.equal(rawResult.pronunciation_ko, '오하요');
});
