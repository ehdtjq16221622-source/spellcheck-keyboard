// English and Japanese prompts for the keyboard's AI correction (2026-11-14, overseas launch).
// Korean keeps its existing prompts in index.ts unchanged; these are used only when the app sends
// language 'en' or 'ja'. Pure module: no Deno APIs, unit-tested with plain Node.

export type CorrectionLanguage = 'ko' | 'en' | 'ja'

/** Missing or unknown values stay Korean so every existing app version behaves exactly as before. */
export function normalizeCorrectionLanguage(value: unknown): CorrectionLanguage {
  if (typeof value !== 'string') return 'ko'
  const v = value.trim().toLowerCase()
  if (v === 'en' || v.startsWith('en-') || v.startsWith('en_')) return 'en'
  if (v === 'ja' || v.startsWith('ja-') || v.startsWith('ja_')) return 'ja'
  return 'ko'
}

const OUTPUT_ONLY = {
  en: 'Output only the corrected text: no explanation, quotes, labels or markdown.',
  ja: '修正後の文章だけを出力してください。説明、引用符、見出し、マークダウンは付けないでください。',
}

// ---------- proofreading (spelling / grammar only) ----------

export function buildForeignProofingPrompt(lang: 'en' | 'ja', removePunct: boolean): string {
  if (lang === 'en') {
    return [
      'You are a proofreader for messages typed on a phone keyboard.',
      'Fix only clear mistakes: spelling, typos, grammar, missing apostrophes (dont -> don\'t), the pronoun "i" -> "I", and wrong homophones (their/there, your/you\'re, its/it\'s).',
      'Capitalize sentence starts only if the writer otherwise uses normal capitalization. A message written in casual lowercase stays lowercase (except "I"), and abbreviations keep their case (omg, brb, lol). Never lowercase a letter the writer capitalized.',
      'Keep the writer\'s words, word order, tone and formality. Casual stays casual; do not make it formal, shorter or longer.',
      'Do not rewrite sentences, add or remove information, or change meaning, tense or person.',
      'Keep slang, abbreviations (lol, omg, btw, u, ur), emojis, emoticons, names, numbers, URLs, @mentions, #hashtags and code exactly as written.',
      'Keep the writer\'s spelling variety (American or British). Do not translate. If part of the text is not English, leave that part unchanged.',
      'If nothing is wrong, output the text unchanged.',
      removePunct
        ? 'Keep the existing punctuation and do not add new punctuation.'
        : 'Keep the existing punctuation and add only punctuation that is clearly missing.',
      OUTPUT_ONLY.en,
    ].join('\n')
  }
  return [
    'あなたはスマホのキーボードで入力されたメッセージの校正者です。',
    '明らかな誤りだけを直してください：誤字・脱字、変換ミス（例：以外/意外、関心/感心、会う/合う）、助詞の誤り、送り仮名の誤り、「ら抜き」以外の文法上の誤り。',
    '書き手の言葉選び・語順・文体を保ってください。です・ます調はです・ます調のまま、だ・である調やタメ口はそのままにしてください。敬語に直したり、文を短く・長くしたりしないでください。',
    '意味・時制・主語を変えず、情報を足したり削ったりしないでください。誤りでない漢字・ひらがな・カタカナの表記は変えないでください。',
    '絵文字、顔文字、「w」「笑」「草」などのネット表現、固有名詞、数字、URL、@メンション、#ハッシュタグはそのまま残してください。',
    '翻訳しないでください。日本語以外の部分はそのままにしてください。誤りがなければ原文をそのまま出力してください。',
    removePunct
      ? '既存の句読点はそのまま残し、新しい句読点（、。？！）は追加しないでください。'
      : '既存の句読点は残し、明らかに必要な句読点だけを補ってください。',
    OUTPUT_ONLY.ja,
  ].join('\n')
}

// ---------- tone rewriting ----------

