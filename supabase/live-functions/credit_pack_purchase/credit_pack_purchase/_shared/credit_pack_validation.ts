// Pure checks for a credit pack claim. Both payloads must already be signature-verified against
// Apple's roots: `submitted` is the JWS the app sent, `current` is Apple's server record fetched
// by transactionId. Kept free of Deno APIs so it can be unit-tested with plain Node.

export const CREDIT_PACK_PRODUCTS: Readonly<Record<string, number>> = Object.freeze({
  'com.kingboard.app.credits_7000': 7000,
  'com.kingboard.app.credits_18000': 18000,
})

export type CreditPackClaim = {
  transactionId: string
  originalTransactionId: string
  productId: string
  environment: 'Production' | 'Sandbox'
  credits: number
}

export class CreditPackClaimError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.code = code
    this.name = 'CreditPackClaimError'
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NUMERIC_ID = /^[0-9]{1,128}$/

export function validateCreditPackClaim(input: {
  submitted: Record<string, unknown>
  current: Record<string, unknown>
  expectedBundleId: string
  expectedAccountToken: string
}): CreditPackClaim {
  const { submitted, current, expectedBundleId, expectedAccountToken } = input
  if (!UUID.test(expectedAccountToken)) throw new CreditPackClaimError('missing_account_binding')
  const environment = submitted.environment
  if (environment !== 'Production' && environment !== 'Sandbox') throw new CreditPackClaimError('invalid_environment')
  for (const payload of [submitted, current]) {
    if (payload.bundleId !== expectedBundleId || payload.environment !== environment) {
      throw new CreditPackClaimError('transaction_context_mismatch')
    }
    if (typeof payload.transactionId !== 'string' || !NUMERIC_ID.test(payload.transactionId) ||
        typeof payload.originalTransactionId !== 'string' || !NUMERIC_ID.test(payload.originalTransactionId)) {
      throw new CreditPackClaimError('invalid_transaction_id')
    }
    if (typeof payload.productId !== 'string' || !Object.hasOwn(CREDIT_PACK_PRODUCTS, payload.productId)) {
      throw new CreditPackClaimError('unknown_product')
    }
    if (typeof payload.appAccountToken !== 'string' ||
        payload.appAccountToken.toLowerCase() !== expectedAccountToken.toLowerCase()) {
      throw new CreditPackClaimError('account_binding_mismatch')
    }
    // Family Sharing never applies to consumables; quantity is fixed to 1 in the app.
    if (payload.quantity !== 1 || payload.inAppOwnershipType !== 'PURCHASED') {
      throw new CreditPackClaimError('unsupported_purchase')
    }
  }
  if (submitted.transactionId !== current.transactionId || submitted.productId !== current.productId ||
      submitted.originalTransactionId !== current.originalTransactionId) {
    throw new CreditPackClaimError('transaction_mismatch')
  }
  if (current.revocationDate != null || current.revocationReason != null) {
    throw new CreditPackClaimError('transaction_revoked')
  }
  const productId = current.productId as string
  return {
    transactionId: current.transactionId as string,
    originalTransactionId: current.originalTransactionId as string,
    productId,
    environment,
    credits: CREDIT_PACK_PRODUCTS[productId],
  }
}
