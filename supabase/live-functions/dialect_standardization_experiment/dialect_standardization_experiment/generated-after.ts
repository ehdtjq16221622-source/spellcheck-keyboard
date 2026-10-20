// Generated offline by prepare.mjs; do not edit. No DB or credit implementation is imported.
export const sourceSha256 = '5cdb42fcdc7bee51fb8a548664a902fd362fdf7a30c667b90989eed949b834f2';
export const editsSha256 = '12deac4c152276fbabc0ba60e839cdc3fc3293972a24a8224b452eb93b82d7fb';
export function createPipeline(fetch: typeof globalThis.fetch, geminiKey: string) {
  const metrics = { wallet: 0, charge: 0, refund: 0, slowLog: 0 };
  const console = { log: (..._args: unknown[]) => {}, warn: (..._args: unknown[]) => {}, error: (..._args: unknown[]) => {} };
  const Deno = { env: { get: (name: string) => name === 'GEMINI_API_KEY' ? geminiKey : undefined } };
  class WalletAccessError extends Error { status: number; constructor(message: string, status: number) { super(message); this.status = status; } }
  const createClient = (..._args: unknown[]) => ({ from: (table: string) => {
    if (table !== 'ai_slow_requests') throw new Error('DB_FORBIDDEN');
    return { insert: (_data: unknown) => { metrics.slowLog++; return Promise.resolve({ error: null }); } };
  } });
  const resolveCreditWallet = async (_req: Request, _client: unknown, walletId: string) => {
    if (walletId !== 'synthetic-dialect-only') throw new Error('REAL_WALLET_FORBIDDEN');
    metrics.wallet++; return { walletId };
  };
  const consumeAIUsage = async (_client: unknown, walletId: string, _id: string, kind: string) => {
    if (walletId !== 'synthetic-dialect-only' || kind !== 'correct') throw new Error('REAL_CREDIT_FORBIDDEN');
    metrics.charge++;
    return { accepted: true, alreadyProcessed: false, freeCredits: 0, paidCredits: 0, remaining: 0 };
  };
  const refundAIUsage = async (..._args: unknown[]) => { metrics.refund++; };
type ProofingEdit = {
  find: string
  replace: string
  reason?: string
}

type ProofingEditResult = {
  result: string
  accepted: ProofingEdit[]
  rejected: Array<ProofingEdit & { rejection: string }>
}

function parseProofingEdits(raw: string): ProofingEdit[] {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('proofing JSON object not found')

  const parsed = JSON.parse(cleaned.slice(start, end + 1))
  if (!Array.isArray(parsed?.edits)) throw new Error('proofing edits is not an array')

  return parsed.edits.map((edit: unknown) => {
    const candidate = edit as Record<string, unknown>
    return {
      find: typeof candidate?.find === 'string' ? candidate.find : '',
      replace: typeof candidate?.replace === 'string' ? candidate.replace : '',
      reason: typeof candidate?.reason === 'string' ? candidate.reason : undefined,
    }
  })
}

function applyValidatedProofingEdits(source: string, rawEdits: ProofingEdit[]): ProofingEditResult {
  const accepted: Array<ProofingEdit & { start: number; end: number }> = []
  const rejected: Array<ProofingEdit & { rejection: string }> = []

  for (const edit of rawEdits.slice(0, 24)) {
    if (!edit.find || edit.find === edit.replace) {
      rejected.push({ ...edit, rejection: 'empty_or_unchanged' })
      continue
    }

    const matches = findOccurrences(source, edit.find)
    if (matches.length !== 1) {
      rejected.push({ ...edit, rejection: `match_count_${matches.length}` })
      continue
    }

    const distance = levenshtein(edit.find, edit.replace)
    const maxDistance = Math.max(4, Math.ceil(edit.find.length * 0.45))
    if (distance > maxDistance) {
      rejected.push({ ...edit, rejection: 'replacement_too_different' })
      continue
    }

    const start = matches[0]
    const end = start + edit.find.length
    if (accepted.some((item) => start < item.end && end > item.start)) {
      rejected.push({ ...edit, rejection: 'overlap' })
      continue
    }

    accepted.push({ ...edit, start, end })
  }

  let result = source
  for (const edit of [...accepted].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.replace + result.slice(edit.end)
  }

  const totalDistance = levenshtein(source, result)
  const maxTotalDistance = Math.max(6, Math.ceil(source.length * 0.35))
  if (totalDistance > maxTotalDistance || !preservesProtectedTokens(source, result)) {
    return {
      result: source,
      accepted: [],
      rejected: [
        ...rejected,
        ...accepted.map(({ start: _start, end: _end, ...edit }) => ({ ...edit, rejection: 'result_guard' })),
      ],
    }
  }

  return {
    result,
    accepted: accepted.map(({ start: _start, end: _end, ...edit }) => edit),
    rejected,
  }
}

function findOccurrences(source: string, needle: string): number[] {
  const indexes: number[] = []
  let from = 0
  while (from <= source.length - needle.length) {
    const index = source.indexOf(needle, from)
    if (index < 0) break
    indexes.push(index)
    from = index + Math.max(1, needle.length)
  }
  return indexes
}

function protectedTokens(text: string): string[] {
  return text.match(
    /https?:\/\/\S+|[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*|\d+(?:[.:]\d+)*|[ㅋㅎㅠㅜㅡ]{2,}|\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*|[.,!?;:'"“”‘’…~]/gu
  ) ?? []
}

function preservesProtectedTokens(source: string, result: string): boolean {
  const remaining = [...protectedTokens(result)]
  for (const token of protectedTokens(source)) {
    const index = remaining.indexOf(token)
    if (index < 0) return false
    remaining.splice(index, 1)
  }
  return remaining.length === 0
}

function levenshtein(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0]
    previous[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const above = previous[j]
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1)
      )
      diagonal = above
    }
  }
  return previous[b.length]
}








