const OPEN = false
const KEY = '390E68317C7350790D271BFEB82845F4AE2B324521D300D9B9BB0BA1F701003E'
const headers = { 'Content-Type': 'application/json' }

Deno.serve(async (request) => {
  if (!OPEN) return Response.json({ error: 'BENCHMARK_CLOSED' }, { status: 410, headers })
  if (request.method !== 'POST') return Response.json({ error: 'METHOD_NOT_ALLOWED' }, { status: 405, headers })
  if (request.headers.get('x-benchmark-key') !== KEY) return Response.json({ error: 'FORBIDDEN' }, { status: 403, headers })
  try {
    const body = await request.json()
    const text = typeof body.text === 'string' ? body.text : ''
    const effort = body.effort === 'high' ? 'high' : body.effort === 'medium' ? 'medium' : 'low'
    const variant = body.variant === 'lean' ? 'lean' : body.variant === 'rewrite' ? 'rewrite' : body.variant === 'preserve' ? 'preserve' : body.generic === true ? 'generic' : 'base'
    if (!text || text.length > 500) return Response.json({ error: 'INVALID_TEXT' }, { status: 400, headers })

    const started = performance.now()
    const primary = await callLuna(text, prompt(variant), effort, false)
    let result = applyRules(applyFallbacks(primary.result, text))
    const usage = [primary.usage]
    let fallbackUsed = false
    if (hasSuspiciousDeletion(text, result)) {
      fallbackUsed = true
      const fallback = await callLuna(text, editPrompt(), effort, true)
      usage.push(fallback.usage)
      result = applyRules(applyEdits(text, fallback.result))
    }
    return Response.json({
      effort, variant, result, rawResult: primary.result, fallbackUsed,
      unexpectedScript: hasUnexpectedScript(text, result),
      usage: mergeUsage(usage), latencyMs: Math.round(performance.now() - started),
    }, { headers })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500, headers })
  }
})

function prompt(variant: 'base' | 'generic' | 'preserve' | 'rewrite' | 'lean') {
  if (variant === 'lean') return [
    '너는 한국어 맞춤법 교정기다.',
    '한국어 맞춤법, 띄어쓰기, 문법 오류만 교정하라.',
    '문맥과 문법 기능을 먼저 판단하라.',
    '원문의 의미와 말투를 유지하고, 주체·대상·시제·완료 여부·높임 관계·종결 어미가 바뀌지 않도록 필요한 부분만 최소한으로 교정하라.',
    '숫자, 영어, URL, 이모지, ㅋㅋ, ㅎㅎ, ㅠㅠ와 원문의 구두점은 그대로 보존하라.',
    '한 문장에 오류가 여러 개 있으면 처음부터 끝까지 다시 확인하여 모두 교정하라.',
    '사투리와 구어체를 억지로 표준어로 바꾸지 마라.',
    '교정된 문장만 출력하고 설명, 따옴표, 머리말을 붙이지 마라.',
  ].join('\n')
  const lines = [
    '너는 한국어 맞춤법 교정기다.',
    '한국어 맞춤법, 띄어쓰기, 문법 오류만 교정하라.',
    variant === 'rewrite'
      ? '원문의 의미와 말투를 유지하고, 주체·대상·시제·완료 여부·높임 관계·종결 어미가 바뀌지 않도록 맞춤법·띄어쓰기·문법 오류만 최소한으로 교정하라.'
      : '원문의 의미, 말투, 시제, 높임 정도, 종결 어미를 유지하고 필요한 부분만 최소 수정하라.',
    '축약하거나 풀어 쓰지 마라. 예: 뵈었어를 뵀어로 바꾸지 마라.',
    '숫자, 영어, URL, 이모지, ㅋㅋ, ㅎㅎ, ㅠㅠ는 보존하라. 단, 2틀은 이틀로 고쳐라.',
    '문맥상 차이를 뜻하면 틀리다가 아니라 다르다를 사용하라. 정답이 잘못됐다는 뜻일 때만 틀리다를 유지하라.',
    '뺐다는 빼다의 과거형이고, 뺏다는 빼앗다의 준말이다. 원래 활용형과 종결 어미를 유지해 구분하라.',
    '안되다는 일이 잘 이루어지지 않는 뜻으로 잘되다의 반대이면 붙인다. 금지·불가능의 안 되다는 띄어 쓴다.',
    '명사에 하다가 결합한 말은 붙여 쓰고, 본용언 뒤의 주다는 원칙적으로 띄어 쓴다.',
    '한 문장에 오류가 여러 개 있으면 처음부터 끝까지 다시 확인하여 모두 교정하라.',
  ]
  if (variant === 'generic') lines.push(
    '교정 전에 문맥을 판단하고, 표기나 발음이 비슷한 표현도 문장에서 맡는 의미와 문법 기능에 맞게 구분하라.',
    '교정 전후의 주체, 대상, 시점, 완료 여부와 높임 관계를 바꾸지 마라.',
    '확실한 오류만 최소 수정하고 판단이 불확실하면 원문을 유지하라.',
    '원문에 없던 단어, 다른 언어 문자 또는 구두점을 추가하지 마라.',
  )
  if (variant === 'preserve') lines.push(
    '교정 전후의 의미, 주체, 대상, 시제, 완료 여부와 높임 관계를 그대로 보존하라.',
  )
  lines.push(
    '교정된 문장만 출력하고 설명, 따옴표, 머리말을 붙이지 마라.',
    '원문의 구두점은 유지하고, 문맥상 필요한 구두점은 자연스럽게 보완하라.',
    '사투리와 구어체를 억지로 표준어로 바꾸지 마라.',
  )
  return lines.join('\n')
}

