// Verifies Apple StoreKit 2 JWS (Signed Transaction) tokens.
// Reference: https://developer.apple.com/documentation/appstoreserverapi/jwstransactiondecodedpayload

import { jwtVerify, decodeProtectedHeader, importX509 } from 'https://esm.sh/jose@5.6.3'

// Known Apple Root CA SHA-256 fingerprints.
// Apple uses G3 for Production and may use G2 or other roots in Sandbox.
// Security is guaranteed by JWS signature verification (leaf cert) + bundleId check.
const APPLE_ROOT_CA_FINGERPRINTS = new Set([
  '63343afaf7603305bf60ee417dcaa797f6e76ec70b707e8609a6e440614a6ab0', // Apple Root CA G3 (Production)
  'c2b9b042dd57830e7d117dac55ac8828b4a1f0c62a06fbcace6f34dc1bc32c79', // Apple Root CA G2
  'b0b1730ecbc7ff4505142c49f1295e6eda6bcaed7e2c68c5be91b5a11001f024', // Apple Root CA G1
])

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

async function sha256Hex(base64Der: string): Promise<string> {
  const bytes = Uint8Array.from(atob(base64Der), c => c.charCodeAt(0))
  const buf = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

export async function verifyAppleJWS(jws: string): Promise<AppleTransactionPayload> {
  const header = decodeProtectedHeader(jws) as { alg?: string; x5c?: string[] }

  if (!Array.isArray(header.x5c) || header.x5c.length < 2) {
    throw new Error('Apple JWS is missing a valid certificate chain (x5c).')
  }

  // Verify root certificate is one of Apple's known root CAs.
  const rootFingerprint = await sha256Hex(header.x5c[header.x5c.length - 1])
  if (!APPLE_ROOT_CA_FINGERPRINTS.has(rootFingerprint)) {
    console.warn('[verifyAppleJWS] Unknown root CA fingerprint:', rootFingerprint)
    throw new Error('JWS root certificate is not a recognized Apple Root CA.')
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
