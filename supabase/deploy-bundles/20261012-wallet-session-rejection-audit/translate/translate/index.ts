import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { consumeAIUsage, refundAIUsage } from '../_shared/credits.ts'
import { resolveCreditWallet, WalletAccessError } from '../_shared/wallet_auth.ts'
type TranslationModelResult = {
  translation: string
  pronunciationKo: string | null
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const genericAiErrorMessage = 'AI 응답이 잠시 지연되고 있어요. 조금 후 다시 시도해주세요.'

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const { text, targetLang, deviceId, requestId } = await req.json()
    const serverManagedCredit = typeof deviceId === 'string' && deviceId.length > 0 &&
      typeof requestId === 'string' && requestId.length > 0
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const wallet = await resolveCreditWallet(req, supabase, deviceId)
    if (wallet.authenticated && !serverManagedCredit) {
      throw new WalletAccessError('A request ID is required for wallet credit use.', 400)
    }

    const credits = serverManagedCredit
      ? await consumeAIUsage(supabase, wallet.walletId, requestId, 'translate')
      : null
    if (credits && !credits.accepted) return noCredits(credits)

    let result: TranslationModelResult
    try {
      result = await callLunaTranslation(text, targetLang)
    } catch (error) {
      if (credits && !credits.alreadyProcessed) {
        try {
          await refundAIUsage(supabase, wallet.walletId, requestId)
        } catch (refundError) {
          console.error('[translate] AI credit refund failed', refundError)
        }
      }
      throw error
    }

    return new Response(
      JSON.stringify({
        result: result.translation,
        ...(result.pronunciationKo ? { pronunciation_ko: result.pronunciationKo } : {}),
        ...(credits ? creditSnapshot(credits) : {}),
      }),
      { headers: { ...cors, 'Content-Type': 'application/json' } }
    )
  } catch (e) {
    console.error('[translate]', e)
    if (e instanceof WalletAccessError) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: e.status, headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }
    return new Response(
      JSON.stringify({ error: genericAiErrorMessage }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } }
    )
  }
})

function creditSnapshot(credits: { freeCredits: number; paidCredits: number; remaining: number }) {
  return {
    free_credits_remaining: credits.freeCredits,
    paid_credits_remaining: credits.paidCredits,
    credits_remaining: credits.remaining,
  }
}

function noCredits(credits: { freeCredits: number; paidCredits: number; remaining: number }) {
  return new Response(
    JSON.stringify({ error: 'NO_CREDITS', ...creditSnapshot(credits) }),
    { status: 429, headers: { ...cors, 'Content-Type': 'application/json' } }
  )
}

async function callLunaTranslation(text: string, targetLang: string): Promise<TranslationModelResult> {
  const langNames: Record<string, string> = {
    ko: '한국어', en: '영어', ja: '일본어', zh: '중국어(간체)', 'zh-Hant': '중국어(번체)',
    es: '스페인어', fr: '프랑스어', de: '독일어', it: '이탈리아어', pt: '포르투갈어',
    ru: '러시아어', ar: '아랍어', hi: '힌디어', vi: '베트남어', th: '태국어',
    id: '인도네시아어', ms: '말레이어', tr: '터키어', pl: '폴란드어', nl: '네덜란드어',
    sv: '스웨덴어', el: '그리스어', cs: '체코어', uk: '우크라이나어', he: '히브리어',
    tl: '필리핀어', ro: '루마니아어', hu: '헝가리어', da: '덴마크어', fi: '핀란드어',
  }
  const lang = langNames[targetLang] ?? targetLang
  const instructions = `다음 텍스트를 ${lang}로 자연스럽게 번역하세요. translation에는 번역문만 적으세요. pronunciation_ko에는 번역문을 한국어 사용자가 소리 내어 읽는 그대로 한글로 적으세요(예: こんにちは → 곤니치와, Hello → 헬로). 대상 언어가 한국어일 때만 빈 문자열로 두고, 그 외 언어에서는 pronunciation_ko를 절대 비우지 마세요. 설명은 붙이지 마세요.`

  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${Deno.env.get('OPENAI_API_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-6-luna',
      reasoning: { effort: 'none' },
      max_output_tokens: 4000,
      store: false,
      instructions,
      input: text,
      text: {
        format: {
          type: 'json_schema',
          name: 'kingboard_translation',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              translation: { type: 'string' },
              pronunciation_ko: {
                type: 'string',
                description: '한국어 번역이 아니면 반드시 한글로 적은 번역문 발음',
              },
            },
            required: ['translation', 'pronunciation_ko'],
            additionalProperties: false,
          },
        },
      },
    }),
  })

  const data = await res.json()
  if (!res.ok) throw new Error(data.error?.message ?? '번역 실패')
  if (data.status && data.status !== 'completed') throw new Error('번역 응답이 완료되지 않았습니다.')
  const content = typeof data.output_text === 'string' && data.output_text.trim()
    ? data.output_text
    : (data.output ?? [])
      .filter((item: { type?: string }) => item.type === 'message')
      .flatMap((item: { content?: Array<{ type?: string; text?: string }> }) => item.content ?? [])
      .filter((item: { type?: string }) => item.type === 'output_text')
      .map((item: { text?: string }) => item.text ?? '')
      .join('')
  if (!content.trim()) throw new Error('빈 번역 응답')
  return parseTranslationModelResult(content, targetLang)
}

function parseTranslationModelResult(raw: string, targetLang: string): TranslationModelResult {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  const parsed = JSON.parse(cleaned) as Record<string, unknown>
  const translation = typeof parsed.translation === 'string' ? parsed.translation.trim() : ''
  const pronunciation = typeof parsed.pronunciation_ko === 'string'
    ? parsed.pronunciation_ko.trim()
    : ''
  if (!translation) throw new Error('빈 번역 응답')
  return {
    translation,
    pronunciationKo: targetLang === 'ko' || !pronunciation ? null : pronunciation,
  }
}


