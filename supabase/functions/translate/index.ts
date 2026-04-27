import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { checkAndDeduct } from '../_shared/credits.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const { text, targetLang, deviceId } = await req.json()

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const credit = await checkAndDeduct(supabase, deviceId, 20)

    if (!credit.allowed) {
      return new Response(
        JSON.stringify({ error: 'NO_CREDITS', remaining: credit.snapshot.remaining }),
        { status: 429, headers: { ...cors, 'Content-Type': 'application/json' } }
      )
    }

    const result = await callGPT(text, targetLang)

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
    const message =
      e instanceof Error ? e.message
      : (e && typeof e === 'object') ? JSON.stringify(e)
      : String(e)
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } }
    )
  }
})

async function callGPT(text: string, targetLang: string): Promise<string> {
  const langNames: Record<string, string> = {
    ko: '한국어',
    en: '영어',
    zh: '중국어(간체)',
    ja: '일본어',
  }
  const lang = langNames[targetLang] ?? targetLang

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${Deno.env.get('OPENAI_API_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `다음 텍스트를 ${lang}로 번역하세요. 번역 결과만 출력하고 설명은 붙이지 마세요.`,
        },
        { role: 'user', content: text },
      ],
      temperature: 0.3,
      max_tokens: 1000,
    }),
  })

  const data = await res.json()
  if (!res.ok) throw new Error(data.error?.message ?? '번역 실패')
  return data.choices[0].message.content.trim()
}
