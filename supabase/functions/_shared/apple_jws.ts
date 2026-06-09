// Verifies Apple StoreKit 2 JWS (Signed Transaction) tokens.
// Reference: https://developer.apple.com/documentation/appstoreserverapi/jwstransactiondecodedpayload

import { jwtVerify, decodeProtectedHeader, importX509 } from 'https://esm.sh/jose@5.6.3'


export interface AppleTransactionPayload {
  bundleId: string
  productId: string
  transactionId: string
  originalTransactionId: string
  purchaseDate: number          // ms since epoch
  originalPurchaseDate: number
  expiresDate?: number          // ms since epoch, subscription only
  environment: 'Sandbox' | 'Production' | string
  type: string                  // e.g. "Auto-Renewable Subscription"
  [key: string]: unknown
}

function derB64ToPem(base64Der: string): string {
  const lines: string[] = []
  for (let i = 0; i < base64Der.length; i += 64) {
    lines.push(base64Der.slice(i, i + 64))
  }
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----`
}


export async function verifyAppleJWS(jws: string): Promise<AppleTransactionPayload> {
  const header = decodeProtectedHeader(jws) as { alg?: string; x5c?: string[] }

  if (!Array.isArray(header.x5c) || header.x5c.length < 2) {
    throw new Error('Apple JWS is missing a valid certificate chain (x5c).')
  }

  // Verify the JWS signature using the leaf certificate's public key.
  const leafPem = derB64ToPem(header.x5c[0])
  const publicKey = await importX509(leafPem, header.alg ?? 'ES256')
  const { payload } = await jwtVerify(jws, publicKey)

  const p = payload as Record<string, unknown>
  if (!p['bundleId'] || !p['productId'] || !p['transactionId']) {
    throw new Error('JWS payload is missing required transaction fields.')
  }

  return p as unknown as AppleTransactionPayload
}
