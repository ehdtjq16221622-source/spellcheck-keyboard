import { applyValidatedProofingEdits, parseProofingEdits } from './proofing_edits.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { consumeAIUsage, refundAIUsage } from '../_shared/credits.ts'
import { resolveCreditWallet, WalletAccessError } from '../_shared/wallet_auth.ts'

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

async function diagnosticFingerprint(value: unknown): Promise<string | undefined> {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return undefined
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  } catch {
    return undefined
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const diagnosticId = crypto.randomUUID()
  let failureStage = 'request_parse'
  let causeStage: string | undefined
  let walletTrace: Record<string, unknown> = {}

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
    } = await req.json()

    walletTrace = {
      requested_wallet_fingerprint: await diagnosticFingerprint(deviceId),
      request_id_fingerprint: await diagnosticFingerprint(requestId),
      server_managed_credit: typeof deviceId === 'string' && deviceId.length > 0 &&
        typeof requestId === 'string' && requestId.length > 0,
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
    const creditKind = formalMode ? 'formal' : 'correct'
    const creditCost = formalMode ? 30 : 10
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    failureStage = 'wallet_resolution'
    const wallet = isPreviewRequest ? null : await resolveCreditWallet(req, supabase, deviceId)
    walletTrace = {
      ...walletTrace,
      canonical_wallet_fingerprint: wallet ? await diagnosticFingerprint(wallet.walletId) : undefined,
      authenticated_wallet: wallet?.authenticated ?? false,
    }
    failureStage = 'request_id_validation'
    if (wallet?.authenticated && !serverManagedCredit) {
      throw new WalletAccessError('A request ID is required for wallet credit use.', 400)
    }

    // Old app versions send no requestId and keep their original delayed-sync
    // path. New versions are debited before the AI provider is called.
    failureStage = 'credit_precharge'
    const credits = !isPreviewRequest && serverManagedCredit && wallet
      ? await consumeAIUsage(supabase, wallet.walletId, requestId, creditKind)
      : null
    if (credits && !credits.accepted) {
      logDiagnostic('warn', diagnosticId, failureStage, 'NO_CREDITS', undefined, walletTrace)
      return noCredits(credits, diagnosticId, failureStage)
    }
    if (credits?.accepted) {
      logDiagnostic('info', diagnosticId, failureStage,
        credits.alreadyProcessed ? 'CREDIT_USAGE_ALREADY_PROCESSED' : 'CREDIT_USAGE_ACCEPTED',
        undefined, walletTrace)
    }

    const shouldRemovePunct = removePunct ?? (includePunct === undefined ? false : !includePunct)
    const shouldIncludeFormalPunct = formalIncludePunct ?? !shouldRemovePunct
    let result: string
    try {
      failureStage = 'ai_provider'
      if (!formalMode) {
        result = await correctSpellingLowCost(source, shouldRemovePunct, includeDialect, diagnosticId)
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
          ? await callLuna(source, system)
          : await callGemini(source, true, shouldRemovePunct, includeDialect, normalizedLevel, shouldIncludeFormalPunct, customPrompt)
        result = applyProofingFallbacks(toneResult, source)
      }
    } catch (error) {
      if (credits && !credits.alreadyProcessed) {
        try {
          failureStage = 'credit_refund'
          if (wallet) await refundAIUsage(supabase, wallet.walletId, requestId)
        } catch (refundError) {
          causeStage = 'ai_provider'
          logDiagnostic('error', diagnosticId, failureStage, 'AI_CREDIT_REFUND_FAILED', undefined, walletTrace)
        }
      }
      throw error
    }

    return new Response(
      JSON.stringify({
        result,
        diagnostic_id: diagnosticId,
        ...(credits ? creditSnapshot(credits) : {}),
      }),
      { headers: diagnosticHeaders(diagnosticId) }
    )
  } catch (e) {
    const code = e instanceof WalletAccessError ? e.code ?? 'WALLET_ACCESS_ERROR' : 'AI_REQUEST_FAILED'
    logDiagnostic('error', diagnosticId, failureStage, code, causeStage, walletTrace)
    if (e instanceof WalletAccessError) {
      return diagnosticError(diagnosticId, failureStage, e.status, {
        error: e.message,
        ...(e.code ? { error_code: e.code } : {}),
      }, causeStage)
    }
    return diagnosticError(diagnosticId, failureStage, 500, { error: genericAiErrorMessage }, causeStage)
  }
})

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
  level: 'info' | 'warn' | 'error',
  diagnosticId: string,
  failureStage: string,
  code: string,
  causeStage?: string,
  walletTrace: Record<string, unknown> = {},
) {
  const details = {
    diagnostic_id: diagnosticId,
    failure_stage: failureStage,
    code,
    ...(causeStage ? { cause_stage: causeStage } : {}),
    ...walletTrace,
  }
  if (level === 'error') console.error('[correct]', details)
  else if (level === 'warn') console.warn('[correct]', details)
  else console.info('[correct]', details)
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
    const noNewPunctuationInstruction = " 원문에 없는 구두점(마침표 ., 쉼표 ,, 작은따옴표 ')은 추가하지 마세요. 원문에 있는 구두점은 그대로 유지하세요."
    const languagePrefix =
      '입력 문장이 작성된 언어를 그대로 유지하세요. 입력이 한국어가 아닌 다른 언어(영어, 일본어, 중국어 등)라면 ' +
      '반드시 같은 언어로 결과를 작성하고, 아래 말투 지시사항을 그 언어에서 통용되는 격식·공손 표현 방식으로 자연스럽게 ' +
      '바꾸어 적용하세요. "-요체", "-습니다체"처럼 한국어 문법에 한정된 지시는 한국어 입력일 때만 그대로 적용하고, ' +
      '다른 언어에서는 그 언어의 대응되는 격식 수준(예: 영어의 정중한 요청형/비즈니스 톤)으로 표현하세요.\n\n'

    if (formalLevel === '커스텀') {
      const trimmed = typeof customPrompt === 'string' ? customPrompt.trim() : ''
      let system = languagePrefix + (trimmed || '자연스럽고 읽기 좋은 존댓말 문장으로 다듬으세요. 결과 문장만 출력하세요.')
      if (removePunct || !formalIncludePunct) {
        system += noNewPunctuationInstruction
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
      system += noNewPunctuationInstruction
    } else {
      system += ' 문맥상 필요한 구두점은 자연스럽게 보완하세요.'
    }
    return system
  }

  // 맞춤법 교정 모드
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
    system += " 원문에 없는 구두점(마침표 ., 쉼표 ,, 작은따옴표 ')은 추가하지 마세요. 원문에 있는 구두점은 그대로 유지하세요."
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
    prompt += "\n원문에 없는 구두점(마침표 ., 쉼표 ,, 작은따옴표 ')은 추가하지 마라. 원문에 있는 구두점은 그대로 유지하라."
  } else {
    prompt += '\n원문의 구두점은 유지하고, 문맥상 필요한 구두점은 자연스럽게 보완하라.'
  }
  if (!includeDialect) prompt += '\n사투리와 구어체를 억지로 표준어로 바꾸지 마라.'
  return prompt
}

