const OPEN = false
const KEY = '2DF8CA687F9F41F487FE69374D6C5B5E'
const headers = { 'Content-Type': 'application/json' }

const instructions = [
  '너는 한국어 맞춤법 검사기다.',
  '명백한 철자, 활용, 띄어쓰기 오류만 최소한으로 고쳐라.',
  '의미, 단어, 어순, 말투, 시제, 높임, 종결 어미는 바꾸지 마라.',
  '원문의 숫자, 영문, URL, 이모지, 감정 표현, 문장부호는 그대로 유지하고 새 문장부호를 추가하지 마라.',
  '확실하지 않으면 원문을 유지하라.',
  '교정된 문장만 출력하라.',
].join('\n')

Deno.serve(async (request) => {
  if (!OPEN) return Response.json({ error: 'BENCHMARK_CLOSED' }, { status: 410, headers })
  if (request.method !== 'POST') return Response.json({ error: 'METHOD_NOT_ALLOWED' }, { status: 405, headers })
  if (request.headers.get('x-benchmark-key') !== KEY) return Response.json({ error: 'FORBIDDEN' }, { status: 403, headers })

  try {
    const { text } = await request.json()
    if (typeof text !== 'string' || text.length === 0 || text.length > 500) {
      return Response.json({ error: 'INVALID_TEXT' }, { status: 400, headers })
    }

    const started = performance.now()
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { ...headers, Authorization: `Bearer ${Deno.env.get('OPENAI_API_KEY')}` },
      body: JSON.stringify({
        model: 'gpt-6-luna',
        instructions,
        input: text,
        reasoning: { effort: 'medium' },
        max_output_tokens: 500,
      }),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error?.message ?? `OPENAI_HTTP_${response.status}`)

    const result = typeof data.output_text === 'string'
      ? data.output_text.trim()
      : (data.output ?? []).flatMap((item: { content?: Array<{ type?: string; text?: string }> }) => item.content ?? [])
        .filter((item: { type?: string }) => item.type === 'output_text')
        .map((item: { text?: string }) => item.text ?? '')
        .join('').trim()
    if (!result) throw new Error('OPENAI_EMPTY_RESPONSE')

    return Response.json({
      result,
      latencyMs: Math.round(performance.now() - started),
      usage: {
        inputTokens: data.usage?.input_tokens ?? 0,
        cachedInputTokens: data.usage?.input_tokens_details?.cached_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
      },
    }, { headers })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500, headers })
  }
})
