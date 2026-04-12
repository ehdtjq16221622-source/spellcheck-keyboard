import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { checkAndDeduct } from '../_shared/credits.ts'

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
      includePunct,
      includeDialect,
      formalLevel,
      formalIncludePunct,
      deviceId,
    } = await req.json()

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const cost = formalMode ? 30 : 10
    const credit = await checkAndDeduct(supabase, deviceId, cost)

    if (!credit.allowed) {
      return new Response(
        JSON.stringify({ error: 'NO_CREDITS', remaining: credit.snapshot.remaining }),
        { status: 429, headers: { ...cors, 'Content-Type': 'application/json' } }
      )
    }

    const result = await callGPT(
      text,
      formalMode,
      includePunct,
      includeDialect,
      formalLevel,
      formalIncludePunct
    )

    return new Response(
      JSON.stringify({
        result,
        free_credits_remaining: credit.snapshot.freeCredits,
        paid_credits_remaining: credit.snapshot.paidCredits,
        credits_remaining: credit.snapshot.remaining,
      }),
      { headers: { ...cors, 'Content-Type': 'application/json' } }
    )
  } catch (e) {
    return new Response(
      JSON.stringify({ error: String(e) }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } }
    )
  }
})

function buildSystemPrompt(
  formalMode: boolean,
  includePunct: boolean,
  includeDialect: boolean,
  formalLevel: string,
  formalIncludePunct: boolean
): string {
  let system =
    '당신은 한국어 맞춤법과 문장 다듬기를 돕는 편집기입니다. ' +
    '입력된 문장의 의미는 유지하고, 결과 문장만 출력하세요. ' +
    '설명, 머리말, 따옴표, 불릿, 메모를 붙이지 마세요.'

  if (!includePunct) {
    system += ' 마침표, 쉼표, 물음표 같은 구두점은 새로 손대지 마세요.'
  }
  if (!includeDialect) {
    system += ' 사투리나 구어체를 억지로 표준어로 바꾸지 말고, 문법적으로 어색한 부분만 정리하세요.'
  }

  if (!formalMode) {
    return system
  }

  if (!formalIncludePunct) {
    system += ' 말투를 바꾸더라도 구두점은 가능하면 유지하세요.'
  }

  const modePrompt: Record<string, string> = {
    '적당한 존댓말':
      '적당한 존댓말로 바꾸세요. 지나치게 딱딱하지 않게, 자연스러운 -요체를 우선하세요.',
    '엄격 격식체':
      '엄격한 격식체로 바꾸세요. 공문이나 보고에 어울리는 -습니다체를 사용하세요.',
    '사내 메시지':
      '사내 메시지 톤으로 바꾸세요. 업무용으로 자연스럽고 신뢰감 있게 정리하되, 길이를 억지로 줄이지 마세요. ' +
      '자기 자신에게 높임말을 쓰지 말고, 원문에 없는 이름·직함·부서명·일정은 만들어내지 마세요. ' +
      '과한 인사말이나 감사말은 꼭 필요할 때만 넣으세요.',
    '고객 응대':
      '고객 응대 톤으로 바꾸세요. 정중하고 분명하게 안내하되, 약한 공감 표현은 허용하세요. ' +
      '예: 기다리셨죠, 불편을 드려 죄송합니다, 걱정되셨을 것 같습니다. ' +
      '다만 과한 감정 표현이나 지나치게 AI 같은 문장은 피하세요.',
    '학부모 안내':
      '학부모 안내 톤으로 바꾸세요. 아이를 세심하게 챙겨주는 느낌이 들도록 따뜻하고 안정적인 표현을 사용하세요. ' +
      '원문 의미 범위 안에서 배려와 관찰의 뉘앙스를 조금 확장해도 됩니다. ' +
      '다만 원문에 없는 구체적 사실, 일정, 약속, 평가를 새로 만들지는 마세요.',
    '소개팅':
      '소개팅 이후 카톡처럼 자연스럽고 단정한 존댓말로 바꾸세요. ' +
      '너무 문어체인 -습니다체보다 부드러운 -요체를 우선하세요. ' +
      'ㅎㅎ, ... 같은 잡음은 정리하되 실제 채팅처럼 읽히게 유지하세요. ' +
      '화자 관점을 뒤집지 말고, 원문에 없는 사과나 감정 고백을 새로 만들지 마세요.',
  }

  system += ` ${modePrompt[formalLevel] ?? '자연스럽고 읽기 좋은 한국어 문장으로 다듬으세요.'}`
  return system
}

async function callGPT(
  text: string,
  formalMode: boolean,
  includePunct: boolean,
  includeDialect: boolean,
  formalLevel: string,
  formalIncludePunct: boolean
): Promise<string> {
  const system = buildSystemPrompt(
    formalMode,
    includePunct,
    includeDialect,
    formalLevel,
    formalIncludePunct
  )

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
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
  })

  const data = await res.json()
  if (!res.ok) throw new Error(data.error?.message ?? '교정 실패')
  return data.choices[0].message.content.trim()
}
