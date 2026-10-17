import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = readFileSync(
  new URL('../functions/translate/translation_result.ts', import.meta.url),
  'utf8',
);
const parser = await import(
  `data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`
);

test('parses translation and Korean pronunciation from structured output', () => {
  assert.deepEqual(parser.parseTranslationModelResult(JSON.stringify({
    translation: 'こんにちは',
    pronunciation_ko: '곤니치와',
  }), 'ja'), {
    translation: 'こんにちは',
    pronunciationKo: '곤니치와',
  });
});

test('omits pronunciation for Korean translations', () => {
  assert.deepEqual(parser.parseTranslationModelResult(JSON.stringify({
    translation: '안녕하세요',
    pronunciation_ko: '안녕하세요',
  }), 'ko'), {
    translation: '안녕하세요',
    pronunciationKo: null,
  });
});

test('keeps a plain response usable when structured output is unavailable', () => {
  assert.deepEqual(parser.parseTranslationModelResult('```\nHello\n```', 'en'), {
    translation: 'Hello',
    pronunciationKo: null,
  });
});
