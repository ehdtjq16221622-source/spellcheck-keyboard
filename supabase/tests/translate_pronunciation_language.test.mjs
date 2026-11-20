import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

// The pronunciation line follows the reader's language (the app sends pronunciationLang).
// Older apps send nothing and must get exactly what they get today: Hangul in pronunciation_ko.
const source = readFileSync(new URL('../functions/translate/index.ts', import.meta.url), 'utf8');
const deadlineSource = readFileSync(new URL('../functions/translate/_shared/ai_deadline.ts', import.meta.url), 'utf8').replace(/^export /gm, '');
const runnable = stripTypeScriptTypes(deadlineSource + '\n' + source
  .replace(/^import \{ AIRequestDeadline.*$/m, '')
  .replace(/^import \{ createClient \} from .*;?$/m, 'const createClient = globalThis.__createClient;')
  .replace(/^import \{ consumeAIUsage, refundAIUsage, completeAIUsage \} from .*;?$/m,
    'const consumeAIUsage = async () => ({ accepted: true, alreadyProcessed: false }); const refundAIUsage = async () => {}; const completeAIUsage = async () => {};')
  .replace(/^import \{ resolveCreditWallet, WalletAccessError \} from .*;?$/m,
    'const resolveCreditWallet = async () => ({ walletId: "w" }); class WalletAccessError extends Error {}'));

let handler;
let request;
let modelOutput;
globalThis.Deno = { env: { get: () => 'test-value' }, serve: (callback) => { handler = callback; } };
globalThis.__createClient = () => ({});
globalThis.fetch = async (_url, init) => {
  request = JSON.parse(init.body);
  return new Response(JSON.stringify({ status: 'completed', output_text: JSON.stringify(modelOutput) }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
};
await import(`data:text/javascript,${encodeURIComponent(runnable)}#${crypto.randomUUID()}`);

const call = async (body) => (await handler(new Request('http://localhost/translate', {
  method: 'POST', body: JSON.stringify({ deviceId: 'd', requestId: 'r', text: 'x', ...body }),
}))).json();

test('older apps (no pronunciationLang) keep the Hangul pronunciation_ko request and reply', async () => {
  modelOutput = { translation: 'こんにちは', pronunciation_ko: '곤니치와' };
  const result = await call({ targetLang: 'ja' });
  assert.equal(result.pronunciation_ko, '곤니치와');
  assert.equal(result.pronunciation, undefined);
  assert.deepEqual(request.text.format.schema.required, ['translation', 'pronunciation_ko']);
  assert.match(request.instructions, /한글로 적으세요/);
});

test('Japanese readers get katakana, English readers romaji, under pronunciation', async () => {
  modelOutput = { translation: '안녕하세요', pronunciation: 'アンニョンハセヨ' };
  let result = await call({ targetLang: 'ko', pronunciationLang: 'ja' });
  assert.equal(result.pronunciation, 'アンニョンハセヨ');
  assert.equal(result.pronunciation_lang, 'ja');
  assert.equal(result.pronunciation_ko, undefined);
  assert.deepEqual(request.text.format.schema.required, ['translation', 'pronunciation']);
  assert.match(request.instructions, /가타카나/);

  modelOutput = { translation: 'こんにちは', pronunciation: 'konnichiwa' };
  result = await call({ targetLang: 'ja', pronunciationLang: 'en' });
  assert.equal(result.pronunciation, 'konnichiwa');
  assert.equal(result.pronunciation_lang, 'en');
  assert.match(request.instructions, /로마자/);
});

test('no pronunciation line when the translation is already in the reader language', async () => {
  modelOutput = { translation: 'Hello', pronunciation: 'Hello' };
  const result = await call({ targetLang: 'en', pronunciationLang: 'en' });
  assert.equal(result.pronunciation, undefined);
  modelOutput = { translation: '안녕', pronunciation_ko: '안녕' };
  assert.equal((await call({ targetLang: 'ko' })).pronunciation_ko, undefined);
});