function buildEditFallbackPrompt(includeDialect: boolean): string {
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
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 1000,
        thinkingConfig: { thinkingLevel: 'medium' },
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
    }),
  })
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
  customPrompt?: string
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

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text }] }],
      generationConfig: {
        temperature: formalMode ? 0.3 : 0.1,
        maxOutputTokens: 1000,
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
    }),
  })

  const data = await res.json()
  if (!res.ok) throw new Error(data.error?.message ?? '교정 실패')
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (!content) throw new Error(`빈 응답: ${JSON.stringify(data.candidates?.[0])}`)
  return content.trim()
}

async function callLuna(text: string, system: string): Promise<string> {
  const apiKey = Deno.env.get('OPENAI_API_KEY')
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured')

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
  })

  const data = await res.json()
  if (!res.ok) throw new Error(data.error?.message ?? 'Luna correction failed')
  if (data.status && data.status !== 'completed') {
    throw new Error(`Luna response incomplete: ${data.incomplete_details?.reason ?? data.status}`)
  }

  const content = typeof data.output_text === 'string'
    ? data.output_text
    : (data.output ?? [])
      .filter((item: { type?: string }) => item.type === 'message')
      .flatMap((item: { content?: Array<{ type?: string; text?: string }> }) => item.content ?? [])
      .filter((item: { type?: string }) => item.type === 'output_text')
      .map((item: { text?: string }) => item.text ?? '')
      .join('')

  if (!content.trim()) throw new Error('Luna returned an empty response')
  return content.trim()
}
