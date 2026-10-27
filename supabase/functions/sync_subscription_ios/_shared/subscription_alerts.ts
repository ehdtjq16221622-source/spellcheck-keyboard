import { countSubscriptionFailures, kstDayStart, readSubscriptionFailures } from '../../_shared/subscription_audit.ts'

export const ALERT_TYPE = 'ios_subscription_incident'

export async function fingerprint(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('')
}

// A unique row claims delivery; a stale claim can be retried after five minutes.
// Telegram cannot guarantee exactly-once delivery after an ambiguous timeout.
export async function sendIncident(db: any, key: string, message: string): Promise<boolean> {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN')
  const chat = Deno.env.get('TELEGRAM_CHAT_ID')
  if (!token || !chat) throw new Error('alert_credentials_missing')
  const now = new Date().toISOString()
  const row = { alert_type: ALERT_TYPE, idempotency_key: key, delivery_status: 'unknown',
    sent_at: now, metadata: { message } }
  const inserted = await db.from('telegram_alert_logs').insert(row)
  if (inserted.error) {
    if (inserted.error.code !== '23505') throw new Error('alert_claim_failed')
    const existing = await db.from('telegram_alert_logs').select('delivery_status,sent_at')
      .eq('alert_type', ALERT_TYPE).eq('idempotency_key', key).maybeSingle()
    if (existing.error || !existing.data) throw new Error('alert_lookup_failed')
    if (existing.data.delivery_status === 'delivered') return true
    if (Date.parse(existing.data.sent_at) > Date.now() - 300_000) return false
    const claim = await db.from('telegram_alert_logs').update({ sent_at: now })
      .eq('alert_type', ALERT_TYPE).eq('idempotency_key', key)
      .eq('delivery_status', 'unknown').eq('sent_at', existing.data.sent_at).select('id')
    if (claim.error) throw new Error('alert_reclaim_failed')
    if (!claim.data?.length) return false
  }
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', signal: AbortSignal.timeout(8000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: message, disable_web_page_preview: true }),
  })
  const result = await response.json().catch(() => null)
  if (!response.ok || result?.ok !== true) throw new Error('alert_delivery_failed')
  const saved = await db.from('telegram_alert_logs').update({ delivery_status: 'delivered' })
    .eq('alert_type', ALERT_TYPE).eq('idempotency_key', key).eq('sent_at', now)
  if (saved.error) throw new Error('alert_delivery_record_failed')
  return true
}

export function summarizeFailure(events: any[]): { stage: string; code: string; environment: string; auditId: string; wallet: string; product: string; verifiedActive: boolean } | null {
  const failure = [...events].reverse().find(e => ['rejected', 'verification_rejected', 'sync_failed'].includes(e.event))
  if (!failure) return null
  const accepted = events.find(e => e.event === 'request_accepted')
  const verified = events.find(e => e.event === 'verification_completed')
  return { stage: failure.stage ?? 'unknown', code: failure.failureCode ?? 'unknown',
    environment: ['Production', 'Sandbox'].includes(verified?.environment ?? failure.environment)
      ? (verified?.environment ?? failure.environment) : 'Unknown', auditId: failure.auditId,
    wallet: accepted?.walletFingerprint ?? failure.walletFingerprint ?? 'unresolved',
    product: String(failure.product ?? accepted?.product ?? 'other'),
    verifiedActive: verified?.active === true && verified?.state === 'SUBSCRIPTION_STATE_ACTIVE' }
}

// A verified entitlement is evidence, not proof of a new charge or of missing credits.
const PAID_STAGES = ['subscription_lookup', 'plan_change_verification', 'atomic_subscription_and_grant', 'subscription_record_write', 'monthly_credit_grant']
const PRODUCT_NAME: Record<string, string> = { basic: '베이직', premium: '프리미엄', pro: '프로' }

type GrantEvidence = 'not_checked' | 'lookup_failed' | 'same_cycle_grant_found' | 'same_cycle_grant_missing' | 'grant_record_other_wallet'

export async function readFailureGrantEvidence(db: any, authenticated: boolean,
  context?: { walletId: string; grantKey: string }): Promise<GrantEvidence> {
  if (!authenticated || !context?.walletId || !context?.grantKey) return 'not_checked'
  try {
    const { data, error } = await db.from('credit_transactions').select('device_id')
      .eq('transaction_type', 'subscription_monthly_grant').eq('idempotency_key', context.grantKey).maybeSingle()
    if (error) return 'lookup_failed'
    if (!data) return 'same_cycle_grant_missing'
    return data.device_id === context.walletId ? 'same_cycle_grant_found' : 'grant_record_other_wallet'
  } catch { return 'lookup_failed' }
}

