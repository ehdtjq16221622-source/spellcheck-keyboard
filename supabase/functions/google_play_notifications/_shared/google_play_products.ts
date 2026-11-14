// Google Play one-time products (credit packs): read a purchase and consume it.
// API: https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.products
import { getAccessToken } from './google_play.ts'

const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications'

/** The subset of ProductPurchase that the claim checks use. */
export type GoogleProductPurchase = {
  orderId?: string
  purchaseState?: number // 0 purchased, 1 canceled, 2 pending
  consumptionState?: number // 0 not consumed, 1 consumed
  acknowledgementState?: number
  purchaseType?: number // absent = real purchase, 0 test (license tester), 1 promo code, 2 rewarded
  quantity?: number
  obfuscatedExternalAccountId?: string
  productId?: string
}

export class GooglePlayApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'GooglePlayApiError'
    this.status = status
  }
}

function productUrl(packageName: string, productId: string, purchaseToken: string): string {
  return `${API}/${encodeURIComponent(packageName)}/purchases/products/${encodeURIComponent(productId)}` +
    `/tokens/${encodeURIComponent(purchaseToken)}`
}

export async function getProductPurchase(
  packageName: string, productId: string, purchaseToken: string,
): Promise<GoogleProductPurchase> {
  const response = await fetch(productUrl(packageName, productId, purchaseToken), {
    headers: { Authorization: `Bearer ${await getAccessToken()}` },
  })
  const json = await response.json().catch(() => ({})) as GoogleProductPurchase & { error?: { message?: string } }
  if (!response.ok) throw new GooglePlayApiError(json.error?.message ?? 'google_product_lookup_failed', response.status)
  return json
}

/** Consuming also acknowledges, so Play will not auto-refund the order after 3 days. */
export async function consumeProductPurchase(
  packageName: string, productId: string, purchaseToken: string,
): Promise<void> {
  const response = await fetch(`${productUrl(packageName, productId, purchaseToken)}:consume`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await getAccessToken()}` },
  })
  if (!response.ok) {
    const json = await response.json().catch(() => ({})) as { error?: { message?: string } }
    throw new GooglePlayApiError(json.error?.message ?? 'google_product_consume_failed', response.status)
  }
}

export async function purchaseTokenHash(purchaseToken: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(purchaseToken))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}
