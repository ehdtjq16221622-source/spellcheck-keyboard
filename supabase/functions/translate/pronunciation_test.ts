import {
  japanesePronunciationGuidance,
  normalizeJapanesePronunciationScript,
  pronunciationFieldName,
  pronunciationResponseFields,
} from './pronunciation.ts'

Deno.test('Japanese targets accept the three explicit scripts and use the neutral model field', () => {
  for (const script of ['hangul', 'kana', 'romaji'] as const) {
    if (normalizeJapanesePronunciationScript('ja', script) !== script) throw new Error(`did not accept ${script}`)
    if (pronunciationFieldName('ko', script) !== 'pronunciation') throw new Error(`${script} must use pronunciation`)
    const fields = pronunciationResponseFields('읽는 법', 'ko', script)
    if (fields.pronunciation !== '읽는 법' || fields.pronunciation_script !== script) {
      throw new Error(`${script} response fields are incorrect`)
    }
    if ((fields.pronunciation_ko === '읽는 법') !== (script === 'hangul')) {
      throw new Error(`${script} legacy Korean field is incorrect`)
    }
    const guidance = japanesePronunciationGuidance(script)
    if (!guidance.instruction.includes('문장 수') || !guidance.instruction.includes('문장부호(。、？！)')) {
      throw new Error(`${script} prompt must preserve sentence count and punctuation`)
    }
  }
})

Deno.test('non-Japanese targets ignore the script and keep the reader-language field', () => {
  if (normalizeJapanesePronunciationScript('ko', 'kana') !== null) throw new Error('non-Japanese target accepted kana')
  if (pronunciationFieldName('ko', null) !== 'pronunciation_ko') throw new Error('Korean fallback field changed')
  if (pronunciationFieldName('en', null) !== 'pronunciation') throw new Error('non-Korean fallback field changed')
})

Deno.test('missing and invalid Japanese scripts use the existing app-language behavior', () => {
  for (const value of [undefined, null, 'katakana', 12, {}]) {
    if (normalizeJapanesePronunciationScript('ja', value) !== null) throw new Error(`invalid value accepted: ${String(value)}`)
  }
  if (pronunciationFieldName('ko', null) !== 'pronunciation_ko') throw new Error('missing script changed the Korean fallback')
  if (!japanesePronunciationGuidance('kana').instruction.includes('히라가나')) throw new Error('kana guidance missing')
  if (!japanesePronunciationGuidance('romaji').instruction.includes('ō/ū')) throw new Error('macron guidance missing')
})
