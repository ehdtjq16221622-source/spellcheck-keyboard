/** Key words of a translation, for learners. Optional everywhere: any problem drops them, never the translation. */
export type TranslationWord = { word: string; reading: string; meaning: string }

export const MAX_WORDS = 4
const MAX_SCANNED = 20 // look past a few bad entries, but never walk an unbounded list
const MAX_WORD_LEN = 40
const MAX_READING_LEN = 60
const MAX_MEANING_LEN = 60

/** Prompt part, appended to the instructions. `readerName` is the reader's language name (e.g. 한국어). */
export function wordsInstruction(readerName: string): string {
  return `words에는 번역문에서 학습자에게 도움이 되는 핵심 단어·표현을 최대 ${MAX_WORDS}개 골라 적으세요. ` +
    `word는 번역문에 나온 그대로의 표기, reading은 읽는 법(일본어는 히라가나, 중국어는 병음, 그 외 언어는 ${readerName} 사용자가 읽는 문자로 적은 발음), ` +
    `meaning은 ${readerName}로 된 짧은 뜻입니다. 조사·대명사·아주 기초적인 단어는 빼고 명사, 동사, 관용구를 우선하세요. ` +
    `대상 언어가 ${readerName}이거나 고를 만한 단어가 없으면 빈 배열로 두세요.`
}

export const wordsSchema = {
  type: 'array',
  description: '번역문의 핵심 단어·표현 (최대 4개)',
  items: {
    type: 'object',
    properties: {
      word: { type: 'string' },
      reading: { type: 'string' },
      meaning: { type: 'string' },
    },
    required: ['word', 'reading', 'meaning'],
    additionalProperties: false,
  },
}

/**
 * Strict validation of the model's `words`. Returns null (omit the field) unless at least one entry is valid.
 * Entries that are not objects, have non-string/empty/over-long parts, are not found in the translation,
 * or repeat an earlier word are dropped. Never throws.
 */
export function validateWords(raw: unknown, translation: string): TranslationWord[] | null {
  try {
    if (!Array.isArray(raw)) return null
    const out: TranslationWord[] = []
    const seen = new Set<string>()
    for (const item of raw.slice(0, MAX_SCANNED)) {
      if (out.length >= MAX_WORDS) break
      if (!item || typeof item !== 'object') continue
      const { word, reading, meaning } = item as Record<string, unknown>
      if (typeof word !== 'string' || typeof reading !== 'string' || typeof meaning !== 'string') continue
      const w = word.trim(), r = reading.trim(), m = meaning.trim()
      if (!w || !r || !m) continue
      if (w.length > MAX_WORD_LEN || r.length > MAX_READING_LEN || m.length > MAX_MEANING_LEN) continue
      if (!translation.includes(w) || seen.has(w)) continue
      seen.add(w)
      out.push({ word: w, reading: r, meaning: m })
    }
    return out.length ? out : null
  } catch {
    return null
  }
}
