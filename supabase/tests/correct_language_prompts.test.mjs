import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const src = stripTypeScriptTypes(readFileSync(new URL('../functions/correct/language_prompts.ts', import.meta.url), 'utf8'));
const m = await import(`data:text/javascript,${encodeURIComponent(src)}`);

test('language values: only en/ja variants switch; everything else stays Korean', () => {
  for (const v of ['en', 'EN', 'en-US', 'en_GB']) assert.equal(m.normalizeCorrectionLanguage(v), 'en');
  for (const v of ['ja', 'ja-JP']) assert.equal(m.normalizeCorrectionLanguage(v), 'ja');
  for (const v of [undefined, null, '', 'ko', 'ko-KR', 'zh', 'english', 7]) assert.equal(m.normalizeCorrectionLanguage(v), 'ko');
});

test('proofreading prompts protect voice, slang and punctuation choice', () => {
  const en = m.buildForeignProofingPrompt('en', true);
  assert.match(en, /Casual stays casual/);
  assert.match(en, /do not add new punctuation/);
  assert.match(m.buildForeignProofingPrompt('en', false), /clearly missing/);
  const ja = m.buildForeignProofingPrompt('ja', false);
  assert.match(ja, /です・ます調はです・ます調のまま/);
  assert.match(ja, /顔文字/);
  for (const p of [en, ja]) assert.doesNotMatch(p, /[가-힣]/, 'no Korean in foreign prompts');
});

test('every app tone key has an English and Japanese instruction', () => {
  for (const key of ['스마트 교정', '존댓말', '격식체', '비즈니스', '고객 안내', '학부모 안내', '소개팅체']) {
    for (const lang of ['en', 'ja']) {
      const p = m.buildForeignTonePrompt(lang, key, true);
      assert.doesNotMatch(p, /[가-힣]/, `${lang} ${key}`);
      assert.notEqual(p, m.buildForeignTonePrompt(lang, '존댓말', true) === p && key !== '존댓말' ? p : null);
    }
  }
  assert.match(m.buildForeignTonePrompt('ja', '격식체', false), /新しい句読点は追加しない/);
  assert.match(m.buildForeignTonePrompt('en', '알수없음', true), /friendly, polite/, 'unknown keys fall back to polite');
});

test('deletion guard: fixes pass, cut text is caught, short text is never judged', () => {
  assert.equal(m.hasSuspiciousForeignDeletion('i dont know where there going tonight', "I don't know where they're going tonight", 'en'), false);
  assert.equal(m.hasSuspiciousForeignDeletion('i dont know where there going tonight', 'I know.', 'en'), true);
  assert.equal(m.hasSuspiciousForeignDeletion('明日の会議は十時からに変更になりました', '明日の会議は十時からに変更になりました。', 'ja'), false);
  assert.equal(m.hasSuspiciousForeignDeletion('明日の会議は十時からに変更になりました', '変更です', 'ja'), true);
  assert.equal(m.hasSuspiciousForeignDeletion('ok', '', 'en'), false);
});