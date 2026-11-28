export type JapanesePronunciationScript = 'hangul' | 'kana' | 'romaji'
export type TranslationReadingLanguage = 'ko' | 'en' | 'ja'

export function normalizeJapanesePronunciationScript(targetLang: string, value: unknown): JapanesePronunciationScript | null {
  if (targetLang !== 'ja') return null
  return value === 'hangul' || value === 'kana' || value === 'romaji' ? value : null
}

export function pronunciationFieldName(readingLanguage: TranslationReadingLanguage,
                                       script: JapanesePronunciationScript | null): 'pronunciation' | 'pronunciation_ko' {
  return script || readingLanguage !== 'ko' ? 'pronunciation' : 'pronunciation_ko'
}

export function japanesePronunciationGuidance(script: JapanesePronunciationScript): { instruction: string; description: string } {
  const punctuation = '번역문의 문장부호(。、？！)와 문장 수를 그대로 유지하세요. 앱이 문장별로 짝지어 표시하므로 문장을 합치거나 나누지 마세요.'
  switch (script) {
    case 'hangul':
      return {
        instruction: `pronunciation에는 일본어 번역문 전체를 한국어 사용자가 소리 내어 읽는 대로 한글로 적으세요. ${punctuation}`,
        description: '일본어 번역문 전체를 한국어식 발음으로 한글 표기. 원문의 문장부호와 문장 수를 그대로 유지',
      }
    case 'kana':
      return {
        instruction: `pronunciation에는 일본어 번역문 전체의 읽기를 적으세요. 한자는 히라가나 읽기로 바꾸고, 가타카나 외래어는 가타카나 그대로 두며, 단어 사이를 띄어 쓰세요. ${punctuation}`,
        description: '일본어 번역문 전체의 읽기. 한자는 히라가나, 가타카나 외래어는 그대로, 단어 사이 공백. 문장부호와 문장 수 유지',
      }
    case 'romaji':
      return {
        instruction: `pronunciation에는 일본어 번역문 전체의 읽기를 헵번식 로마자로 적으세요. 장음은 ō/ū처럼 macron으로 쓰고 단어 사이를 띄어 쓰세요. ${punctuation}`,
        description: '일본어 번역문 전체의 헵번식 로마자 읽기, 장음은 ō/ū 표기, 단어 사이 공백. 문장부호와 문장 수 유지',
      }
  }
}

export function pronunciationResponseFields(
  pronunciation: string | null,
  readingLanguage: TranslationReadingLanguage,
  script: JapanesePronunciationScript,
): Record<string, string> {
  const text = pronunciation ?? ''
  return {
    pronunciation: text,
    pronunciation_script: script,
    ...(readingLanguage === 'ko' && script === 'hangul' ? { pronunciation_ko: text } : {}),
  }
}
