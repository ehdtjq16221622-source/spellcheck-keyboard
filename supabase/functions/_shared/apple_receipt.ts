const APPLE_VERIFY_RECEIPT_PRODUCTION = 'https://buy.itunes.apple.com/verifyReceipt'
const APPLE_VERIFY_RECEIPT_SANDBOX = 'https://sandbox.itunes.apple.com/verifyReceipt'

type LatestReceiptInfo = {
  product_id?: string
  expires_date_ms?: string
  original_transaction_id?: string
  transaction_id?: string
  web_order_line_item_id?: string
  cancellation_date_ms?: string
}

type VerifyReceiptResponse = {
  status?: number
  environment?: string
  receipt?: {
    bundle_id?: string
  }
  latest_receipt_info?: LatestReceiptInfo[] | LatestReceiptInfo
  latest_receipt?: string
}

export type VerifiedAppleSubscription = {
  active: boolean
  state: string
  expiryTimeMillis: number | null
  cycleKey: string | null
  orderId: string | null
  originalTransactionId: string | null
  latestReceipt: string | null
  environment: string | null
}

function toLatestReceiptArray(
  latestReceiptInfo?: LatestReceiptInfo[] | LatestReceiptInfo
): LatestReceiptInfo[] {
  if (!latestReceiptInfo) return []
  return Array.isArray(latestReceiptInfo) ? latestReceiptInfo : [latestReceiptInfo]
}

function toMillis(value?: string): number | null {
  if (!value) return null
  const millis = Number(value)
  return Number.isFinite(millis) ? millis : null
}

function latestMatchingTransaction(
  transactions: LatestReceiptInfo[],
  productId: string
): LatestReceiptInfo | null {
  const matching = transactions.filter((transaction) => transaction.product_id === productId)
  const pool = matching.length > 0 ? matching : transactions
  if (pool.length === 0) return null

  return [...pool].sort((a, b) => {
    const aMillis = toMillis(a.expires_date_ms) ?? 0
    const bMillis = toMillis(b.expires_date_ms) ?? 0
    return bMillis - aMillis
  })[0] ?? null
}

async function verifyReceipt(
  endpoint: string,
  receiptData: string,
  sharedSecret?: string
): Promise<VerifyReceiptResponse> {
  const payload: Record<string, unknown> = {
    'receipt-data': receiptData,
    'exclude-old-transactions': false,
  }
  if (sharedSecret) {
    payload.password = sharedSecret
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  const json = (await response.json()) as VerifyReceiptResponse
  if (!response.ok) {
    throw new Error('Failed to verify receipt with App Store.')
  }
  return json
}

export async function verifyAppleSubscription(
  receiptData: string,
  productId: string,
  expectedBundleId?: string
): Promise<VerifiedAppleSubscription> {
  const sharedSecret = Deno.env.get('APPLE_SHARED_SECRET') ?? undefined

  let json = await verifyReceipt(
    APPLE_VERIFY_RECEIPT_PRODUCTION,
    receiptData,
    sharedSecret
  )

  if (json.status === 21007) {
    json = await verifyReceipt(
      APPLE_VERIFY_RECEIPT_SANDBOX,
      receiptData,
      sharedSecret
    )
  } else if (json.status === 21008) {
    json = await verifyReceipt(
      APPLE_VERIFY_RECEIPT_PRODUCTION,
      receiptData,
      sharedSecret
    )
  }

  if (json.status !== 0) {
    throw new Error(`App Store receipt verification failed with status ${json.status ?? 'unknown'}.`)
  }

  const bundleId = json.receipt?.bundle_id
  if (expectedBundleId && bundleId && expectedBundleId !== bundleId) {
    throw new Error('Receipt belongs to a different app bundle.')
  }

  const latest = latestMatchingTransaction(
    toLatestReceiptArray(json.latest_receipt_info),
    productId
  )
  if (!latest) {
    return {
      active: false,
      state: 'SUBSCRIPTION_STATE_NOT_FOUND',
      expiryTimeMillis: null,
      cycleKey: null,
      orderId: null,
      originalTransactionId: null,
      latestReceipt: json.latest_receipt ?? null,
      environment: json.environment ?? null,
    }
  }

  const expiryTimeMillis = toMillis(latest.expires_date_ms)
  const cancellationTimeMillis = toMillis(latest.cancellation_date_ms)
  const isActive = expiryTimeMillis != null && expiryTimeMillis > Date.now()
  const state =
    cancellationTimeMillis != null
      ? 'SUBSCRIPTION_STATE_CANCELED'
      : isActive
        ? 'SUBSCRIPTION_STATE_ACTIVE'
        : 'SUBSCRIPTION_STATE_EXPIRED'

  return {
    active: isActive,
    state,
    expiryTimeMillis,
    cycleKey: latest.expires_date_ms ?? latest.web_order_line_item_id ?? null,
    orderId: latest.transaction_id ?? null,
    originalTransactionId: latest.original_transaction_id ?? latest.transaction_id ?? null,
    latestReceipt: json.latest_receipt ?? null,
    environment: json.environment ?? null,
  }
}
