// Pure checks for a Google Play credit pack claim. `purchase` is Google's server record
// (purchases.products.get), never the client's word. Kept free of Deno APIs for plain Node tests.
import { CREDIT_PACK_PRODUCTS, CreditPackClaimError } from './credit_pack_validation.ts'

export type GooglePackClaim = {
  orderId: string
  productId: string
  environment: 'Production' | 'Sandbox'
  credits: number
}

const GOOGLE_ACCOUNT_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const GOOGLE_ORDER_ID = /^GPA\.[0-9A-Za-z.-]{1,124}$/

export function validateGooglePackClaim(input: {
  productId: string
  purchase: Record<string, unknown>
  expectedAccountToken: string
}): GooglePackClaim {
  const { productId, purchase, expectedAccountToken } = input
  if (!GOOGLE_ACCOUNT_TOKEN.test(expectedAccountToken)) throw new CreditPackClaimError('missing_account_binding')
  if (!Object.hasOwn(CREDIT_PACK_PRODUCTS, productId)) throw new CreditPackClaimError('unknown_product')
  if (purchase.productId != null && purchase.productId !== productId) throw new CreditPackClaimError('transaction_mismatch')
  // Pending (e.g. convenience-store payment) is not final: the app retries, or the real-time
  // notification grants it once Google reports PURCHASED.
  if (purchase.purchaseState === 2) throw new CreditPackClaimError('purchase_pending')
  if (purchase.purchaseState === 1) throw new CreditPackClaimError('transaction_revoked')
  if (purchase.purchaseState !== 0) throw new CreditPackClaimError('unsupported_purchase')
  if (typeof purchase.obfuscatedExternalAccountId !== 'string' ||
      purchase.obfuscatedExternalAccountId.toLowerCase() !== expectedAccountToken.toLowerCase()) {
    throw new CreditPackClaimError('account_binding_mismatch')
  }
  // Packs are bought one at a time; rewarded products are not packs.
  if ((purchase.quantity ?? 1) !== 1 || purchase.purchaseType === 2) {
    throw new CreditPackClaimError('unsupported_purchase')
  }
  if (typeof purchase.orderId !== 'string' || !GOOGLE_ORDER_ID.test(purchase.orderId)) {
    throw new CreditPackClaimError('invalid_transaction_id')
  }
  return {
    orderId: purchase.orderId,
    productId,
    // License-tester purchases are free test orders, like Apple Sandbox. Promo codes are real.
    environment: purchase.purchaseType === 0 ? 'Sandbox' : 'Production',
    credits: CREDIT_PACK_PRODUCTS[productId],
  }
}