const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Expose-Headers': 'X-Kingboard-Diagnostic-ID',
}

const genericAiErrorMessage = 'AI 응답이 잠시 지연되고 있어요. 조금 후 다시 시도해주세요.'

// Released iOS builds did not send a preview flag. Keep this legacy signature
// narrow so normal credit-bearing requests cannot bypass wallet authorization.
const legacyPreviewSource = '자 이제 얘기좀 하자 나 진짜 참다참다 말하는거야 요즘 너 나한테 소홀한거 느껴져 약속도 자꾸 미루고 연락도 예전같지 않고 내가 뭐라하면 또 예민하다 그러겠지 근데 나도 노력하는데 너는 안하는거같아서 서운해'
const previewBuckets = new Map<string, { startedAt: number; count: number }>()
const previewWindowMs = 60_000
const previewLimitPerWindow = 5

async function walletFingerprint(walletId: string): Promise<string | undefined> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(walletId))
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  } catch {
    return undefined
  }
}

const handleCorrection = (async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  let diagnosticId: string = crypto.randomUUID()
  let failureStage = 'request_parse'
  let causeStage: string | undefined
  let responseTrace: ToneResponseTrace | undefined
  let responseStatus = 500

  try {
    const {
      text,
      formalMode,
      removePunct,
      includePunct,
      includeDialect,
      formalLevel,
      formalIncludePunct,
      customPrompt,
      deviceId,
      requestId,
      preview,
      diagnosticId: requestedDiagnosticId,
      diagnosticTrace,
    } = await req.json()

    if (typeof requestedDiagnosticId === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedDiagnosticId)) {
      diagnosticId = requestedDiagnosticId
    }
    const source = typeof text === 'string' ? text : ''
    const normalizedLevel = normalizeFormalLevelKey(formalLevel)
    const isLegacyPreview = !preview && formalMode === true && normalizedLevel === '커스텀' &&
      !deviceId && !requestId && source === legacyPreviewSource
    const isPreviewRequest = preview === true || isLegacyPreview
    if (isPreviewRequest) {
      failureStage = 'preview_validation'
      if (!formalMode || normalizedLevel !== '커스텀' || source.length === 0 || source.length > 1000 ||
          typeof customPrompt !== 'string' || customPrompt.trim().length === 0 || customPrompt.trim().length > 200) {
        throw new WalletAccessError('Invalid preview request.', 400)
      }
      failureStage = 'preview_rate_limit'
      if (!allowPreviewRequest(req)) {
        logDiagnostic('warn', diagnosticId, failureStage, 'PREVIEW_RATE_LIMITED')
        return diagnosticError(diagnosticId, failureStage, 429, { error: 'PREVIEW_RATE_LIMITED' })
      }
    }

    const serverManagedCredit = typeof deviceId === 'string' && deviceId.length > 0 &&
      typeof requestId === 'string' && requestId.length > 0
    if (!isPreviewRequest && !serverManagedCredit) {
      console.warn(JSON.stringify({
        event: 'legacy_request_rejected',
        function: 'correct',
        id_type: typeof deviceId !== 'string' || !deviceId ? 'none' : deviceId.startsWith('v2:') ? 'v2' : 'legacy',
        diagnostic_id: diagnosticId,
      }))
      return new Response(JSON.stringify({
        error: '앱을 최신 버전으로 업데이트해 주세요.',
        code: 'APP_UPDATE_REQUIRED',
      }), { status: 409, headers: diagnosticHeaders(diagnosticId) })
    }
    const creditKind = formalMode ? 'formal' : 'correct'
    const creditCost = formalMode ? 30 : 10
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    failureStage = 'wallet_resolution'
    const wallet = isPreviewRequest ? null : await resolveCreditWallet(req, supabase, deviceId)
    // Opt-in counts only, and only after wallet authorization. Never retain text.
    if (formalMode && diagnosticTrace === true && wallet) {
      responseTrace = {
        source_utf16_units: source.length,
        source_utf8_bytes: new TextEncoder().encode(source).length,
        provider_utf16_units: null,
        provider_utf8_bytes: null,
        result_utf16_units: 0,
        result_utf8_bytes: 0,
        provider_http_status: null,
        provider_status: 'not_called',
        max_output_tokens: normalizedLevel === '커스텀' ? 4000 : 4096,
      }
    }
    failureStage = 'credit_precharge'
    const credits = !isPreviewRequest && serverManagedCredit && wallet
      ? await consumeAIUsage(supabase, wallet.walletId, requestId, creditKind)
      : null
    if (credits && !credits.accepted) {
      logDiagnostic('warn', diagnosticId, failureStage, 'NO_CREDITS', undefined, {
        requested_wallet_fingerprint: typeof deviceId === 'string' ? await walletFingerprint(deviceId) : undefined,
        canonical_wallet_fingerprint: wallet ? await walletFingerprint(wallet.walletId) : undefined,
        request_id_fingerprint: typeof requestId === 'string' ? await walletFingerprint(requestId) : undefined,
        free_credits_remaining: credits.freeCredits,
        paid_credits_remaining: credits.paidCredits,
      })
      responseStatus = 429
      return noCredits(credits, diagnosticId, failureStage)
    }

    const shouldRemovePunct = removePunct ?? (includePunct === undefined ? false : !includePunct)
    const shouldIncludeFormalPunct = formalIncludePunct ?? !shouldRemovePunct
    let result: string
    try {
      failureStage = 'ai_provider'
      if (!formalMode) {
        const startedAt = Date.now()
        try {
          result = await correctSpellingLowCost(source, shouldRemovePunct, includeDialect, diagnosticId)
          recordSlowRequest(supabase, Date.now() - startedAt, 'ok')
        } catch (error) {
          recordSlowRequest(supabase, Date.now() - startedAt, 'error')
          throw error
        }
      } else {
        const system = buildSystemPrompt(
          true,
          shouldRemovePunct,
          includeDialect,
          normalizedLevel,
          shouldIncludeFormalPunct,
          customPrompt
        )
        const toneResult = normalizedLevel === '커스텀'
          ? await callLuna(source, system, responseTrace)
          : await callGemini(source, true, shouldRemovePunct, includeDialect, normalizedLevel, shouldIncludeFormalPunct, customPrompt, responseTrace)
        result = applyProofingFallbacks(toneResult, source)
      }
    } catch (error) {
      if (credits && !credits.alreadyProcessed) {
        try {
          failureStage = 'credit_refund'
          if (wallet) await refundAIUsage(supabase, wallet.walletId, requestId)
        } catch (refundError) {
          causeStage = 'ai_provider'
          logDiagnostic('error', diagnosticId, failureStage, 'AI_CREDIT_REFUND_FAILED')
        }
      }
      throw error
    }

    if (responseTrace) {
      responseTrace.result_utf16_units = result.length
      responseTrace.result_utf8_bytes = new TextEncoder().encode(result).length
    }
    responseStatus = 200
    return new Response(
      JSON.stringify({
        result,
        diagnostic_id: diagnosticId,
        ...(credits ? creditSnapshot(credits) : {}),
      }),
      { headers: diagnosticHeaders(diagnosticId) }
    )
  } catch (e) {
    responseStatus = e instanceof WalletAccessError ? e.status : 500
    const code = e instanceof WalletAccessError ? 'WALLET_ACCESS_ERROR' : 'AI_REQUEST_FAILED'
    logDiagnostic('error', diagnosticId, failureStage, code, causeStage)
    if (e instanceof WalletAccessError) {
      return diagnosticError(diagnosticId, failureStage, e.status, { error: e.message }, causeStage)
    }
    return diagnosticError(diagnosticId, failureStage, 500, { error: genericAiErrorMessage }, causeStage)
  } finally {
    if (responseTrace) {
      console.log('[correct] response_trace', {
        event: 'tone_response_trace',
        diagnostic_id: diagnosticId,
        ...responseTrace,
        http_status: responseStatus,
        status: responseStatus === 200 ? 'ok' : 'error',
        ...(responseStatus === 200 ? {} : { failure_stage: failureStage }),
      })
    }
  }
})

