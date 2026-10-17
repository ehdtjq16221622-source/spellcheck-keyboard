import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { resolveCreditWallet, WalletAccessError } from '../_shared/wallet_auth.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Expose-Headers': 'X-Kingboard-Diagnostic-ID',
}

type StudyPhrase = {
  id: string
  source_text: string
  translated_text: string
  language_code: string
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const languagePattern = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: '요청을 처리할 수 없어요.' }, 405)

  let diagnosticId = ''
  let stage = 'request_validation'
  try {
    const body = await req.json()
    const { deviceId, requestId, phrases } = body ?? {}
    diagnosticId = typeof requestId === 'string' && uuidPattern.test(requestId) ? requestId : ''
    if (!diagnosticId || !Array.isArray(phrases) || phrases.length < 1 || phrases.length > 10) {
      return json({ error: '학습 자료를 확인한 뒤 다시 시도해주세요.' }, 400, diagnosticId)
    }

    const validated = validatePhrases(phrases)
    if (!validated) return json({ error: '저장한 표현을 확인한 뒤 다시 시도해주세요.' }, 400, diagnosticId)

    stage = 'wallet_authentication'
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    await resolveCreditWallet(req, supabase, deviceId, true)

    stage = 'model_generation'
    const items = await generateDialogues(validated)
    console.log(JSON.stringify({ event: 'language_study_generation', diagnostic_id: diagnosticId, outcome: 'success', item_count: items.length }))
    return json({ diagnostic_id: diagnosticId, items }, 200, diagnosticId)
  } catch (error) {
    const status = error instanceof WalletAccessError ? error.status : 500
    const message = error instanceof WalletAccessError ? error.message : '대화 생성을 완료하지 못했어요. 잠시 후 다시 시도해주세요.'
    console.error(JSON.stringify({ event: 'language_study_generation', diagnostic_id: diagnosticId || undefined, failure_stage: stage, error_class: error instanceof WalletAccessError ? 'wallet_access' : 'generation_failed' }))
    return json({ error: message }, status, diagnosticId)
  }
})

function validatePhrases(value: unknown): StudyPhrase[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) return null
  const ids = new Set<string>()
  const phrases: StudyPhrase[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') return null
    const phrase = item as Record<string, unknown>
    if (typeof phrase.id !== 'string' || !uuidPattern.test(phrase.id) || ids.has(phrase.id) ||
        typeof phrase.source_text !== 'string' || !phrase.source_text.trim() || phrase.source_text.length > 500 ||
        typeof phrase.translated_text !== 'string' || !phrase.translated_text.trim() || phrase.translated_text.length > 500 ||
        typeof phrase.language_code !== 'string' || !languagePattern.test(phrase.language_code)) return null
    ids.add(phrase.id)
    phrases.push({
      id: phrase.id,
      source_text: phrase.source_text.trim(),
      translated_text: phrase.translated_text.trim(),
      language_code: phrase.language_code,
    })
  }
  return phrases
}

async function generateDialogues(phrases: StudyPhrase[]) {
  const apiKey = Deno.env.get('OPENAI_API_KEY')
  if (!apiKey) throw new Error('model_unavailable')

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-6-luna',
      reasoning: { effort: 'none' },
      max_output_tokens: 3000,
      store: false,
      instructions: '각 저장 표현에 대해 짧고 자연스러운 일상 회화의 다음 답변 한 문장을 만들어 주세요. 각 답변은 해당 표현의 language_code와 같은 언어로 작성하세요. reply에는 외국어 문장만, reply_ko에는 그 문장의 한국어 뜻만, pronunciation_ko에는 한국어 화자가 읽기 쉬운 한글 발음만 적으세요. 원문 표현의 의미와 대화 맥락을 유지하고 설명은 덧붙이지 마세요. phrase_id는 입력값을 그대로 사용하세요.',
      input: JSON.stringify(phrases.map(({ id, source_text, translated_text, language_code }) => ({
        phrase_id: id, korean_expression: source_text, saved_translation: translated_text, language_code,
      }))),
      text: {
        format: {
          type: 'json_schema',
          name: 'kingboard_language_study_dialogues',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    phrase_id: { type: 'string' },
                    reply: { type: 'string' },
                    reply_ko: { type: 'string' },
                    pronunciation_ko: { type: 'string' },
                  },
                  required: ['phrase_id', 'reply', 'reply_ko', 'pronunciation_ko'],
                  additionalProperties: false,
                },
              },
            },
            required: ['items'],
            additionalProperties: false,
          },
        },
      },
    }),
  })

  const data = await response.json().catch(() => ({}))
  if (!response.ok || (data.status && data.status !== 'completed')) throw new Error('model_request_failed')
  const outputText = extractOutputText(data)
  if (!outputText.trim()) throw new Error('model_response_empty')
  return validateOutput(outputText, phrases)
}

function extractOutputText(response: Record<string, unknown>): string {
  if (!Array.isArray(response.output)) return ''
  return response.output.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const message = item as Record<string, unknown>
    if (message.type !== 'message' || message.role !== 'assistant' || !Array.isArray(message.content)) return []
    return message.content.flatMap((part) => {
      if (!part || typeof part !== 'object') return []
      const text = part as Record<string, unknown>
      return text.type === 'output_text' && typeof text.text === 'string' ? [text.text] : []
    })
  }).join('')
}

function validateOutput(raw: string, phrases: StudyPhrase[]) {
  const parsed = JSON.parse(raw)
  const items = parsed?.items
  if (!Array.isArray(items) || items.length !== phrases.length) throw new Error('model_response_invalid')
  const expected = new Set(phrases.map((phrase) => phrase.id))
  const seen = new Set<string>()
  const result = items.map((item: Record<string, unknown>) => {
    if (typeof item.phrase_id !== 'string' || !expected.has(item.phrase_id) || seen.has(item.phrase_id) ||
        typeof item.reply !== 'string' || !item.reply.trim() || item.reply.length > 1000 ||
        typeof item.reply_ko !== 'string' || !item.reply_ko.trim() || item.reply_ko.length > 1000 ||
        typeof item.pronunciation_ko !== 'string' || item.pronunciation_ko.length > 1000) {
      throw new Error('model_response_invalid')
    }
    seen.add(item.phrase_id)
    return {
      phrase_id: item.phrase_id,
      reply: item.reply.trim(),
      reply_ko: item.reply_ko.trim(),
      pronunciation_ko: item.pronunciation_ko.trim(),
    }
  })
  if (seen.size !== expected.size) throw new Error('model_response_invalid')
  return result
}

function json(body: unknown, status = 200, diagnosticId = '') {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      'Content-Type': 'application/json',
      ...(diagnosticId ? { 'X-Kingboard-Diagnostic-ID': diagnosticId } : {}),
    },
  })
}
