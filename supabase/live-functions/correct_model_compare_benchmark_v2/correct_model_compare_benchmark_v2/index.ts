const OPEN = false
const KEY = 'C4B8E2A671D943F08A5C9E2B7D164F30'
const headers = { 'Content-Type': 'application/json' }

const prompt =
  '너는 한국어 맞춤법 교정기다.\n' +
  '한국어 맞춤법, 띄어쓰기, 문법 오류만 교정하라.\n' +
  '원문의 의미, 말투, 시제, 높임 정도, 종결 어미를 유지하고 필요한 부분만 최소 수정하라.\n' +
  '축약하거나 풀어 쓰지 마라. 예: 뵈었어를 뵀어로 바꾸지 마라.\n' +
  '숫자, 영어, URL, 이모지, ㅋㅋ, ㅎㅎ, ㅠㅠ는 보존하라. 단, 2틀은 이틀로 고쳐라.\n' +
  '문맥상 차이를 뜻하면 틀리다가 아니라 다르다를 사용하라. 정답이 잘못됐다는 뜻일 때만 틀리다를 유지하라.\n' +
  '뺐다는 빼다의 과거형이고, 뺏다는 빼앗다의 준말이다. 원래 활용형과 종결 어미를 유지해 구분하라.\n' +
  '안되다는 일이 잘 이루어지지 않는 뜻으로 잘되다의 반대이면 붙인다. 금지·불가능의 안 되다는 띄어 쓴다.\n' +
  '명사에 하다가 결합한 말은 붙여 쓰고, 본용언 뒤의 주다는 원칙적으로 띄어 쓴다.\n' +
  '한 문장에 오류가 여러 개 있으면 처음부터 끝까지 다시 확인하여 모두 교정하라.\n' +
  '교정된 문장만 출력하고 설명, 따옴표, 머리말을 붙이지 마라.\n' +
  '원문의 구두점은 그대로 유지하고 새 구두점을 추가하지 마라.\n' +
  '사투리와 구어체를 억지로 표준어로 바꾸지 마라.'

Deno.serve(async (request) => {
  if (!OPEN) return Response.json({ error: 'BENCHMARK_CLOSED' }, { status: 410, headers })
  if (request.method !== 'POST') return Response.json({ error: 'METHOD_NOT_ALLOWED' }, { status: 405, headers })
  if (request.headers.get('x-benchmark-key') !== KEY) return Response.json({ error: 'FORBIDDEN' }, { status: 403, headers })
  try {
    const { model, text } = await request.json()
    if (!['gemini', 'luna'].includes(model) || typeof text !== 'string' || !text || text.length > 500) return Response.json({ error: 'INVALID_INPUT' }, { status: 400, headers })
    const started = performance.now()
    const response = model === 'gemini' ? await callGemini(text) : await callLuna(text)
    const result = response.text.trim()
    return Response.json({ result, guarded: applyGuards(text, result), latencyMs: Math.round(performance.now() - started), usage: response.usage }, { headers })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500, headers })
  }
})

async function callGemini(text: string) {
  const key = Deno.env.get('GEMINI_API_KEY')
  if (!key) throw new Error('GEMINI_API_KEY_MISSING')
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${key}`, {
    method: 'POST', headers,
    body: JSON.stringify({ system_instruction: { parts: [{ text: prompt }] }, contents: [{ role: 'user', parts: [{ text }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 2000, thinkingConfig: { thinkingLevel: 'low' } } }),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error?.message ?? `GEMINI_HTTP_${response.status}`)
  const output = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (!output) throw new Error('GEMINI_EMPTY_RESPONSE')
  return { text: output, usage: data.usageMetadata ?? {} }
}

async function callLuna(text: string) {
  const key = Deno.env.get('OPENAI_API_KEY')
  if (!key) throw new Error('OPENAI_API_KEY_MISSING')
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST', headers: { ...headers, Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'gpt-6-luna', instructions: prompt, input: text, reasoning: { effort: 'low' }, max_output_tokens: 2000 }),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error?.message ?? `LUNA_HTTP_${response.status}`)
  const output = typeof data.output_text === 'string' ? data.output_text : (data.output ?? []).flatMap((item: { content?: Array<{ type?: string; text?: string }> }) => item.content ?? []).filter((item: { type?: string }) => item.type === 'output_text').map((item: { text?: string }) => item.text ?? '').join('')
  if (!output) throw new Error('LUNA_EMPTY_RESPONSE')
  return { text: output, usage: data.usage ?? {} }
}

function applyGuards(source: string, result: string) {
  const sourceEnd = source.match(/[.!?。！？]+$/u)?.[0] ?? ''
  let output = result.replace(/[.!?。！？]+$/u, '') + sourceEnd
  output = output.replace(/((?:공부|일|농사|장사|사업|적응)(?:이|가)?\s+(?:너무\s+|잘\s+)?)안\s+돼/g, '$1안돼')
  output = output.replace(/((?:공부|일|농사|장사|사업|적응)(?:이|가)?\s+(?:너무\s+|잘\s+)?)안\s+될(?=\s+것)/g, '$1안될')
  return output.replace(/(\b건|\s건)\s+다했/g, '$1 다 했')
}