type ToneResponseTrace = {
  source_utf16_units: number
  source_utf8_bytes: number
  provider_utf16_units: number | null
  provider_utf8_bytes: number | null
  result_utf16_units: number
  result_utf8_bytes: number
  provider_http_status: number | null
  provider_status: 'not_called' | 'awaiting_response' | 'network_error' | 'invalid_response' | 'http_error' | 'completed' | 'incomplete' | 'missing_status' | 'empty'
  max_output_tokens: number
  finish_reason?: 'STOP' | 'MAX_TOKENS' | 'SAFETY' | 'RECITATION' | 'MISSING' | 'OTHER'
  code?: 'AI_INCOMPLETE_RESPONSE'
}

function recordProviderText(trace: ToneResponseTrace | undefined, text: string) {
  if (!trace) return
  trace.provider_utf16_units = text.length
  trace.provider_utf8_bytes = new TextEncoder().encode(text).length
}

// Spelling requests slower than this are logged for the service monitor's
// Telegram alert. Best-effort and off the response path: never throws.
const slowSpellingThresholdMs = 10_000

// deno-lint-ignore no-explicit-any
function recordSlowRequest(supabase: any, durationMs: number, outcome: 'ok' | 'error') {
  if (durationMs < slowSpellingThresholdMs) return
  const task = Promise.resolve(
    supabase.from('ai_slow_requests').insert({ kind: 'correct', duration_ms: durationMs, outcome }),
  ).then(({ error }: { error: unknown }) => {
    if (error) console.warn('[correct] slow request log failed')
  }).catch(() => console.warn('[correct] slow request log failed'))
  // deno-lint-ignore no-explicit-any
  const runtime = (globalThis as any).EdgeRuntime
  if (runtime?.waitUntil) runtime.waitUntil(task)
}

