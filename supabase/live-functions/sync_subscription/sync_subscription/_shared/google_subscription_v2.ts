// Android subscriptions on the current plans. Pure mapping from Google's verified record to the
// sync_google_subscription_v2_once input, kept free of Deno APIs for plain Node tests.
// Plan credits must match iOS (_shared/credits.ts PLAN1..PLAN4_MONTHLY_CREDITS); a test checks it.

export const GOOGLE_V2_PLAN_CREDITS: Readonly<Record<string, number>> = Object.freeze({
  'com.kingboard.app.monthly_basic': 4000,
  'com.kingboard.app.monthly_premium': 9000,
  'com.kingboard.app.monthly_pro': 30000,
  'com.kingboard.app.monthly_max': 50000,
})

export function isGoogleV2Product(productId: unknown): productId is string {
  return typeof productId === 'string' && Object.hasOwn(GOOGLE_V2_PLAN_CREDITS, productId)
}

export class GoogleSubscriptionInputError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.name = 'GoogleSubscriptionInputError'
    this.code = code
  }
}

export type GoogleVerifiedSubscription = {
  active: boolean
  state: string
  expiryTimeMillis: number | null
  linkedPurchaseToken: string | null
}

export type GoogleV2SyncInput = {
  state: 'SUBSCRIPTION_STATE_ACTIVE' | 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD' | 'SUBSCRIPTION_STATE_ON_HOLD' |
    'SUBSCRIPTION_STATE_PAUSED' | 'SUBSCRIPTION_STATE_EXPIRED'
  expiryTimeMillis: number | null
  cycleKey: string | null
  amount: number
  linkedPurchaseToken: string | null
}

export function googleV2SyncInput(
  verified: GoogleVerifiedSubscription,
  productId: string,
  purchaseToken: string,
  nowMs = Date.now(),
): GoogleV2SyncInput {
  if (!isGoogleV2Product(productId)) throw new GoogleSubscriptionInputError('unknown_subscription_product')
  if (purchaseToken.length === 0 || purchaseToken.length > 512 || purchaseToken.includes(':')) {
    throw new GoogleSubscriptionInputError('invalid_purchase_token')
  }
  const amount = GOOGLE_V2_PLAN_CREDITS[productId]
  const expiry = verified.expiryTimeMillis
  const linked = verified.linkedPurchaseToken && verified.linkedPurchaseToken !== purchaseToken
    ? verified.linkedPurchaseToken : null
  const base = { expiryTimeMillis: expiry, amount, linkedPurchaseToken: linked }
  switch (verified.state) {
    case 'SUBSCRIPTION_STATE_PENDING':
      throw new GoogleSubscriptionInputError('subscription_pending')
    case 'SUBSCRIPTION_STATE_ACTIVE':
    case 'SUBSCRIPTION_STATE_CANCELED':
      // Canceled = auto-renew off; the paid period still runs until expiry, like iOS.
      if (expiry != null && expiry > nowMs) {
        return { ...base, state: 'SUBSCRIPTION_STATE_ACTIVE', cycleKey: `${purchaseToken}:${productId}:${expiry}` }
      }
      return { ...base, state: 'SUBSCRIPTION_STATE_EXPIRED', cycleKey: null }
    case 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD':
    case 'SUBSCRIPTION_STATE_ON_HOLD':
    case 'SUBSCRIPTION_STATE_PAUSED':
      return { ...base, state: verified.state, cycleKey: null }
    default:
      // EXPIRED, PENDING_PURCHASE_CANCELED, or anything new: never a grant.
      return { ...base, state: 'SUBSCRIPTION_STATE_EXPIRED', cycleKey: null }
  }
}
