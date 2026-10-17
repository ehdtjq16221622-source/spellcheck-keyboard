export type TranslationModelResult = {
  translation: string
  pronunciationKo: string | null
}

export function parseTranslationModelResult(
  raw: string,
  targetLang: string
): TranslationModelResult {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>
    const translation = typeof parsed.translation === 'string' ? parsed.translation.trim() : ''
    const pronunciation = typeof parsed.pronunciation_ko === 'string'
      ? parsed.pronunciation_ko.trim()
      : ''
    if (translation) {
      return {
        translation,
        pronunciationKo: targetLang === 'ko' || !pronunciation ? null : pronunciation,
      }
    }
  } catch {
    // Older or degraded model responses can still be used as plain translations.
  }
  return { translation: cleaned, pronunciationKo: null }
}