function diagnosticHeaders(diagnosticId: string) {
  return {
    ...cors,
    'Content-Type': 'application/json',
    'X-Kingboard-Diagnostic-ID': diagnosticId,
  }
}

function diagnosticError(
  diagnosticId: string,
  failureStage: string,
  status: number,
  body: Record<string, unknown>,
  causeStage?: string,
) {
  return new Response(JSON.stringify({
    ...body,
    diagnostic_id: diagnosticId,
    failure_stage: failureStage,
    ...(causeStage ? { cause_stage: causeStage } : {}),
  }), { status, headers: diagnosticHeaders(diagnosticId) })
}

function logDiagnostic(
  level: 'warn' | 'error',
  diagnosticId: string,
  failureStage: string,
  code: string,
  causeStage?: string,
  walletContext?: Record<string, unknown>,
) {
  const details = { diagnostic_id: diagnosticId, failure_stage: failureStage, code, ...(causeStage ? { cause_stage: causeStage } : {}), ...walletContext }
  if (level === 'error') console.error('[correct]', details)
  else console.warn('[correct]', details)
}

function allowPreviewRequest(req: Request): boolean {
  const forwarded = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  const key = req.headers.get('cf-connecting-ip')?.trim() ||
    forwarded ||
    req.headers.get('x-real-ip')?.trim() ||
    'unknown'
  const now = Date.now()
  const current = previewBuckets.get(key)
  if (!current || now - current.startedAt >= previewWindowMs) {
    previewBuckets.set(key, { startedAt: now, count: 1 })
    if (previewBuckets.size > 1000) {
      for (const [bucketKey, bucket] of previewBuckets) {
        if (now - bucket.startedAt >= previewWindowMs) previewBuckets.delete(bucketKey)
      }
    }
    return true
  }
  if (current.count >= previewLimitPerWindow) return false
  current.count += 1
  return true
}

function creditSnapshot(credits: { freeCredits: number; paidCredits: number; remaining: number }) {
  return {
    free_credits_remaining: credits.freeCredits,
    paid_credits_remaining: credits.paidCredits,
    credits_remaining: credits.remaining,
  }
}

function noCredits(credits: { freeCredits: number; paidCredits: number; remaining: number }, diagnosticId: string, failureStage: string) {
  return diagnosticError(diagnosticId, failureStage, 429, { error: 'NO_CREDITS', ...creditSnapshot(credits) })
}

function normalizeFormalLevelKey(formalLevel: unknown): string {
  const raw = typeof formalLevel === 'string' ? formalLevel.trim() : ''
  const aliases: Record<string, string> = {
    smart: '스마트 교정',
    '스마트': '스마트 교정',
    '스마트 교정': '스마트 교정',
    polite: '존댓말',
    '존댓말': '존댓말',
    formal: '격식체',
    '격식체': '격식체',
    business: '비즈니스',
    '비즈니스': '비즈니스',
    '사내 메시지': '비즈니스',
    customer: '고객 안내',
    '고객 안내': '고객 안내',
    parent: '학부모 안내',
    '학부모': '학부모 안내',
    '학부모 안내': '학부모 안내',
    '공문 안내': '학부모 안내',
    dating: '소개팅체',
    '소개팅': '소개팅체',
    '소개팅체': '소개팅체',
    '친근체': '소개팅체',
    custom: '커스텀',
    '커스텀': '커스텀',
  }
  return aliases[raw] ?? raw
}