/** The alert text. Pure so it can be tested without a database. */
export function buildFailureMessage(
  failure: { stage: string; code: string; environment: string; auditId: string; product: string; verifiedActive: boolean },
  today: { failures: number; wallets: number; unresolved: number } | null,
  time: string,
  grantEvidence: GrantEvidence = 'not_checked',
): string {
  const test = failure.environment === 'Sandbox'
  const paid = failure.environment === 'Production' && failure.verifiedActive && PAID_STAGES.includes(failure.stage)
  const product = PRODUCT_NAME[failure.product] ?? '상품 미확인'
  if (test) {
    return `🧪 테스트 결제 오류 · ${product} (무시해도 돼요)\n${time} · ${failureReason(failure.stage, failure.code)}\n진단 ID: ${failure.auditId}`
  }
  const lines = [paid ? `🔴 구독 반영 실패 · ${product} · 우선 확인` : `⚠️ 구독 처리 오류 · ${product}`,
    `${time} · ${today ? `오늘 구독 오류 ${today.failures}건` : '오늘 오류 수 확인 실패'}`,
    `이유: ${failureReason(failure.stage, failure.code)}`]
  const evidenceText: Record<GrantEvidence, string | null> = {
    not_checked: null, lookup_failed: '확인 실패',
    same_cycle_grant_found: '있음',
    same_cycle_grant_missing: '없음',
    grant_record_other_wallet: '다른 지갑에 있음',
  }
  if (evidenceText[grantEvidence]) lines.push(`이번 달 지급 기록: ${evidenceText[grantEvidence]}`)
  lines.push(paid ? `할 일: Codex에 진단 ID ${failure.auditId} 전달` : `진단 ID: ${failure.auditId}`)
  return lines.join('\n')
}

// Plain-Korean reason for the alert; unknown codes fall back to the raw code so nothing is hidden.
function failureReason(stage: string, code: string): string {
  const byCode: Array<[string, string]> = [
    ['wallet_access_rejected', '지갑 로그인 확인 실패'],
    ['apple_receipt_status_', '애플 영수증 확인 실패'],
    ['subscription_owner_transfer_requires_review', '다른 지갑에 연결된 구독'],
    ['subscription_token_change_requires_review', '구독 번호 변경 확인 필요'],
    ['subscription_cycle_wallet_mismatch', '이번 달 지급이 다른 지갑에 있음'],
    ['plan_change_unverified', '플랜 변경 확인 안 됨'],
    ['apple_plan_not_confirmed', '플랜 변경 확인 안 됨'],
    ['new_plan_not_active', '플랜 변경 확인 안 됨'],
    ['stale_subscription_transaction', '지난 결제 정보로 요청'],
    ['subscription_not_found', '애플에서 구독을 못 찾음'],
    ['jws_verification_failed', '애플 결제 서명 확인 실패'],
    ['receipt_required', '결제 정보 없이 요청'],
    ['missing_required_fields', '요청 정보 누락'],
    ['unknown_subscription_product', '알 수 없는 상품'],
  ]
  const known = byCode.find(([needle]) => code.includes(needle))
  if (known) return known[1]
  const byStage: Record<string, string> = {
    atomic_subscription_and_grant: '구독 저장·크레딧 지급 중 오류',
    subscription_record_write: '구독 저장 중 오류',
    monthly_credit_grant: '크레딧 지급 중 오류',
    subscription_lookup: '구독 조회 중 오류',
    plan_change_verification: '플랜 변경 확인 중 오류',
    apple_verification: '애플 확인 중 오류',
    balance_readback: '잔액 확인 중 오류',
  }
  return byStage[stage] ?? `처리 중 오류 (${code})`
}

export async function reportFailure(db: any, events: any[], failureRecorded = true,
  grantContext?: { walletId: string; grantKey: string }): Promise<void> {
  const failure = summarizeFailure(events)
  if (!failure) return
  // Before authentication, caller-provided wallet IDs cannot create unlimited alert keys.
  const owner = events.some(e => e.event === 'wallet_authenticated') ? failure.wallet : 'pre_auth'
  const now = Date.now()
  const baseKey = `${owner}:${failure.environment}:${failure.product}:${failure.stage}:${failure.code}:${new Date(now + 9 * 3600_000).toISOString().slice(0, 10)}`
  const kst = new Date(now + 9 * 3600_000)
  const time = `${kst.getUTCMonth() + 1}/${kst.getUTCDate()} ${String(kst.getUTCHours()).padStart(2, '0')}:${String(kst.getUTCMinutes()).padStart(2, '0')}`
  let today: { failures: number; wallets: number; unresolved: number } | null = null
  try {
    if (!failureRecorded) throw new Error('failure_record_unavailable')
    today = countSubscriptionFailures(await readSubscriptionFailures(db, kstDayStart(now), new Date(now + 1).toISOString(), failure.environment))
  } catch {
    console.error(JSON.stringify({ category: 'subscription_alert', event: 'failure_counts_unavailable' }))
  }
  const grantEvidence = failure.environment === 'Production' && failure.verifiedActive
    ? await readFailureGrantEvidence(db, events.some(e => e.event === 'wallet_authenticated'), grantContext)
    : 'not_checked'
  const key = await fingerprint(`${baseKey}:${failure.verifiedActive}:${grantEvidence}`)
  await sendIncident(db, key, buildFailureMessage(failure, today, time, grantEvidence))
}

export function grantKey(s: any): string | null {
  if (!s.purchase_token || !s.product_id || !s.last_cycle_key) return null
  return s.last_cycle_key.startsWith(s.purchase_token + ':') ? s.last_cycle_key
    : `${s.purchase_token}:${s.product_id}:${s.last_cycle_key}`
}

export function deferDiagnostic(task: () => Promise<void>): void {
  const promise = Promise.resolve().then(task).catch(() => {
    console.error(JSON.stringify({ category: 'subscription_alert', event: 'delivery_or_monitor_failed' }))
  })
  const runtime = (globalThis as any).EdgeRuntime
  if (runtime?.waitUntil) runtime.waitUntil(promise)
}

