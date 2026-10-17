// TEMPORARY, READ-ONLY: compares each active subscription in device_subscriptions with Apple's
// current state. Writes nothing. Delete after use.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { Environment, SignedDataVerifier } from 'npm:@apple/app-store-server-library@3.1.0'
import { importPKCS8, SignJWT } from 'https://esm.sh/jose@5.6.3'
import { verifyAppleSignedTransactionPortable } from '../_shared/apple_subscription_portable.ts'

const TOKEN_HASH = '35cc3a7dca94a3d3fb3132159123a7097522a8e629d4ceff307ed883f6ec0b9b'
const APPLE_APP_ID = 6762074672
const BUNDLE_ID = 'com.kingboard.app'
const ROOTS = ["MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwSQXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcNMTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBSb290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtfTjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySrMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gAMGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM6BgD56KyKA==","MIIFkjCCA3qgAwIBAgIIAeDltYNno+AwDQYJKoZIhvcNAQEMBQAwZzEbMBkGA1UEAwwSQXBwbGUgUm9vdCBDQSAtIEcyMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcNMTQwNDMwMTgxMDA5WhcNMzkwNDMwMTgxMDA5WjBnMRswGQYDVQQDDBJBcHBsZSBSb290IENBIC0gRzIxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBANgREkhI2imKScUcx+xuM23+TfvgHN6sXuI2pyT5f1BrTM65MFQn5bPW7SXmMLYFN14UIhHF6Kob0vuy0gmVOKTvKkmMXT5xZgM4+xb1hYjkWpIMBDLyyED7Ul+f9sDx47pFoFDVEovy3d6RhiPw9bZyLgHaC/YuOQhfGaFjQQscp5TBhsRTL3b2CtcM0YM/GlMZ81fVJ3/8E7j4ko380yhDPLVoACVdJ2LT3VXdRCCQgzWTxb+4Gftr49wIQuavbfqeQMpOhYV4SbHXw8EwOTKrfl+q04tvny0aIWhwZ7Oj8ZhBbZF8+NfbqOdfIRqMM78xdLe40fTgIvS/cjTf94FNcX1RoeKz8NMoFnNvzcytN31O661A4T+B/fc9Cj6i8b0xlilZ3MIZgIxbdMYs0xBTJh0UT8TUgWY8h2czJxQI6bR3hDRSj4n4aJgXv8O7qhOTH11UL6jHfPsNFL4VPSQ08prcdUFmIrQB1guvkJ4M6mL4m1k8COKWNORj3rw31OsMiANDC1CvoDTdUE0V+1ok2Az6DGOeHwOx4e7hqkP0ZmUoNwIx7wHHHtHMn23KVDpA287PT0aLSmWaasZobNfMmRtHsHLDd4/E92GcdB/O/WuhwpyUgquUoue9G7q5cDmVF8Up8zlYNPXEpMZ7YLlmQ1A/bmH8DvmGqmAMQ0uVAgMBAAGjQjBAMB0GA1UdDgQWBBTEmRNsGAPCe8CjoA1/coB6HHcmjTAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjANBgkqhkiG9w0BAQwFAAOCAgEAUabz4vS4PZO/Lc4Pu1vhVRROTtHlznldgX/+tvCHM/jvlOV+3Gp5pxy+8JS3ptEwnMgNCnWefZKVfhidfsJxaXwU6s+DDuQUQp50DhDNqxq6EWGBeNjxtUVAeKuowM77fWM3aPbn+6/Gw0vsHzYmE1SGlHKy6gLti23kDKaQwFd1z4xCfVzmMX3zybKSaUYOiPjjLUKyOKimGY3xn83uamW8GrAlvacp/fQ+onVJv57byfenHmOZ4VxG/5IFjPoeIPmGlFYl5bRXOJ3riGQUIUkhOb9iZqmxospvPyFgxYnURTbImHy99v6ZSYA7LNKmp4gDBDEZt7Y6YUX6yfIjyGNzv1aJMbDZfGKnexWoiIqrOEDCzBL/FePwN983csvMmOa/orz6JopxVtfnJBtIRD6e/J/JzBrsQzwBvDR4yGn1xuZW7AYJNpDrFEobXsmII9oDMJELuDY++ee1KG++P+w8j2Ud5cAeh6Squpj9kuNsJnfdBrRkBof0Tta6SqoWqPQFZ2aWuuJVecMsXUmPgEkrihLHdoBR37q9ZV0+N0djMenl9MU/S60EinpxLK8JQzcPqOMyT/RFtm2XNuyE9QoB6he7hY1Ck3DDUOUUi78/w0EP3SIEIwiKum1xRKtzCTrJ+VKACd+66eYWyi4uTLLT3OUEVLLUNIAytbwPF+E="].map((b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

function decodePayload(jws: string): Record<string, unknown> | null {
  try {
    const part = jws.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part.padEnd(Math.ceil(part.length / 4) * 4, '=')), (c) => c.charCodeAt(0))))
  } catch { return null }
}