function buildDialectProofingPrompt(removePunct: boolean, structuredEdits: boolean): string {
  let prompt =
    '너는 한국어 사투리 표준어 교정기다.\n' +
    '먼저 한국어 원문 전체의 문맥을 파악하여 문장 전체를 자연스러운 표준어로 정리하고, 그 다음 맞춤법·띄어쓰기·문법 오류를 처음부터 끝까지 교정하라.\n' +
    '사투리 단어·표현·어순·종결 어미는 표준어 문장에 필요한 만큼 바꿔라. 사투리의 원래 단어·말투·종결 어미 자체를 유지하라는 제한은 적용하지 마라.\n' +
    '단, 원문의 모든 뜻·사실·주체·대상·시제·인칭·부정·추측·전달·질문·요청 의도와 감정은 보존하라. 요약하거나 내용을 생략하거나 새로운 사실·이유·약속을 추가하지 마라.\n' +
    '이미 표준어인 구어체는 불필요하게 바꾸지 마라. 뜻이 모호한 표현은 추측하지 말고 원문대로 두라. 거시기·그 뭐냐처럼 대상을 특정하지 않은 지시 표현은 그대로 두라.\n' +
    '한국어가 아닌 입력의 언어는 바꾸지 마라. 숫자, 영어, URL, 이모지, ㅋㅋ, ㅎㅎ, ㅠㅠ는 보존하라. 단, 2틀은 이틀로 고쳐라.\n' +
    '문맥상 차이는 다르다, 오답은 틀리다로 구분하고, 빼다의 과거형 뺐다와 빼앗다의 준말 뺏다를 구분하라.\n' +
    '안되다는 잘되다의 반대이면 붙이고, 금지·불가능의 안 되다는 띄어 써라. 명사와 하다는 붙이고 본용언 뒤 주다는 원칙적으로 띄어 써라.\n' +
    '원문의 의도와 상황에 맞는 자연스러운 표준어로 정리하라. 모든 문장을 일괄 존댓말로 만들 필요는 없다.'
  prompt += removePunct
    ? '\n원문의 구두점은 그대로 유지하고 새 구두점을 추가하지 마라.'
    : '\n원문의 구두점은 유지하고, 문맥상 필요한 구두점은 자연스럽게 보완하라.'
  prompt += structuredEdits
    ? '\n표준어로 정리한 문장을 원문에 적용할 JSON 수정 목록으로 출력하라. 형식: {"edits":[{"find":"원문에 정확히 있는 문자열","replace":"교정 문자열"}]}. 각 find는 중간 결과가 아닌 원문에 정확히 한 번 존재하도록 앞뒤 문맥을 포함하고, 수정 구간끼리 겹치지 않게 하라. 수정이 없으면 {"edits":[]}만 출력하라. 설명과 마크다운 없이 완전한 JSON만 출력하라.'
    : '\n교정된 전체 문장만 출력하고 설명, 따옴표, 머리말을 붙이지 마라.'
  return prompt
}

function buildSystemPrompt(
  formalMode: boolean,
  removePunct: boolean,
  includeDialect: boolean,
  formalLevel: string,
  formalIncludePunct: boolean,
  customPrompt?: string
): string {
  // 말투 교정 모드: 기본 프롬프트 없이 말투 프롬프트만 단독 사용
  if (formalMode) {
    const languagePrefix =
      '입력 문장이 작성된 언어를 그대로 유지하세요. 입력이 한국어가 아닌 다른 언어(영어, 일본어, 중국어 등)라면 ' +
      '반드시 같은 언어로 결과를 작성하고, 아래 말투 지시사항을 그 언어에서 통용되는 격식·공손 표현 방식으로 자연스럽게 ' +
      '바꾸어 적용하세요. "-요체", "-습니다체"처럼 한국어 문법에 한정된 지시는 한국어 입력일 때만 그대로 적용하고, ' +
      '다른 언어에서는 그 언어의 대응되는 격식 수준(예: 영어의 정중한 요청형/비즈니스 톤)으로 표현하세요.\n\n'

    if (formalLevel === '커스텀') {
      const trimmed = typeof customPrompt === 'string' ? customPrompt.trim() : ''
      let system = languagePrefix + (trimmed || '자연스럽고 읽기 좋은 존댓말 문장으로 다듬으세요. 결과 문장만 출력하세요.')
      if (removePunct || !formalIncludePunct) {
        system += ' 원문에 있는 구두점은 그대로 유지하고, 마침표·쉼표·물음표 등 새 구두점을 추가하지 마세요.'
      } else {
        system += ' 문맥상 필요한 구두점은 자연스럽게 보완하세요.'
      }
      return system
    }

    const modePrompt: Record<string, string> = {
      '스마트 교정':
        '너는 문장을 상황에 맞게 다듬는 전문 편집자다. 원문의 문맥과 핵심 의도를 파악하고, 상대를 탓하거나 압박하는 표현과 무례한 뉘앙스는 완화하라. 관계를 해치거나 오해를 살 수 있는 내용은 포함하지 말고, 화자의 신뢰와 진정성이 잘 전달되도록 원문의 구성 요소를 파악하여 있는 것들만 자연스럽게 흘러가도록 재작성하라. 문장 종결형과 높임 단계를 원문에 맞춰 유지하라. 반말은 반말로, 존댓말은 원문의 높임 수준으로 다듬고, 부드럽게 바꾸더라도 원문에 없는 -요체나 -습니다체로 바꾸지 마라. 문맥상 필요하면 짧은 인삿말을 넣고, 최종 결과만 출력하라.',
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
        '맞춤법·띄어쓰기·문법 오류만 수정하고, 문장 구조·단어·표현은 원문 그대로 유지하세요. ㅋㅋ, ㅎㅎ, ㅠㅠ, ㅜㅜ, ㅡㅡ 같은 감정 표현, 자모 반복, 인터넷체, 이모티콘성 표기는 원문에 있으면 오타로 보지 말고 삭제하지 말며 그대로 유지하세요. 결과 문장만 출력하세요. 설명, 머리말, 따옴표, 불릿, 메모를 붙이지 마세요.',
    }
    let system = languagePrefix + (modePrompt[formalLevel] ?? '자연스럽고 읽기 좋은 존댓말 문장으로 다듬으세요. 결과 문장만 출력하세요.')
    if (removePunct || !formalIncludePunct) {
      system += ' 원문에 있는 구두점은 그대로 유지하고, 마침표·쉼표·물음표 등 새 구두점을 추가하지 마세요.'
    } else {
      system += ' 문맥상 필요한 구두점은 자연스럽게 보완하세요.'
    }
    return system
  }

  // 맞춤법 교정 모드
  if (includeDialect) return buildDialectProofingPrompt(removePunct, true)
  let system =
    '너는 한국어 맞춤법 교정기다.\n' +
    '먼저 원문의 의미를 문맥상 정확히 파악하라.\n' +
    '원문 전체를 다시 작성하지 말고 맞춤법, 띄어쓰기, 문법상 확실한 오타의 수정 목록만 만들어라.\n' +
    '각 find는 원문에 정확히 존재하는 연속 문자열이어야 하며, 바뀌는 위치를 유일하게 찾을 수 있는 최소 구절로 작성하라.\n' +
    '같은 오타가 여러 번 나오면 각 find에 서로 다른 앞뒤 문맥을 포함하여 원문에서 정확히 한 번만 나타나게 하라. 예: "하면 안돼"와 "만지면 안돼".\n' +
    '수정 구간끼리 겹치지 않게 하고, 수정이 없으면 edits를 빈 배열로 반환하라.\n' +
    '단어, 어순, 말투, 표현은 유지하라.\n' +
    '표면적인 철자나 발음이 비슷하다는 이유로 다른 단어로 바꾸지 마라.\n' +
    '문맥상 의미가 확실하지 않으면 고치지 말고 원문을 유지하라.\n' +
    '관용 표현, 구어체, 비속어, 감정 표현(ㅋㅋ, ㅠㅠ 등)은 의미가 분명하면 유지하라.\n' +
    '숫자, 영어, URL, 이모지, 감정 표현은 바꾸거나 삭제하지 마라.\n' +
    '반드시 지정된 JSON 형식만 출력하라.'
  if (removePunct) {
    system += ' 마침표, 쉼표, 물음표 같은 구두점을 새로 추가하지 마세요. 원문에 있는 구두점은 그대로 유지하세요.'
  } else {
    system += ' 원문에 있는 구두점은 유지하고, 문맥상 필요한 구두점은 자연스럽게 보완하세요.'
  }
  if (!includeDialect) system += ' 사투리나 구어체를 억지로 표준어로 바꾸지 말고, 문법적으로 어색한 부분만 정리하세요.'
  return system
}

