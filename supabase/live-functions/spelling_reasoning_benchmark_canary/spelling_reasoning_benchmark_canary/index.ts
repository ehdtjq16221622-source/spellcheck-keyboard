const BENCHMARK_OPEN = false
const BENCHMARK_KEY = '7F12D7E82277A5D9AEC3EE430A858EFC2B4CECD3A69DA0F89283976CE2F719F0'

const jsonHeaders = { 'Content-Type': 'application/json' }

Deno.serve(async (request) => {
  if (!BENCHMARK_OPEN) {
    return Response.json({ error: 'BENCHMARK_CLOSED' }, { status: 410, headers: jsonHeaders })
  }
  if (request.method !== 'POST') {
    return Response.json({ error: 'METHOD_NOT_ALLOWED' }, { status: 405, headers: jsonHeaders })
  }
  if (request.headers.get('x-benchmark-key') !== BENCHMARK_KEY) {
    return Response.json({ error: 'FORBIDDEN' }, { status: 403, headers: jsonHeaders })
  }

  try {
    const body = await request.json()
    const text = typeof body.text === 'string' ? body.text : ''
    const provider = body.provider === 'gemini' ? 'gemini' : 'luna'
    const effort = body.effort === 'low' ? 'low' : 'none'
    const tier = body.tier === 'fast' ? 'fast' : 'standard'
    if (!text || text.length > 500) {
      return Response.json({ error: 'INVALID_TEXT' }, { status: 400, headers: jsonHeaders })
    }
    if (provider === 'gemini' && (effort !== 'none' || tier !== 'standard')) {
      return Response.json({ error: 'INVALID_GEMINI_ARM' }, { status: 400, headers: jsonHeaders })
    }

    const startedAt = performance.now()
    const response = provider === 'gemini'
      ? await callGemini(text)
      : await callLuna(text, effort, tier)
    const result = applyNarrowProofingRules(applyProofingFallbacks(response.result, text))

    return Response.json({
      provider,
      effort,
      tier,
      result,
      rawResult: response.result,
      usage: response.usage,
      actualServiceTier: response.actualServiceTier,
      latencyMs: Math.round(performance.now() - startedAt),
    }, { headers: jsonHeaders })
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : String(error),
    }, { status: 500, headers: jsonHeaders })
  }
})

function proofingPrompt(): string {
  return [
    '너는 한국어 맞춤법 교정기다.',
    '한국어 맞춤법, 띄어쓰기, 문법 오류만 교정하라.',
    '원문의 의미, 말투, 시제, 높임 정도, 종결 어미를 유지하고 필요한 부분만 최소 수정하라.',
    '축약하거나 풀어 쓰지 마라. 예: 뵈었어를 뵀어로 바꾸지 마라.',
    '숫자, 영어, URL, 이모지, ㅋㅋ, ㅎㅎ, ㅠㅠ는 보존하라. 단, 2틀은 이틀로 고쳐라.',
    '문맥상 차이를 뜻하면 틀리다가 아니라 다르다를 사용하라. 정답이 잘못됐다는 뜻일 때만 틀리다를 유지하라.',
    '뺐다는 빼다의 과거형이고, 뺏다는 빼앗다의 준말이다. 원래 활용형과 종결 어미를 유지해 구분하라.',
    '안되다는 일이 잘 이루어지지 않는 뜻으로 잘되다의 반대이면 붙인다. 금지·불가능의 안 되다는 띄어 쓴다.',
    '명사에 하다가 결합한 말은 붙여 쓰고, 본용언 뒤의 주다는 원칙적으로 띄어 쓴다.',
    '한 문장에 오류가 여러 개 있으면 처음부터 끝까지 다시 확인하여 모두 교정하라.',
    '교정된 문장만 출력하고 설명, 따옴표, 머리말을 붙이지 마라.',
    '원문의 구두점은 유지하고, 문맥상 필요한 구두점은 자연스럽게 보완하라.',
    '사투리와 구어체를 억지로 표준어로 바꾸지 마라.',
  ].join('\n')
}

async function callGemini(text: string) {
  const apiKey = Deno.env.get('GEMINI_API_KEY')
  if (!apiKey) throw new Error('GEMINI_API_KEY_MISSING')
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        system_instruction: { parts: [{ text: proofingPrompt() }] },
        contents: [{ role: 'user', parts: [{ text }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 1000,
          thinkingConfig: { thinkingLevel: 'medium' },
        },
      }),
    },
  )
  const data = await response.json()
  if (!response.ok) throw new Error(data.error?.message ?? `GEMINI_HTTP_${response.status}`)
  const result = data.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text ?? '').join('').trim()
  if (!result) throw new Error('GEMINI_EMPTY_RESPONSE')
  return {
    result,
    usage: {
      inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      reasoningTokens: data.usageMetadata?.thoughtsTokenCount ?? 0,
      totalTokens: data.usageMetadata?.totalTokenCount ?? 0,
    },
    actualServiceTier: 'standard',
  }
}

async function callLuna(text: string, effort: 'none' | 'low', tier: 'standard' | 'fast') {
  const apiKey = Deno.env.get('OPENAI_API_KEY')
  if (!apiKey) throw new Error('OPENAI_API_KEY_MISSING')
  const payload: Record<string, unknown> = {
    model: 'gpt-6-luna',
    instructions: proofingPrompt(),
    input: text,
    reasoning: { effort },
    max_output_tokens: 1000,
  }
  if (tier === 'fast') payload.service_tier = 'fast'

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      ...jsonHeaders,
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error?.message ?? `OPENAI_HTTP_${response.status}`)
  const result = typeof data.output_text === 'string'
    ? data.output_text.trim()
    : (data.output ?? [])
      .flatMap((item: { content?: Array<{ type?: string; text?: string }> }) => item.content ?? [])
      .filter((item: { type?: string }) => item.type === 'output_text')
      .map((item: { text?: string }) => item.text ?? '')
      .join('')
      .trim()
  if (!result) throw new Error('OPENAI_EMPTY_RESPONSE')
  return {
    result,
    usage: {
      inputTokens: data.usage?.input_tokens ?? 0,
      cachedInputTokens: data.usage?.input_tokens_details?.cached_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
      reasoningTokens: data.usage?.output_tokens_details?.reasoning_tokens ?? 0,
      totalTokens: data.usage?.total_tokens ?? 0,
    },
    actualServiceTier: data.service_tier ?? tier,
  }
}

function applyNarrowProofingRules(text: string): string {
  return text
    .replace(
      /((?:공부|일|농사|장사|사업|적응)(?:이|가)?\s+(?:너무\s+|잘\s+)?)안\s+돼/g,
      '$1안돼',
    )
    .replace(
      /((?:공부|일|농사|장사|사업|적응)(?:이|가)?\s+(?:너무\s+|잘\s+)?)안\s+될(?=\s+것)/g,
      '$1안될',
    )
    .replace(/(\b건|\s건)\s+다했/g, '$1 다 했')
}

function applyProofingFallbacks(result: string, source: string): string {
  let output = result.replace(
    /(공부|일|농사|장사|사업|적응)([가이은는도만을를]*)?((?:\s+\S+){0,3})\s+안\s+돼/g,
    '$1$2$3 안돼',
  )
  if (source.includes('부라리') && output.includes('불알')) {
    output = output.replace(/불알/g, '부라리')
  }
  return output
}
