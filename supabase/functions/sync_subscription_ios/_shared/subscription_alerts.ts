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
  const title = test ? '[킹보드 구독 동기화 · 테스트(TestFlight)]'
    : paid ? '\u{1F534} [킹보드 구독 반영 실패 · 우선 확인]' : '[킹보드 구독 동기화 확인 필요]'
  const lines = [title, `${time} KST`, `환경: ${test ? '테스트' : failure.environment}`,
    `상품: ${PRODUCT_NAME[failure.product] ?? '알 수 없음'}`, `실패 단계: ${failure.stage}`, `실패 이유: ${failure.code}`]
  if (today) lines.push(`오늘 이 환경 실패 요청: ${today.failures}건 · 중복 제외 확인 지갑 ${today.wallets}개 · 지갑 미확인 ${today.unresolved}건`)
  else lines.push('오늘 실패 집계: 조회 실패 (0건이 아닙니다)')
  lines.push(`진단 ID: ${failure.auditId}`)
  const evidenceText: Record<GrantEvidence, string> = {
    not_checked: '미확인', lookup_failed: '조회 실패 (없음으로 해석 금지)',
    same_cycle_grant_found: '있음 (현재 잔액을 뜻하지 않음)',
    same_cycle_grant_missing: '조회 시점 기록 없음 (미지급 확정 아님)',
    grant_record_other_wallet: '다른 지갑 기록 있음 (소유권 대조 필요)',
  }
  lines.push(`동일 주기 지급 기록: ${evidenceText[grantEvidence]}`, '새 청구 사실: 미확인 · 결제 후 미반영 확정: 불가')
  lines.push(paid
    ? 'Apple 활성 결제 검증 후 반영 단계가 실패했어요. 새 청구나 미지급 확정은 아니며 플랜·거래 기록 대조가 필요해요.'
    : test ? '테스트 환경 오류이며 실제 매출·결제 피해로 집계하지 않아요.'
      : '실제 결제·지급 성공 여부는 아직 확인되지 않았어요.')
  lines.push('같은 지갑·환경·상품·실패 유형은 한국 날짜 기준 하루 한 번 알립니다.')
  return lines.join('\n')
}

export async function reportFailure(db: any, events: any[], failureRecorded = true,
  grantContext?: { walletId: string; grantKey: string }): Promise<void> {
  const failure = summarizeFailure(events)
  if (!failure) return
  // Before authentication, caller-provided wallet IDs cannot create unlimited alert keys.
  const owner = events.some(e => e.event === 'wallet_authenticated') ? failure.wallet : 'pre_auth'
  const now = Date.now()
  const baseKey = `${owner}:${failure.environment}:${failure.product}:${failure.stage}:${failure.code}:${new Date(now + 9 * 3600_000).toISOString().slice(0, 10)}`
  const time = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })
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