function applyProofingEditsSafely(rawResult: string, source: string): string {
  try {
    const edits = parseProofingEdits(rawResult)
    const validation = applyValidatedProofingEdits(source, edits)
    if (validation.rejected.length > 0) {
      console.warn('[correct] rejected proofing edits', validation.rejected.map((edit) => edit.rejection))
    }
    return validation.result
  } catch (error) {
    console.error('[correct] invalid proofing edits', error)
    return source
  }
}

async function correctSpellingLowCost(
  source: string,
  removePunct: boolean,
  includeDialect: boolean,
  diagnosticId: string
): Promise<string> {
  const primaryRaw = await callProofingGemini(
    source,
    buildLowCostProofingPrompt(removePunct, includeDialect),
    false
  )
  let primary = removePunct ? restoreTerminalPunctuation(source, primaryRaw) : primaryRaw
  primary = applyProofingFallbacks(primary, source)
  primary = applyNarrowProofingRules(primary)

  if (!hasSuspiciousDeletion(source, primary)) return primary

  logDiagnostic('warn', diagnosticId, 'proofing_safety_fallback', 'SUSPICIOUS_DELETION_FALLBACK')
  try {
    const fallbackRaw = await callProofingGemini(
      source,
      buildEditFallbackPrompt(includeDialect),
      true
    )
    return applyNarrowProofingRules(applyProofingEditsSafely(fallbackRaw, source))
  } catch (error) {
    console.error('[correct] edit-list fallback failed', error)
    return source
  }
}

function buildLowCostProofingPrompt(removePunct: boolean, includeDialect: boolean): string {
  if (includeDialect) return buildDialectProofingPrompt(removePunct, false)
  let prompt =
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
    '교정된 문장만 출력하고 설명, 따옴표, 머리말을 붙이지 마라.'
  if (removePunct) {
    prompt += '\n원문의 구두점은 그대로 유지하고 새 구두점을 추가하지 마라.'
  } else {
    prompt += '\n원문의 구두점은 유지하고, 문맥상 필요한 구두점은 자연스럽게 보완하라.'
  }
  if (!includeDialect) prompt += '\n사투리와 구어체를 억지로 표준어로 바꾸지 마라.'
  return prompt
}

