export type SubscriptionAuditLevel = 'info' | 'warn' | 'error'

type AuditFields = {
  stage?: string
  product?: 'basic' | 'premium' | 'pro' | 'other'
  source?: 'storekit_jws' | 'app_receipt' | 'google_play' | 'unknown'
  environment?: string | null
  state?: string
  active?: boolean
  canary?: boolean
  grantApplied?: boolean
  failureCode?: string
  walletFingerprint?: string
  transactionFingerprint?: string
}

export function logSubscriptionAudit(
  level: SubscriptionAuditLevel,
  auditId: string,
  event: string,
  fields: AuditFields = {},
): void {
  const payload = {
    category: 'subscription_credit_audit',
    event,
    audit_id: auditId,
    ...fields,
  }
  console[level](JSON.stringify(payload))
}

export async function subscriptionWalletFingerprint(walletId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(walletId))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function subscriptionTransactionFingerprint(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function safeSubscriptionFailureCode(stage: string, error: unknown): string {
  const message = error instanceof Error
    ? error.message
    : error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
      ? error.message
      : ''
  if (message) {
    const appleStatus = message.match(/receipt verification failed with status (\d+)/i)
    if (appleStatus) return `apple_receipt_status_${appleStatus[1]}`
    if (error instanceof Error && error.name === 'WalletAccessError') return 'wallet_access_rejected'
    const conflicts: Array<[string, string]> = [
      ['subscription owner transfer requires review', 'subscription_owner_transfer_requires_review'],
      ['subscription token change requires review', 'subscription_token_change_requires_review'],
      ['subscription cycle belongs to another wallet', 'subscription_cycle_wallet_mismatch'],
      ['subscription plan change requires Apple current-status verification', 'subscription_plan_change_unverified'],
      ['stale subscription transaction', 'stale_subscription_transaction'],
      ['Google subscription owner transfer requires review', 'google_subscription_owner_transfer_requires_review'],
      ['Google subscription token change requires review', 'google_subscription_token_change_requires_review'],
      ['Google subscription plan change requires verified active purchase', 'google_subscription_plan_change_unverified'],
    ]
    const conflict = conflicts.find(([needle]) => message.includes(needle))
    if (conflict) return conflict[1]
  }
  return `stage_${stage}`
}

export function subscriptionFailureHttpStatus(error: unknown): number | null {
  const conflictCodes = new Set([
    'subscription_owner_transfer_requires_review',
    'subscription_token_change_requires_review',
    'subscription_cycle_wallet_mismatch',
    'subscription_plan_change_unverified',
    'stale_subscription_transaction',
  ])
  const code = safeSubscriptionFailureCode('', error)
  return conflictCodes.has(code) ? 409 : null
}

// Page by the unique ID: neither requests nor distinct wallets stop at the API row cap.
export async function readSubscriptionFailures(db: any, start: string, end: string, environment?: string): Promise<any[]> {
  const rows: any[] = []
  for (let from = 0; ; from += 1000) {
    let query = db.from('subscription_sync_failures')
      .select('id,resolved_wallet_id,environment,stage,failure_code,product,detail')
      .gte('created_at', start).lt('created_at', end).order('id')
    if (environment) query = query.eq('environment', environment)
    const result = await query.range(from, from + 999)
    if (result.error || !Array.isArray(result.data)) throw new Error('subscription_failure_counts_failed')
    rows.push(...result.data)
    if (result.data.length < 1000) return rows
  }
}

export function countSubscriptionFailures(rows: any[]): { failures: number; wallets: number; unresolved: number } {
  const wallets = new Set(rows.map(row => row.resolved_wallet_id).filter(id => typeof id === 'string' && id.length > 0))
  return { failures: rows.length, wallets: wallets.size,
    unresolved: rows.filter(row => !row.resolved_wallet_id).length }
}

export function kstDayStart(now = Date.now()): string {
  return new Date(Math.floor((now + 9 * 3600_000) / 86400_000) * 86400_000 - 9 * 3600_000).toISOString()
}

export async function readSubscriptionActivity(db: any, start: string, end: string) {
  const errors: string[] = []
  const groups = ['Production', 'Sandbox', 'Unknown'].map(environment => ({
    environment, failures: null as number | null, wallets: null as number | null, unresolved: null as number | null,
    verifiedCurrentProductGrants: 0 as number | null, manualRepairGrants: 0 as number | null, renewalGrants: 0 as number | null,
    confirmedPlanChangeGrants: 0 as number | null, unclassifiedGrants: 0 as number | null,
  }))
  try {
    const failures = await readSubscriptionFailures(db, start, end)
    for (const group of groups) Object.assign(group, countSubscriptionFailures(failures.filter(row =>
      (['Production', 'Sandbox'].includes(row.environment) ? row.environment : 'Unknown') === group.environment)))
  } catch { errors.push('subscription_failure_counts_failed') }
  try {
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db.from('credit_transactions').select('id,metadata')
        .eq('transaction_type', 'subscription_monthly_grant')
        .gte('created_at', start).lt('created_at', end).order('id').range(from, from + 999)
      if (error || !Array.isArray(data)) throw new Error('subscription_activity_counts_failed')
      for (const row of data) {
        const metadata = row.metadata ?? {}
        const group = groups.find(group => group.environment === metadata.environment) ?? groups[2]
        if (metadata.source === 'apple_notification_renewal') group.renewalGrants! += 1
        // This flag is caller metadata, not a DB-generated change event. Never call it a success count.
        if (metadata.apple_current_product_verified === true && !metadata.source) group.verifiedCurrentProductGrants! += 1
        if (metadata.source === 'reconcile_20261017') group.manualRepairGrants! += 1
        const event = metadata.subscription_audit
        const knownProducts = ['com.kingboard.app.monthly_basic', 'com.kingboard.app.monthly_premium', 'com.kingboard.app.monthly_pro']
        const marked = event?.version === 1 &&
          ['subscription_grant', 'plan_change_applied'].includes(event.event) &&
          event.product_id === metadata.productId && event.environment === metadata.environment &&
          knownProducts.includes(event.product_id) && typeof metadata.audit_id === 'string'
        const confirmedChange = marked && event.event === 'plan_change_applied' &&
            metadata.apple_current_product_verified === true && !metadata.source &&
            knownProducts.includes(event.previous_product_id) && event.previous_product_id !== event.product_id
        if (confirmedChange) {
          group.confirmedPlanChangeGrants! += 1
        } else if (!(marked && event.event === 'subscription_grant') &&
            metadata.source !== 'apple_notification_renewal' && metadata.source !== 'reconcile_20261017') {
          group.unclassifiedGrants! += 1
        }
      }
      if (data.length < 1000) break
    }
  } catch {
    errors.push('subscription_activity_counts_failed')
    for (const group of groups) {
      group.verifiedCurrentProductGrants = null
      group.manualRepairGrants = null
      group.renewalGrants = null
      group.confirmedPlanChangeGrants = null
      group.unclassifiedGrants = null
    }
  }
  return { groups, errors,
    planChangeSuccesses: groups.every(group => group.confirmedPlanChangeGrants !== null)
      ? groups.reduce((sum, group) => sum + group.confirmedPlanChangeGrants!, 0) : null,
    planChangeCoverage: 'versioned_atomic_grants_only',
  }
}

export function subscriptionActivityText(activity: Awaited<ReturnType<typeof readSubscriptionActivity>>): string {
  const labels: Record<string, string> = { Production: '실제', Sandbox: '테스트', Unknown: '환경 미확인' }
  const n = (value: number | null, unit: string) => value === null ? '집계 불가' : `${value}${unit}`
  return activity.groups.map(group =>
    `구독 ${labels[group.environment]}: 실패 요청 ${n(group.failures, '건')} · 확인 지갑 ${n(group.wallets, '개')} · 지갑 미확인 ${n(group.unresolved, '건')}\n` +
    `  플랜 변경 지급 성공 ${n(group.confirmedPlanChangeGrants, '건')} · 갱신 지급 ${n(group.renewalGrants, '건')} · 수동 복구 지급 ${n(group.manualRepairGrants, '건')}\n` +
    `  변경 여부 미분류 지급 ${n(group.unclassifiedGrants, '건')}\n`
  ).join('') + '※ 플랜 변경은 구분 기록 도입 후 원자적 지급 성공 건수입니다. 미분류는 변경 0건으로 해석하지 않으며, 신규 구독자 수·예약 변경 수와 다릅니다.\n'
}
