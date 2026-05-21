import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { checkAndDeduct, refundDeductedCredits } from '../_shared/credits.ts'

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

    const normalizedLevel = formalLevel ?? ''
    let result: string
    try {
      result = await callGemini(text, formalMode, removePunct ?? false, includeDialect, normalizedLevel, formalIncludePunct)
    } catch (e) {
      await refundDeductedCredits(supabase, deviceId, credit.deducted)
      throw e
    }

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
    console.error('[correct]', e)
    return new Response(
      JSON.stringify({ error: String(e) }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } }
    )
  }
})

function buildSystemPrompt(
  formalMode: boolean,
  removePunct: boolean,
  includeDialect: boolean,
  formalLevel: string,
  formalIncludePunct: boolean
): string {
  // 말투 교정 모드: 기본 프롬프트 없이 말투 프롬프트만 단독 사용
  if (formalMode) {
    const modePrompt: Record<string, string> = {
      '스마트 교정':
        '너는 한국어 문장을 상황에 맞게 다듬는 전문 편집자다. 원문의 문맥과 핵심 의도를 파악하고, 상대를 탓하거나 압박하는 표현과 무례한 뉘앙스는 완화하라. 관계를 해치거나 오해를 살 수 있는 내용은 포함하지 말고, 화자의 신뢰와 진정성이 잘 전달되도록 원문의 구성 요소를 파악하여 있는 것들만 자연스럽게 흘러가도록 재작성하라. 문맥상 필요하면 짧은 인삿말을 넣고, 최종 결과만 출력하라.',
      '존댓말':
        '적당한 존댓말로 바꾸세요. 지나치게 딱딱하지 않게, 자연스러운 -요체를 우선하세요. 결과 문장만 출력하세요.',
      '격식체':
        '격식 있는 문체로 바꾸세요. 공문이나 보고에 어울리는 -습니다체를 사용하세요. 결과 문장만 출력하세요.',
      '비즈니스':
        '사내 메시지 톤으로 바꾸세요. 업무용으로 자연스럽고 신뢰감 있게 정리하되, 길이를 억지로 줄이지 마세요. ' +
        '자기 자신에게 높임말을 쓰지 말고, 원문에 없는 이름·직함·부서명·일정은 만들어내지 마세요. ' +
        '과한 인사말이나 감사말은 꼭 필요할 때만 넣으세요. 결과 문장만 출력하세요.',
      '고객 안내':
        '고객 응대 톤으로 바꾸세요. 정중하고 분명하게 안내하되, 약한 공감 표현은 허용하세요. ' +
        '예: 기다리셨죠, 불편을 드려 죄송합니다, 걱정되셨을 것 같습니다. ' +
        '다만 과한 감정 표현이나 지나치게 AI 같은 문장은 피하세요. 결과 문장만 출력하세요.',
      '학부모 안내':
        '학부모 안내 톤으로 바꾸세요. 아이를 세심하게 챙겨주는 느낌이 들도록 따뜻하고 안정적인 표현을 사용하세요. ' +
        '원문 의미 범위 안에서 배려와 관찰의 뉘앙스를 조금 확장해도 됩니다. ' +
        '다만 원문에 없는 구체적 사실, 일정, 약속, 평가를 새로 만들지는 마세요. 결과 문장만 출력하세요.',
      '소개팅체':
        '당신은 한국어 맞춤법 교정기입니다. 맞춤법·띄어쓰기 오류만 수정하고, 문장 구조·단어·표현은 원문 그대로 유지하세요. ㅋㅋ, ㅎㅎ, ㅠㅠ, ㅜㅜ, ㅡㅡ 같은 감정 표현, 자모 반복, 인터넷체, 이모티콘성 표기는 원문에 있으면 오타로 보지 말고 삭제하지 말며 그대로 유지하세요. 결과 문장만 출력하세요. 설명, 머리말, 따옴표, 불릿, 메모를 붙이지 마세요.',
    }
    let system = modePrompt[formalLevel] ?? '자연스럽고 읽기 좋은 존댓말 문장으로 다듬으세요. 결과 문장만 출력하세요.'
    if (!formalIncludePunct) system += ' 구두점은 가능하면 유지하세요.'
    return system
  }

  // 맞춤법 교정 모드
  let system =
    '당신은 한국어 맞춤법 교정기입니다. ' +
    '맞춤법·띄어쓰기 오류만 수정하고, 문장 구조·단어·표현은 원문 그대로 유지하세요. ㅋㅋ, ㅎㅎ, ㅠㅠ, ㅜㅜ, ㅡㅡ 같은 감정 표현, 자모 반복, 인터넷체, 이모티콘성 표기는 원문에 있으면 오타로 보지 말고 삭제하지 말며 그대로 유지하세요. ' +
    '결과 문장만 출력하세요. 설명, 머리말, 따옴표, 불릿, 메모를 붙이지 마세요.'
  if (removePunct) system += ' 마침표, 쉼표, 물음표 같은 구두점을 새로 추가하지 마세요. 원문에 있는 구두점은 그대로 유지하세요.'
  if (!includeDialect) system += ' 사투리나 구어체를 억지로 표준어로 바꾸지 말고, 문법적으로 어색한 부분만 정리하세요.'
  return system
}

async function callGemini(
  text: string,
  formalMode: boolean,
  removePunct: boolean,
  includeDialect: boolean,
  formalLevel: string,
  formalIncludePunct: boolean
): Promise<string> {
  const system = buildSystemPrompt(
    formalMode,
    removePunct,
    includeDialect,
    formalLevel,
    formalIncludePunct
  )

  const apiKey = Deno.env.get('GEMINI_API_KEY')!
  const model = formalMode ? 'gemini-3.1-flash-lite' : 'gemini-2.5-flash-lite'
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 1000,
        ...(formalMode ? { thinkingConfig: { thinkingLevel: 'medium' } } : {}),
      },
    }),
  })

  const data = await res.json()
  if (!res.ok) throw new Error(data.error?.message ?? '교정 실패')
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (!content) throw new Error(`빈 응답: ${JSON.stringify(data.candidates?.[0])}`)
  return content.trim()
}