function buildEditFallbackPrompt(includeDialect: boolean): string {
  if (includeDialect) return buildDialectProofingPrompt(true, true)
  let prompt =
    '너는 한국어 맞춤법 교정기다.\n' +
    '맞춤법, 띄어쓰기, 문법 오류만 찾아 JSON 수정 목록으로 출력하라.\n' +
    '형식: {"edits":[{"find":"원문에 정확히 있는 문자열","replace":"교정 문자열"}]}\n' +
    '수정이 없으면 {"edits":[]}만 출력하라.\n' +
    '원문의 의미, 단어 선택, 어순, 말투, 시제, 종결 어미를 바꾸지 마라.\n' +
    '같은 문자열이 반복되면 위치를 구별하는 최소 앞뒤 문맥을 find에 포함하라.\n' +
    '숫자, 영어, URL, 이모지, 감정 표현, 구두점은 수정하지 마라.\n' +
    '설명과 마크다운 없이 완전한 JSON만 출력하라.'
  if (!includeDialect) prompt += '\n사투리와 구어체를 억지로 표준어로 바꾸지 마라.'
  return prompt
}

function restoreTerminalPunctuation(source: string, result: string): string {
  const sourceEnd = source.match(/[.!?。！？]+$/u)?.[0] ?? ''
  return result.replace(/[.!?。！？]+$/u, '') + sourceEnd
}

function applyNarrowProofingRules(text: string): string {
  return text
    .replace(
      /((?:공부|일|농사|장사|사업|적응)(?:이|가)?\s+(?:너무\s+|잘\s+)?)안\s+돼/g,
      '$1안돼'
    )
    .replace(
      /((?:공부|일|농사|장사|사업|적응)(?:이|가)?\s+(?:너무\s+|잘\s+)?)안\s+될(?=\s+것)/g,
      '$1안될'
    )
    .replace(/(\b건|\s건)\s+다했/g, '$1 다 했')
}

function differenceHunks(source: string, result: string): Array<{ deleted: string; inserted: string }> {
  const lcs = Array.from(
    { length: source.length + 1 },
    () => Array<number>(result.length + 1).fill(0)
  )
  for (let i = source.length - 1; i >= 0; i -= 1) {
    for (let j = result.length - 1; j >= 0; j -= 1) {
      lcs[i][j] = source[i] === result[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const hunks: Array<{ deleted: string; inserted: string }> = []
  let deleted = ''
  let inserted = ''
  let i = 0
  let j = 0
  const flush = () => {
    if (deleted || inserted) hunks.push({ deleted, inserted })
    deleted = ''
    inserted = ''
  }
  while (i < source.length || j < result.length) {
    if (i < source.length && j < result.length && source[i] === result[j]) {
      flush()
      i += 1
      j += 1
    } else if (j < result.length && (i === source.length || lcs[i][j + 1] > lcs[i + 1][j])) {
      inserted += result[j]
      j += 1
    } else {
      deleted += source[i]
      i += 1
    }
  }
  flush()
  return hunks
}

function hasSuspiciousDeletion(source: string, result: string): boolean {
  return differenceHunks(source, result).some((hunk) => {
    const deletedHangul = hunk.deleted.match(/[가-힣]/g)?.length ?? 0
    const insertedHangul = hunk.inserted.match(/[가-힣]/g)?.length ?? 0
    return deletedHangul >= 2 && insertedHangul === 0
  })
}

async function callProofingGemini(
  text: string,
  system: string,
  structuredEdits: boolean
): Promise<string> {
  const apiKey = Deno.env.get('GEMINI_API_KEY')!
  const model = 'gemini-3.1-flash-lite'
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
  const requestBody = JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 1000,
        thinkingConfig: { thinkingLevel: 'low' },
        ...(structuredEdits ? {
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: {
              edits: {
                type: 'ARRAY',
                items: {
                  type: 'OBJECT',
                  properties: {
                    find: { type: 'STRING' },
                    replace: { type: 'STRING' },
                  },
                  required: ['find', 'replace'],
                },
              },
            },
            required: ['edits'],
          },
        } : {}),
      },
    })
  const res = await fetchWithTransientRetry(url, apiKey, requestBody)
  const data = await res.json()
  if (!res.ok) throw new Error(data.error?.message ?? '교정 실패')
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (!content) throw new Error(`빈 응답: ${JSON.stringify(data.candidates?.[0])}`)
  return content.trim()
}

function applyProofingFallbacks(result: string, source: string): string {
  let output = result

  // Gemini often treats every "안 돼" as prohibition. In these subjects it means
  // the opposite of "잘되다", so the lexical verb "안되다" is intended.
  output = output.replace(
    /(공부|일|농사|장사|사업|적응)([가이은는도만을를]*)?((?:\s+\S+){0,3})\s+안\s+돼/g,
    '$1$2$3 안돼'
  )

  if (source.includes('부라리') && output.includes('불알')) {
    output = output.replace(/불알/g, '부라리')
  }

  return output
}

