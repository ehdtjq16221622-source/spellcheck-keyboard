import { assertEquals } from 'jsr:@std/assert@1'
import { MAX_WORDS, validateWords, wordsInstruction } from './words.ts'

const text = '明日の会議に出席します。'
const ok = { word: '会議', reading: 'かいぎ', meaning: '회의' }

Deno.test('missing or non-array words -> null', () => {
  assertEquals(validateWords(undefined, text), null)
  assertEquals(validateWords(null, text), null)
  assertEquals(validateWords('会議', text), null)
  assertEquals(validateWords({ 0: ok }, text), null)
  assertEquals(validateWords([], text), null)
})

Deno.test('valid entries are trimmed and kept', () => {
  assertEquals(validateWords([{ word: ' 会議 ', reading: ' かいぎ ', meaning: ' 회의 ' }], text), [ok])
})

Deno.test('over-long list is cut to 4', () => {
  const t = 'あいうえおかきくけこ'
  const list = [...'あいうえお'].map((c) => ({ word: c, reading: c, meaning: 'x' }))
  assertEquals(list.length > MAX_WORDS, true)
  assertEquals(validateWords(list, t)?.length, MAX_WORDS)
})

Deno.test('word not in the translation is dropped', () => {
  assertEquals(validateWords([{ word: '電話', reading: 'でんわ', meaning: '전화' }, ok], text), [ok])
  assertEquals(validateWords([{ word: '電話', reading: 'でんわ', meaning: '전화' }], text), null)
})

Deno.test('non-string, empty and over-long values are dropped', () => {
  assertEquals(validateWords([
    { word: 1, reading: 'a', meaning: 'b' },
    { word: '会議', reading: null, meaning: '회의' },
    { word: '会議', reading: 'かいぎ', meaning: ['회의'] },
    { word: '会議', reading: '  ', meaning: '회의' },
    { word: '会議', reading: 'かいぎ', meaning: 'x'.repeat(61) },
    'string', null, 5, [],
    ok,
  ], text), [ok])
})

Deno.test('duplicates are dropped', () => {
  assertEquals(validateWords([ok, ok], text), [ok])
})

Deno.test('instruction names the reader language', () => {
  assertEquals(wordsInstruction('한국어').includes('한국어'), true)
})
