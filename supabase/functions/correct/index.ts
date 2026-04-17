import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { checkAndDeduct } from '../_shared/credits.ts'
import {
  UserFacingError,
  assertMeaningfulText,
  enforceRateLimit,
  fetchWithTimeoutRetry,
  requireNonEmptyText,
  requireTextDeviceId,
} from '../_shared/usage_guard.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const {
      text,
      formalMode,
      removePunct,
      includePunct,
      includeDialect,
      formalLevel,
      formalIncludePunct,
      deviceId,
    } = await req.json()

    const normalizedText = requireNonEmptyText(text, '교정할 문장')
    const normalizedDeviceId = requireTextDeviceId(deviceId)
    assertMeaningfulText(normalizedText, 2)

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    const rateLimit = await enforceRateLimit(supabase, 'correct', normalizedDeviceId, 20, 60_000)
    if (!rateLimit.allowed) {
      return new Response(
        JSON.stringify({
          error: 'RATE_LIMITED',
          message: '교정 요청이 잠시 많아요. 잠시 후 다시 시도해 주세요.',
          reset_at: rateLimit.resetAt,
        }),
        { status: 429, headers: { ...cors, 'Content-Type': 'application/json' } },
      )
    }

    const cost = formalMode ? 30 : 10
    const credit = await checkAndDeduct(supabase, normalizedDeviceId, cost)

    if (!credit.allowed) {
      return new Response(
        JSON.stringify({
          error: 'NO_CREDITS',
          remaining: credit.snapshot.remaining,
          free_credits_remaining: credit.snapshot.freeCredits,
          paid_credits_remaining: credit.snapshot.paidCredits,
          credits_remaining: credit.snapshot.remaining,
        }),
        { status: 429, headers: { ...cors, 'Content-Type': 'application/json' } },
      )
    }

    const normalizedFormalLevel = normalizeFormalLevel(formalLevel ?? '')
    const shouldRemovePunct =
      typeof removePunct === 'boolean'
        ? removePunct
        : formalMode
          ? formalIncludePunct === false
          : includePunct === false

    const { result, fallback } = await callGPT(
      normalizedText,
      formalMode,
      shouldRemovePunct,
      includeDialect ?? false,
      normalizedFormalLevel,
    )

    return new Response(
      JSON.stringify({
        result,
        fallback: fallback ?? false,
        free_credits_remaining: credit.snapshot.freeCredits,
        paid_credits_remaining: credit.snapshot.paidCredits,
        credits_remaining: credit.snapshot.remaining,
      }),
      { headers: { ...cors, 'Content-Type': 'application/json' } },
    )
  } catch (e) {
    if (e instanceof UserFacingError) {
      return new Response(
        JSON.stringify({ error: e.message }),
        { status: e.status, headers: { ...cors, 'Content-Type': 'application/json' } },
      )
    }

    return new Response(
      JSON.stringify({ error: String(e) }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } },
    )
  }
})

function buildSystemPrompt(
  formalMode: boolean,
  removePunct: boolean,
  includeDialect: boolean,
  formalLevel: string,
): string {
  let system =
    '당신은 한국어 맞춤법과 문장 흐름을 다듬는 교정기입니다. ' +
    '입력된 문장을 자연스럽고 정확하게 다듬고 결과 문장만 출력하세요. ' +
    '설명, 머리말, 인사말, 불필요한 메모를 붙이지 마세요.'

  if (removePunct) {
    system += ' 마침표, 쉼표, 물음표 같은 구두점을 새로 추가하지 말고, 기존 구두점도 제거하세요.'
  }

  if (!includeDialect) {
    system += ' 사투리나 구어체를 표준어로 과하게 바꾸지 말고, 문법적으로 어색한 부분만 정리하세요.'
  }

  if (!formalMode) {
    return system
  }

  const modePrompt: Record<string, string> = {
    존댓말:
      '부드러운 존댓말로 바꿔주세요. 지나치게 딱딱하지 않게, 자연스러운 -요체를 우선 사용하세요.',
    격식체:
      '격식 있는 문체로 바꿔주세요. 공문이나 보고서에 어울리는 -습니다체를 사용하세요.',
    비즈니스:
      '사내 메시지 톤으로 바꿔주세요. 업무적으로 자연스럽고 명확하게 정리하되, 길이를 임의로 줄이지 마세요. ' +
      '없는 이름, 직함, 부서명, 일정 같은 정보를 새로 만들지 마세요. ' +
      '과한 인사말이나 감사 표현은 꼭 필요할 때만 넣으세요. ' +
      '반드시 원문의 행위자와 방향을 유지하세요. 내가 한다는 내용은 내가 한다고, 상대방이 한다는 내용은 상대방이 한다고 그대로 쓰세요.',
    '고객 안내':
      '고객 안내 톤으로 바꿔주세요. 정중하고 분명하게 안내하되, 배려와 공감 표현을 사용해도 좋습니다. ' +
      '다만 과한 감정 표현이나 과장, AI스러운 문장은 피하세요.',
    '학부모 안내':
      '학부모에게 보내는 안내 문자처럼 따뜻하고 정중한 어투로 바꿔주세요. ' +
      '전달 내용은 명확히 하되, 보호자를 배려하는 따뜻한 마음이 느껴지도록 표현하세요. ' +
      '없는 사실이나 일정, 조건을 새로 만들어내지 마세요.',
    소개팅체:
      '친구에게 보내는 카톡처럼 자연스럽고 편한 존댓말로 바꿔주세요. ' +
      '지나치게 가볍거나 오해를 살 표현은 피하고, 실제 대화체를 부드럽게 다듬으세요.',
  }

  system += ` ${modePrompt[formalLevel] ?? '자연스럽고 읽기 좋은 존댓말 문장으로 다듬어주세요.'}`
  return system
}

async function callGPT(
  text: string,
  formalMode: boolean,
  removePunct: boolean,
  includeDialect: boolean,
  formalLevel: string,
): Promise<{ result: string; fallback: boolean }> {
  const system = buildSystemPrompt(
    formalMode,
    removePunct,
    includeDialect,
    formalLevel,
  )

  try {
    const res = await fetchWithTimeoutRetry(
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${Deno.env.get('OPENAI_API_KEY')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: text },
          ],
          temperature: 0.35,
          max_tokens: 1000,
        }),
      },
      8000,
      1,
    )

    const data = await res.json()
    if (!res.ok) throw new Error(data.error?.message ?? '교정 실패')
    return { result: data.choices[0].message.content.trim(), fallback: false }
  } catch (e) {
    const message = String(e)
    if (message.includes('timeout') || message.toLowerCase().includes('abort')) {
      return { result: text, fallback: true }
    }
    throw new UserFacingError('교정 서버 응답이 지연되고 있어요. 잠시 후 다시 시도해 주세요.', 503)
  }
}

function normalizeFormalLevel(value: string): string {
  if (value.includes('격')) return '격식체'
  if (value.includes('비즈') || value.includes('사내') || value.includes('회사')) return '비즈니스'
  if (value.includes('고객')) return '고객 안내'
  if (value.includes('공문') || value.includes('학부모')) return '학부모 안내'
  if (value.includes('친근') || value.includes('소개팅')) return '소개팅체'
  return '존댓말'
}