async function callGemini(
  text: string,
  formalMode: boolean,
  removePunct: boolean,
  includeDialect: boolean,
  formalLevel: string,
  formalIncludePunct: boolean,
  customPrompt?: string,
  trace?: ToneResponseTrace
): Promise<string> {
  const system = buildSystemPrompt(
    formalMode,
    removePunct,
    includeDialect,
    formalLevel,
    formalIncludePunct,
    customPrompt
  )

  const apiKey = Deno.env.get('GEMINI_API_KEY')!
  const model = formalMode ? 'gemini-3.1-flash-lite' : 'gemini-2.5-flash-lite'
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`

  const requestBody = JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text }] }],
      generationConfig: {
        temperature: formalMode ? 0.3 : 0.1,
        maxOutputTokens: formalMode ? 4096 : 1000,
        ...(formalMode ? { thinkingConfig: { thinkingLevel: 'medium' } } : {}),
        ...(!formalMode ? {
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: {
              edits: {
                type: 'ARRAY',
                items: {
                  type: 'OBJECT',
                  properties: {
                    find: { type: 'STRING' },
                    replace: { type: 'STRING' },
                    reason: { type: 'STRING' },
                  },
                  required: ['find', 'replace', 'reason'],
                },
              },
            },
            required: ['edits'],
          },
        } : {}),
      },
    })

  if (trace) trace.provider_status = 'awaiting_response'
  const res = await fetchWithTransientRetry(url, apiKey, requestBody, trace)
  if (trace) {
    trace.provider_http_status = res.status
    trace.provider_status = res.ok ? 'invalid_response' : 'http_error'
  }
  const data = await res.json()
  if (!res.ok) throw new Error('AI provider request failed')
  const candidate = data.candidates?.[0]
  const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []
  const content = parts
    .filter((part: { text?: unknown; thought?: boolean } | null) => part && typeof part.text === 'string' && part.thought !== true)
    .map((part: { text: string }) => part.text)
    .join('')
  recordProviderText(trace, content)
  if (trace) {
    trace.finish_reason = candidate?.finishReason === undefined ? 'MISSING'
      : ['STOP', 'MAX_TOKENS', 'SAFETY', 'RECITATION'].includes(candidate.finishReason) ? candidate.finishReason : 'OTHER'
    trace.provider_status = candidate?.finishReason === 'STOP' ? 'completed'
      : candidate?.finishReason === undefined ? 'missing_status' : 'incomplete'
  }
  if (candidate?.finishReason !== 'STOP') {
    if (trace) trace.code = 'AI_INCOMPLETE_RESPONSE'
    throw new Error('AI response did not complete')
  }
  if (!content.trim()) {
    if (trace) trace.provider_status = 'empty'
    throw new Error('AI returned an empty visible response')
  }
  return content.trim()
}

async function fetchWithTransientRetry(url: string, apiKey: string, body: string, trace?: ToneResponseTrace): Promise<Response> {
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if (trace) {
        trace.provider_http_status = null
        trace.provider_status = 'awaiting_response'
      }
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      if (trace) {
        trace.provider_http_status = response.status
        trace.provider_status = response.ok ? 'invalid_response' : 'http_error'
      }
      if (response.status < 500 && response.status !== 429) return response
      await response.body?.cancel()
      lastError = new Error(`AI provider HTTP ${response.status}`)
    } catch (error) {
      if (trace) trace.provider_status = 'network_error'
      lastError = error
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw lastError instanceof Error ? lastError : new Error('AI provider request failed')
}

async function callLuna(text: string, system: string, trace?: ToneResponseTrace): Promise<string> {
  const apiKey = Deno.env.get('OPENAI_API_KEY')
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured')

  if (trace) trace.provider_status = 'awaiting_response'
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-6-luna',
      reasoning: { effort: 'low' },
    max_output_tokens: 4000,
      store: false,
      instructions: system,
      input: text,
    }),
  }).catch((error: unknown) => {
    if (trace) trace.provider_status = 'network_error'
    throw error
  })

  if (trace) {
    trace.provider_http_status = res.status
    trace.provider_status = res.ok ? 'invalid_response' : 'http_error'
  }
  const data = await res.json()
  if (!res.ok) throw new Error('Luna correction failed')

  const content = typeof data.output_text === 'string'
    ? data.output_text
    : (data.output ?? [])
      .filter((item: { type?: string }) => item.type === 'message')
      .flatMap((item: { content?: Array<{ type?: string; text?: string }> }) => item.content ?? [])
      .filter((item: { type?: string }) => item.type === 'output_text')
      .map((item: { text?: string }) => item.text ?? '')
      .join('')

  recordProviderText(trace, content)
  if (trace) trace.provider_status = data.status === 'completed' ? 'completed' : data.status ? 'incomplete' : 'missing_status'
  if (data.status !== 'completed') {
    if (trace) trace.code = 'AI_INCOMPLETE_RESPONSE'
    throw new Error('Luna response incomplete')
  }
  if (!content.trim()) {
    if (trace) trace.provider_status = 'empty'
    throw new Error('Luna returned an empty response')
  }
  return content.trim()
}



  return { handleCorrection, metrics };
}
