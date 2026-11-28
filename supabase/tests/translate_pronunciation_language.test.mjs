import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

// The pronunciation line follows the reader's language (the app sends pronunciationLang).
// Older apps send nothing and must get exactly what they get today: Hangul in pronunciation_ko.
const source = readFileSync(new URL('../functions/translate/index.ts', import.meta.url), 'utf8');
const deadlineSource = readFileSync(new URL('../functions/translate/_shared/ai_deadline.ts', import.meta.url), 'utf8').replace(/^export /gm, '');
const pronunciationSource = readFileSync(new URL('../functions/translate/pronunciation.ts', import.meta.url), 'utf8').replace(/^export /gm, '');
const wordsSource = readFileSync(new URL('../functions/translate/words.ts', import.meta.url), 'utf8').replace(/^export /gm, '');
const runnable = stripTypeScriptTypes(deadlineSource + '\n' + pronunciationSource + '\n' + wordsSource + '\n' + source
  .replace(/^import \{ AIRequestDeadline.*$/m, '')
  .replace(/^import \{ createClient \} from .*;?$/m, 'const createClient = globalThis.__createClient;')
  .replace(/^import \{ consumeAIUsage, refundAIUsage, completeAIUsage \} from .*;?$/m,
    'const consumeAIUsage = async () => ({ accepted: true, alreadyProcessed: false }); const refundAIUsage = async () => {}; const completeAIUsage = async () => {};')
  .replace(/^import \{ resolveCreditWallet, WalletAccessError \} from .*;?$/m,
    'const resolveCreditWallet = async () => ({ walletId: "w" }); class WalletAccessError extends Error {}')
  .replace(/^import \{ japanesePronunciationGuidance,[\s\S]*?from '\.\/pronunciation\.ts'$/m, '')
  .replace(/^import \{ validateWords, wordsInstruction, wordsSchema, type TranslationWord \} from '\.\/words\.ts'$/m, ''));

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
  modelOutput = { translation: 'こんにちは', pronunciation_ko: '곤니치와', words: [{ word: 'こんにちは', reading: 'こんにちは', meaning: '안녕하세요' }] };
  const result = await call({ targetLang: 'ja' });
  assert.equal(result.pronunciation_ko, '곤니치와');
  assert.equal(result.pronunciation, undefined);
  assert.deepEqual(request.text.format.schema.required, ['translation', 'pronunciation_ko', 'words']);
  assert.match(request.instructions, /한글로 적으세요/);
});

test('Japanese readers get katakana, English readers romaji, under pronunciation', async () => {
  modelOutput = { translation: '안녕하세요', pronunciation: 'アンニョンハセヨ', words: [{ word: '안녕하세요', reading: '안녕하세요', meaning: 'こんにちは' }] };
  let result = await call({ targetLang: 'ko', pronunciationLang: 'ja' });
  assert.equal(result.pronunciation, 'アンニョンハセヨ');
  assert.equal(result.pronunciation_lang, 'ja');
  assert.equal(result.pronunciation_ko, undefined);
  assert.deepEqual(request.text.format.schema.required, ['translation', 'pronunciation', 'words']);
  assert.match(request.instructions, /가타카나/);

  modelOutput = { translation: 'こんにちは', pronunciation: 'konnichiwa', words: [{ word: 'こんにちは', reading: 'こんにちは', meaning: '안녕하세요' }] };
  result = await call({ targetLang: 'ja', pronunciationLang: 'en' });
  assert.equal(result.pronunciation, 'konnichiwa');
  assert.equal(result.pronunciation_lang, 'en');
  assert.match(request.instructions, /로마자/);
});

test('Japanese translation honors kana, romaji, and hangul scripts independently of word meaning language', async () => {
  const cases = [
    { script: 'kana', pronunciationLang: 'ko', meaning: '차', value: 'こんにちは。お茶を飲みます。', expected: '히라가나', legacy: false },
    { script: 'romaji', pronunciationLang: 'en', meaning: 'tea', value: 'konnichiwa. Ocha o nomimasu.', expected: '헵번식', legacy: false },
    { script: 'hangul', pronunciationLang: 'ko', meaning: '차', value: '곤니치와. 오차오 노미마스.', expected: '한글', legacy: true },
  ];
  for (const item of cases) {
    modelOutput = { translation: 'こんにちは。お茶を飲みます。', pronunciation: item.value,
      words: [{ word: 'お茶', reading: 'おちゃ', meaning: item.meaning }] };
    const result = await call({ targetLang: 'ja', pronunciationLang: item.pronunciationLang, pronunciationScript: item.script });
    assert.equal(result.pronunciation, item.value);
    assert.equal(result.pronunciation_script, item.script);
    assert.equal(result.pronunciation_ko, item.legacy ? item.value : undefined);
    assert.deepEqual(request.text.format.schema.required, ['translation', 'pronunciation', 'words']);
    assert.match(request.instructions, new RegExp(item.expected));
    assert.match(request.instructions, /문장부호\(。、？！\).*문장 수/);
    assert.equal(result.words[0].meaning, item.meaning);
    assert.match(request.instructions, new RegExp(`meaning은 ${item.pronunciationLang === 'en' ? '영어' : item.pronunciationLang === 'ja' ? '일본어' : '한국어'}로 된 짧은 뜻`));
    assert.match(request.instructions, /reading은 읽는 법/);
  }
});

test('non-Japanese targets ignore pronunciationScript and retain the app-language default', async () => {
  modelOutput = { translation: '안녕하세요', pronunciation_ko: '안녕하세요', words: [{ word: '안녕', reading: '안녕', meaning: 'hello' }] };
  const result = await call({ targetLang: 'ko', pronunciationLang: 'ko', pronunciationScript: 'kana' });
  assert.equal(result.pronunciation_ko, undefined);
  assert.equal(result.pronunciation_script, undefined);
  assert.equal(result.pronunciation, undefined);
  assert.deepEqual(request.text.format.schema.required, ['translation', 'pronunciation_ko', 'words']);
  assert.match(request.instructions, /한글로 적으세요/);
});

test('invalid Japanese script keeps the existing reader-language behavior', async () => {
  modelOutput = { translation: 'こんにちは', pronunciation_ko: '곤니치와', words: [{ word: 'こんにちは', reading: 'こんにちは', meaning: '안녕하세요' }] };
  const result = await call({ targetLang: 'ja', pronunciationLang: 'ko', pronunciationScript: 'katakana' });
  assert.equal(result.pronunciation_ko, '곤니치와');
  assert.equal(result.pronunciation_script, undefined);
  assert.equal(result.pronunciation, undefined);
  assert.deepEqual(request.text.format.schema.required, ['translation', 'pronunciation_ko', 'words']);
  assert.match(request.instructions, /한글로 적으세요/);
});

test('no pronunciation line when the translation is already in the reader language', async () => {
  modelOutput = { translation: 'Hello', pronunciation: 'Hello', words: [] };
  const result = await call({ targetLang: 'en', pronunciationLang: 'en' });
  assert.equal(result.pronunciation, undefined);
  modelOutput = { translation: '안녕', pronunciation_ko: '안녕', words: [] };
  assert.equal((await call({ targetLang: 'ko' })).pronunciation_ko, undefined);
});
