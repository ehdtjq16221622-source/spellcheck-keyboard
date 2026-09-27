import { decodeJwt, importPKCS8, SignJWT } from 'https://esm.sh/jose@5.6.3'

type AppleStatusResponse = {
  bundleId?: string
  data?: Array<{ lastTransactions?: Array<{
    originalTransactionId?: string
    status?: number
    signedTransactionInfo?: string
  }> }>
}

export async function verifyActiveApplePurchase(
  originalTransactionId: string,
  productId: string,
  expectedBundleId: string,
): Promise<boolean> {
  if (!/^[0-9]+$/.test(originalTransactionId)) return false
  const encodedKey = Deno.env.get('APPLE_IAP_KEY_B64')
  const keyId = Deno.env.get('APPLE_IAP_KEY_ID')
  const issuerId = Deno.env.get('APPLE_IAP_ISSUER_ID')
  if (!encodedKey || !keyId || !issuerId) throw new Error('Apple server API credentials are unavailable')

  const key = await importPKCS8(atob(encodedKey), 'ES256')
  const now = Math.floor(Date.now() / 1000)
  const jwt = await new SignJWT({ bid: expectedBundleId })
    .setProtectedHeader({ alg: 'ES256', kid: keyId, typ: 'JWT' })
    .setIssuer(issuerId)
    .setIssuedAt(now)
    .setExpirationTime(now + 600)
    .setAudience('appstoreconnect-v1')
    .sign(key)

  for (const base of [
    'https://api.storekit.apple.com',
    'https://api.storekit-sandbox.apple.com',
  ]) {
    const response = await fetch(`${base}/inApps/v1/subscriptions/${originalTransactionId}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    })
    if (response.status === 404 && base.includes('api.storekit.apple.com')) {
      const error = await response.json().catch(() => null) as { errorCode?: number } | null
      if (error?.errorCode === 4040010) continue
    }
    if (!response.ok) throw new Error(`Apple subscription status request failed: ${response.status}`)
    const body = await response.json() as AppleStatusResponse
    if (body.bundleId !== expectedBundleId || !Array.isArray(body.data)) return false
    return body.data.some((group) => group.lastTransactions?.some((item) => {
      if (item.originalTransactionId !== originalTransactionId || item.status !== 1 ||
          !item.signedTransactionInfo) return false
      // The JWS comes directly from Apple's authenticated HTTPS response.
      const transaction = decodeJwt(item.signedTransactionInfo)
      return transaction.bundleId === expectedBundleId &&
        transaction.originalTransactionId === originalTransactionId &&
        transaction.productId === productId &&
        typeof transaction.expiresDate === 'number' && transaction.expiresDate > Date.now() &&
        transaction.revocationDate == null
    }) === true)
  }
  return false
}