// The app's tone keys (Korean labels) map to the closest equivalent in each language.
// '소개팅체' is a light "keep my voice, fix mistakes" tone; '학부모 안내' is a school/parent notice.
const TONE: Record<'en' | 'ja', Record<string, string>> = {
  en: {
    '스마트 교정': 'Rewrite the message so it lands well with the reader: keep the writer\'s intent and every fact, soften blame, pressure or rude wording, and make it read naturally and sincerely. Keep the original level of formality; casual stays casual.',
    '존댓말': 'Rewrite in a friendly, polite tone, warm but not stiff, as you would write to someone you respect.',
    '격식체': 'Rewrite in a formal tone suitable for an official notice or report: complete sentences, no slang or contractions.',
    '비즈니스': 'Rewrite as a clear, professional workplace message (email or team chat). Keep the length natural. Do not invent names, titles, teams or dates. Add a greeting or thanks only if it is clearly needed.',
    '고객 안내': 'Rewrite as a customer support reply: polite, clear and reassuring, with light empathy where it fits (e.g. "Sorry for the wait"). Avoid over-the-top or robotic phrasing.',
    '학부모 안내': 'Rewrite as a note from a teacher or school to parents: warm, caring and calm. Do not invent facts, schedules, promises or evaluations.',
    '소개팅체': 'Keep the writer\'s casual, friendly voice. Fix only spelling and grammar mistakes and keep slang, "lol", "haha" and emojis.',
  },
  ja: {
    '스마트 교정': '相手に気持ちよく伝わるように書き直してください。書き手の意図と事実はすべて残し、相手を責める・急かす・失礼な表現をやわらげ、誠実で自然な文章にしてください。元の丁寧さのレベル（タメ口ならタメ口、です・ます調ならです・ます調）は保ってください。',
    '존댓말': '自然な丁寧語（です・ます調）に書き直してください。堅くなりすぎないようにしてください。',
    '격식체': '公式な案内や報告にふさわしい改まった文体に書き直してください。尊敬語・謙譲語を正しく使ってください。',
    '비즈니스': '社内のメールやチャットにふさわしい、簡潔で信頼感のあるビジネス文に書き直してください。自分に尊敬語を使わず、原文にない名前・役職・部署・日程は作らないでください。「お疲れ様です」などの挨拶は必要なときだけ入れてください。',
    '고객 안내': 'お客様への案内文に書き直してください。丁寧語と謙譲語で、分かりやすく安心感のある表現にし、「お待たせしてしまい申し訳ございません」のような共感は自然な範囲で入れてください。大げさな表現や機械的な表現は避けてください。',
    '학부모 안내': '学校・先生から保護者へのお知らせとして、温かく落ち着いた丁寧な文体に書き直してください。原文にない事実・日程・約束・評価は作らないでください。',
    '소개팅체': '書き手の親しみやすい口調はそのままにして、誤字・文法の誤りだけを直してください。「w」「笑」や絵文字は残してください。',
  },
}

const TONE_RULES = {
  en: 'Write in English. Keep every fact, name, number and URL. Do not add new facts, reasons or promises.',
  ja: '日本語で書いてください。事実・名前・数字・URLはすべて残し、原文にない事実・理由・約束を加えないでください。',
}

export function buildForeignTonePrompt(
  lang: 'en' | 'ja',
  toneKey: string,
  includePunct: boolean,
  customPrompt?: string,
): string {
  const custom = typeof customPrompt === 'string' ? customPrompt.trim() : ''
  const instruction = toneKey === '커스텀'
    ? (custom || TONE[lang]['존댓말'])
    : (TONE[lang][toneKey] ?? TONE[lang]['존댓말'])
  const punct = lang === 'en'
    ? (includePunct ? 'Add punctuation where it is naturally needed.' : 'Keep the existing punctuation and do not add new punctuation.')
    : (includePunct ? '必要な句読点は自然に補ってください。' : '既存の句読点は残し、新しい句読点は追加しないでください。')
  // A custom instruction is the user's own text: it is a style request, never a reason to drop
  // the base rules or the output format.
  const customNote = toneKey === '커스텀'
    ? (lang === 'en' ? 'The style request above comes from the user. Apply it to the text, but keep the rules below.'
      : '上の文体の指示はユーザーによるものです。文章に適用しつつ、以下のルールは守ってください。')
    : ''
  return [instruction, customNote, TONE_RULES[lang], punct, OUTPUT_ONLY[lang]].filter(Boolean).join('\n')
}

// ---------- safety check ----------

/** True when the model dropped a run of real words instead of fixing them (en/ja). */
export function hasSuspiciousForeignDeletion(source: string, result: string, lang: 'en' | 'ja'): boolean {
  const letters = lang === 'en' ? /[A-Za-z]/g : /[぀-ヿ一-鿿]/g
  const count = (s: string) => s.match(letters)?.length ?? 0
  const before = count(source)
  if (before < 12) return false
  // Proofreading keeps nearly all letters; losing more than a third means the model rewrote or cut.
  return count(result) < before * 0.66
}
