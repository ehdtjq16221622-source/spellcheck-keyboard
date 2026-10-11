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

export function summarizeFailure(events: any[]): { stage: string; code: string; environment: string; auditId: string; wallet: string } | null {
  const failure = [...events].reverse().find(e => ['rejected', 'verification_rejected', 'sync_failed'].includes(e.event))
  if (!failure) return null
  const accepted = events.find(e => e.event === 'request_accepted')
  const verified = events.find(e => e.event === 'verification_completed')
  return { stage: failure.stage ?? 'unknown', code: failure.failureCode ?? 'unknown',
    environment: verified?.environment ?? 'Unknown', auditId: failure.auditId,
    wallet: accepted?.walletFingerprint ?? failure.walletFingerprint ?? 'unresolved' }
}

export async function reportFailure(db: any, events: any[]): Promise<void> {
  const failure = summarizeFailure(events)
  if (!failure) return
  // Before authentication, caller-provided wallet IDs cannot create unlimited alert keys.
  const owner = events.some(e => e.event === 'wallet_authenticated') ? failure.wallet : 'pre_auth'
  const key = await fingerprint(`${owner}:${failure.environment}:${failure.stage}:${failure.code}:${new Date().toISOString().slice(0, 10)}`)
  const time = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })
  await sendIncident(db, key, `[킹보드 구독 동기화 확인 필요]\n${time} KST\n환경: ${failure.environment}\n실패 단계: ${failure.stage}\n분류: ${failure.code}\n진단 ID: ${failure.auditId}\n같은 유형의 반복 요청은 하루 단위로 묶습니다. 결제·지급 성공 여부는 원장 대조가 필요합니다.`)
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