async function appleJwt(): Promise<string> {
  const key = await importPKCS8(atob(Deno.env.get('APPLE_IAP_KEY_B64')!), 'ES256')
  const now = Math.floor(Date.now() / 1000)
  return await new SignJWT({ bid: BUNDLE_ID })
    .setProtectedHeader({ alg: 'ES256', kid: Deno.env.get('APPLE_IAP_KEY_ID')!, typ: 'JWT' })
    .setIssuer(Deno.env.get('APPLE_IAP_ISSUER_ID')!)
    .setIssuedAt(now).setExpirationTime(now + 600).setAudience('appstoreconnect-v1')
    .sign(key)
}

async function checkOne(jwt: string, originalTransactionId: string) {
  for (const base of ['https://api.storekit.apple.com', 'https://api.storekit-sandbox.apple.com']) {
    const response = await fetch(`${base}/inApps/v1/subscriptions/${originalTransactionId}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    })
    if (response.status === 404 && !base.includes('sandbox')) {
      const error = await response.json().catch(() => null) as { errorCode?: number } | null
      if (error?.errorCode === 4040010) continue
      return { error: 'not_found_404' }
    }
    if (!response.ok) return { error: `http_${response.status}` }
    const body = await response.json() as { data?: Array<{ lastTransactions?: Array<Record<string, unknown>> }> }
    const environment = base.includes('sandbox') ? Environment.SANDBOX : Environment.PRODUCTION
    for (const group of body.data ?? []) {
      for (const item of group.lastTransactions ?? []) {
        if (item.originalTransactionId !== originalTransactionId) continue
        const signed = String(item.signedTransactionInfo ?? '')
        let strict = 'ok'
        try {
          const verifier = new SignedDataVerifier(ROOTS as never, true, environment, BUNDLE_ID,
            environment === Environment.PRODUCTION ? APPLE_APP_ID : undefined)
          await verifier.verifyAndDecodeTransaction(signed)
        } catch (error) {
          const status = (error as { status?: unknown })?.status
          strict = `fail_${typeof status === 'number' ? status : 'x'}`
        }
        let portable = 'ok'
        let tx: Record<string, unknown> | null = null
        try {
          tx = await verifyAppleSignedTransactionPortable(signed, BUNDLE_ID, environment, ROOTS) as unknown as Record<string, unknown>
        } catch (error) {
          portable = `fail_${error instanceof Error && /^[a-z_]{1,48}$/.test(error.message) ? error.message : 'x'}`
        }
        const renewal = item.signedRenewalInfo ? decodePayload(String(item.signedRenewalInfo)) : null
        const unverified = tx ?? decodePayload(signed)
        return {
          environment,
          appleStatus: item.status,
          strict, portable,
          appleProduct: unverified?.productId ?? null,
          appleExpiresMs: unverified?.expiresDate ?? null,
          appleRevoked: unverified?.revocationDate != null,
          appleTransactionId: unverified?.transactionId ?? null,
          renewalProduct: renewal?.autoRenewProductId ?? null,
          renewalStatus: renewal?.autoRenewStatus ?? null,
          price: unverified?.price ?? null, currency: unverified?.currency ?? null,
          offerType: unverified?.offerType ?? null, offerDiscountType: unverified?.offerDiscountType ?? null,
          ownership: unverified?.inAppOwnershipType ?? null, reason: unverified?.transactionReason ?? null,
          purchaseMs: unverified?.purchaseDate ?? null, originalPurchaseMs: unverified?.originalPurchaseDate ?? null,
          storefront: unverified?.storefront ?? null,
        }
      }
    }
    return { error: 'transaction_not_in_response', environment }
  }
  return { error: 'not_found' }
}

Deno.serve(async (req: Request) => {
  const token = req.headers.get('x-audit-token') ?? ''
  if (!token || await sha256Hex(token) !== TOKEN_HASH) return new Response('forbidden', { status: 403 })
  const { offset = 0, limit = 60, wallets } = await req.json().catch(() => ({}))
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  let query = db.from('device_subscriptions')
    .select('device_id, product_id, purchase_token, expiry_time_millis, updated_at')
  if (Array.isArray(wallets) && wallets.length) query = query.in('device_id', wallets.slice(0, 50).map(String))
  const { data: rows, error } = await query
    .eq('subscription_state', 'SUBSCRIPTION_STATE_ACTIVE')
    .gt('expiry_time_millis', Date.now())
    .order('device_id')
    .range(Number(offset), Number(offset) + Math.min(Number(limit), 80) - 1)
  if (error) return Response.json({ error: error.message }, { status: 500 })
  const jwt = await appleJwt()
  const results: Record<string, unknown>[] = []
  const queue = [...(rows ?? [])]
  async function worker() {
    while (queue.length) {
      const row = queue.shift()!
      let apple: Record<string, unknown>
      try { apple = await checkOne(jwt, String(row.purchase_token)) } catch (e) { apple = { error: 'exception', message: String(e).slice(0, 120) } }
      results.push({
        wallet: row.device_id, dbProduct: row.product_id, dbExpiresMs: row.expiry_time_millis,
        dbUpdated: row.updated_at, originalTransactionId: row.purchase_token, ...apple,
      })
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker))
  return Response.json({ offset, count: results.length, results })
})