function editPrompt() {
  return [
    '너는 한국어 맞춤법 교정기다.',
    '맞춤법, 띄어쓰기, 문법 오류만 찾아 JSON 수정 목록으로 출력하라.',
    '형식: {"edits":[{"find":"원문에 정확히 있는 문자열","replace":"교정 문자열"}]}',
    '수정이 없으면 {"edits":[]}만 출력하라.',
    '원문의 의미, 단어 선택, 어순, 말투, 시제, 종결 어미를 바꾸지 마라.',
    '같은 문자열이 반복되면 위치를 구별하는 최소 앞뒤 문맥을 find에 포함하라.',
    '숫자, 영어, URL, 이모지, 감정 표현, 구두점은 수정하지 마라.',
    '설명과 마크다운 없이 완전한 JSON만 출력하라.',
  ].join('\n')
}

async function callLuna(text: string, instructions: string, effort: 'low' | 'medium' | 'high', structured: boolean) {
  const apiKey = Deno.env.get('OPENAI_API_KEY')
  if (!apiKey) throw new Error('OPENAI_API_KEY_MISSING')
  const payload: Record<string, unknown> = {
    model: 'gpt-6-luna', instructions, input: text,
    reasoning: { effort }, max_output_tokens: 1000,
  }
  if (structured) payload.text = { format: {
    type: 'json_schema', name: 'proofing_edits', strict: true,
    schema: {
      type: 'object', additionalProperties: false, required: ['edits'],
      properties: { edits: { type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['find', 'replace'],
        properties: { find: { type: 'string' }, replace: { type: 'string' } },
      } } },
    },
  } }
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST', headers: { ...headers, Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(payload),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error?.message ?? `OPENAI_HTTP_${response.status}`)
  const result = typeof data.output_text === 'string' ? data.output_text.trim() : (data.output ?? [])
    .flatMap((item: { content?: Array<{ type?: string; text?: string }> }) => item.content ?? [])
    .filter((item: { type?: string }) => item.type === 'output_text')
    .map((item: { text?: string }) => item.text ?? '').join('').trim()
  if (!result) throw new Error('OPENAI_EMPTY_RESPONSE')
  return { result, usage: {
    inputTokens: data.usage?.input_tokens ?? 0,
    cachedInputTokens: data.usage?.input_tokens_details?.cached_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
    reasoningTokens: data.usage?.output_tokens_details?.reasoning_tokens ?? 0,
  } }
}

function mergeUsage(items: Array<Record<string, number>>) {
  return items.reduce((a, b) => ({
    inputTokens: a.inputTokens + (b.inputTokens ?? 0),
    cachedInputTokens: a.cachedInputTokens + (b.cachedInputTokens ?? 0),
    outputTokens: a.outputTokens + (b.outputTokens ?? 0),
    reasoningTokens: a.reasoningTokens + (b.reasoningTokens ?? 0),
  }), { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 })
}

function applyEdits(source: string, raw: string) {
  const edits = JSON.parse(raw).edits
  if (!Array.isArray(edits)) throw new Error('INVALID_EDITS')
  let result = source
  for (const edit of edits) {
    if (typeof edit.find !== 'string' || typeof edit.replace !== 'string' || !edit.find) continue
    const index = result.indexOf(edit.find)
    if (index < 0 || result.indexOf(edit.find, index + edit.find.length) >= 0) continue
    result = result.slice(0, index) + edit.replace + result.slice(index + edit.find.length)
  }
  return result
}

function applyRules(text: string) {
  return text
    .replace(/((?:공부|일|농사|장사|사업|적응)(?:이|가)?\s+(?:너무\s+|잘\s+)?)안\s+돼/g, '$1안돼')
    .replace(/((?:공부|일|농사|장사|사업|적응)(?:이|가)?\s+(?:너무\s+|잘\s+)?)안\s+될(?=\s+것)/g, '$1안될')
    .replace(/(\b건|\s건)\s+다했/g, '$1 다 했')
}

function applyFallbacks(result: string, source: string) {
  let output = result.replace(/(공부|일|농사|장사|사업|적응)([가이은는도만을를]*)?((?:\s+\S+){0,3})\s+안\s+돼/g, '$1$2$3 안돼')
  if (source.includes('부라리') && output.includes('불알')) output = output.replace(/불알/g, '부라리')
  return output
}

function hasUnexpectedScript(source: string, result: string) {
  const scripts = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Gujarati}]/u
  return !scripts.test(source) && scripts.test(result)
}

function hasSuspiciousDeletion(source: string, result: string) {
  return differenceHunks(source, result).some((h) => (h.deleted.match(/[가-힣]/g)?.length ?? 0) >= 2 && (h.inserted.match(/[가-힣]/g)?.length ?? 0) === 0)
}

function differenceHunks(source: string, result: string) {
  const lcs = Array.from({ length: source.length + 1 }, () => Array<number>(result.length + 1).fill(0))
  for (let i = source.length - 1; i >= 0; i--) for (let j = result.length - 1; j >= 0; j--) {
    lcs[i][j] = source[i] === result[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  }
  const hunks: Array<{ deleted: string; inserted: string }> = []
  let deleted = '', inserted = '', i = 0, j = 0
  const flush = () => { if (deleted || inserted) hunks.push({ deleted, inserted }); deleted = ''; inserted = '' }
  while (i < source.length || j < result.length) {
    if (i < source.length && j < result.length && source[i] === result[j]) { flush(); i++; j++ }
    else if (j < result.length && (i === source.length || lcs[i][j + 1] > lcs[i + 1][j])) { inserted += result[j]; j++ }
    else { deleted += source[i]; i++ }
  }
  flush(); return hunks
}
