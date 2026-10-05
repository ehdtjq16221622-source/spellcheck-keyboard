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

