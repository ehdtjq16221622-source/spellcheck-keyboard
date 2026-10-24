import { Environment, SignedDataVerifier } from 'npm:@apple/app-store-server-library@3.1.0'
import { Buffer } from 'node:buffer'
import { importPKCS8, SignJWT } from 'https://esm.sh/jose@5.6.3'
import { verifyAppleSignedTransactionPortable } from './apple_subscription_portable.ts'

const APPLE_APP_ID = 6762074672

function decodeBase64Certificate(value: string): Buffer {
  return Buffer.from(value, 'base64')
}

export const APPLE_ROOT_CERTIFICATES = [
  decodeBase64Certificate(
    'MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwSQXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcNMTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBSb290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtfTjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySrMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gAMGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM6BgD56KyKA==',
  ),
  decodeBase64Certificate(
    'MIIFkjCCA3qgAwIBAgIIAeDltYNno+AwDQYJKoZIhvcNAQEMBQAwZzEbMBkGA1UEAwwSQXBwbGUgUm9vdCBDQSAtIEcyMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcNMTQwNDMwMTgxMDA5WhcNMzkwNDMwMTgxMDA5WjBnMRswGQYDVQQDDBJBcHBsZSBSb290IENBIC0gRzIxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBANgREkhI2imKScUcx+xuM23+TfvgHN6sXuI2pyT5f1BrTM65MFQn5bPW7SXmMLYFN14UIhHF6Kob0vuy0gmVOKTvKkmMXT5xZgM4+xb1hYjkWpIMBDLyyED7Ul+f9sDx47pFoFDVEovy3d6RhiPw9bZyLgHaC/YuOQhfGaFjQQscp5TBhsRTL3b2CtcM0YM/GlMZ81fVJ3/8E7j4ko380yhDPLVoACVdJ2LT3VXdRCCQgzWTxb+4Gftr49wIQuavbfqeQMpOhYV4SbHXw8EwOTKrfl+q04tvny0aIWhwZ7Oj8ZhBbZF8+NfbqOdfIRqMM78xdLe40fTgIvS/cjTf94FNcX1RoeKz8NMoFnNvzcytN31O661A4T+B/fc9Cj6i8b0xlilZ3MIZgIxbdMYs0xBTJh0UT8TUgWY8h2czJxQI6bR3hDRSj4n4aJgXv8O7qhOTH11UL6jHfPsNFL4VPSQ08prcdUFmIrQB1guvkJ4M6mL4m1k8COKWNORj3rw31OsMiANDC1CvoDTdUE0V+1ok2Az6DGOeHwOx4e7hqkP0ZmUoNwIx7wHHHtHMn23KVDpA287PT0aLSmWaasZobNfMmRtHsHLDd4/E92GcdB/O/WuhwpyUgquUoue9G7q5cDmVF8Up8zlYNPXEpMZ7YLlmQ1A/bmH8DvmGqmAMQ0uVAgMBAAGjQjBAMB0GA1UdDgQWBBTEmRNsGAPCe8CjoA1/coB6HHcmjTAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjANBgkqhkiG9w0BAQwFAAOCAgEAUabz4vS4PZO/Lc4Pu1vhVRROTtHlznldgX/+tvCHM/jvlOV+3Gp5pxy+8JS3ptEwnMgNCnWefZKVfhidfsJxaXwU6s+DDuQUQp50DhDNqxq6EWGBeNjxtUVAeKuowM77fWM3aPbn+6/Gw0vsHzYmE1SGlHKy6gLti23kDKaQwFd1z4xCfVzmMX3zybKSaUYOiPjjLUKyOKimGY3xn83uamW8GrAlvacp/fQ+onVJv57byfenHmOZ4VxG/5IFjPoeIPmGlFYl5bRXOJ3riGQUIUkhOb9iZqmxospvPyFgxYnURTbImHy99v6ZSYA7LNKmp4gDBDEZt7Y6YUX6yfIjyGNzv1aJMbDZfGKnexWoiIqrOEDCzBL/FePwN983csvMmOa/orz6JopxVtfnJBtIRD6e/J/JzBrsQzwBvDR4yGn1xuZW7AYJNpDrFEobXsmII9oDMJELuDY++ee1KG++P+w8j2Ud5cAeh6Squpj9kuNsJnfdBrRkBof0Tta6SqoWqPQFZ2aWuuJVecMsXUmPgEkrihLHdoBR37q9ZV0+N0djMenl9MU/S60EinpxLK8JQzcPqOMyT/RFtm2XNuyE9QoB6he7hY1Ck3DDUOUUi78/w0EP3SIEIwiKum1xRKtzCTrJ+VKACd+66eYWyi4uTLLT3OUEVLLUNIAytbwPF+E=',
  ),
]

type AppleStatusResponse = {
  bundleId?: string
  data?: Array<{ lastTransactions?: Array<{
    originalTransactionId?: string
    status?: number
    signedTransactionInfo?: string
  }> }>
}

function appleVerificationFailureCode(error: unknown): string {
  const status = error && typeof error === 'object' && 'status' in error
    ? (error as { status?: unknown }).status
    : undefined
  if (status === 1) {
    const cause = error && typeof error === 'object' && 'cause' in error
      ? (error as { cause?: unknown }).cause
      : undefined
    if (cause instanceof Error &&
        (cause instanceof ReferenceError || cause instanceof TypeError ||
         cause.message.startsWith('Not implemented: crypto.X509Certificate.'))) {
      return 'signed_transaction_runtime_verification_failure'
    }
    if (cause instanceof Error) return 'signed_transaction_signature_verification_failure'
    return 'signed_transaction_certificate_chain_verification_failure'
  }
  const knownStatuses: Record<number, string> = {
    2: 'retryable_verification_failure',
    3: 'invalid_app_identifier',
    4: 'invalid_environment',
    5: 'invalid_chain_length',
    6: 'invalid_certificate',
    7: 'failure',
  }
  return typeof status === 'number'
    ? `signed_transaction_${knownStatuses[status] ?? 'verification_error'}`
    : 'signed_transaction_invalid'
}

export async function verifyAppleTransactionJws(
  signedTransaction: string,
  expectedBundleId: string,
  expectedProductId?: string,
): Promise<{
  bundleId: string
  productId: string
  transactionId: string
  originalTransactionId: string
  expiresDate?: number
  environment: string
}> {
  if (!signedTransaction || signedTransaction.length > 64_000) {
    throw new Error('Apple transaction JWS is missing or too large.')
  }

  for (const environment of [Environment.PRODUCTION, Environment.SANDBOX]) {
    const verifier = new SignedDataVerifier(
      APPLE_ROOT_CERTIFICATES,
      true,
      environment,
      expectedBundleId,
      environment === Environment.PRODUCTION ? APPLE_APP_ID : undefined,
    )
    try {
      const transaction = await verifier.verifyAndDecodeTransaction(signedTransaction)
      if (transaction.bundleId !== expectedBundleId ||
          (expectedProductId && transaction.productId !== expectedProductId) ||
          !transaction.transactionId || !transaction.originalTransactionId ||
          transaction.environment !== environment) {
        throw new Error('Apple transaction identifiers or environment do not match.')
      }
      return transaction as {
        bundleId: string
        productId: string
        transactionId: string
        originalTransactionId: string
        expiresDate?: number
        environment: string
      }
    } catch (error) {
      if (environment === Environment.SANDBOX) throw error
    }
  }

  throw new Error('Apple transaction JWS could not be verified.')
}

export async function verifyAppleNotificationJws(
  signedPayload: string,
  expectedBundleId: string,
): Promise<{ notification: Record<string, unknown>; environment: Environment }> {
  if (!signedPayload || signedPayload.length > 256_000) {
    throw new Error('Apple notification JWS is missing or too large.')
  }

  for (const environment of [Environment.PRODUCTION, Environment.SANDBOX]) {
    const verifier = new SignedDataVerifier(
      APPLE_ROOT_CERTIFICATES,
      true,
      environment,
      expectedBundleId,
      environment === Environment.PRODUCTION ? APPLE_APP_ID : undefined,
    )
    try {
      const notification = await verifier.verifyAndDecodeNotification(signedPayload)
      const data = notification.data
      if (!data || data.bundleId !== expectedBundleId || data.environment !== environment) {
        throw new Error('Apple notification app or environment does not match.')
      }
      return { notification: notification as Record<string, unknown>, environment }
    } catch (error) {
      if (environment === Environment.SANDBOX) throw error
    }
  }

  throw new Error('Apple notification JWS could not be verified.')
}

export async function verifyAppleRenewalInfoJws(
  signedRenewalInfo: string,
  environment: Environment,
  expectedBundleId: string,
): Promise<Record<string, unknown>> {
  if (!signedRenewalInfo || signedRenewalInfo.length > 64_000) {
    throw new Error('Apple renewal JWS is missing or too large.')
  }
  const verifier = new SignedDataVerifier(
    APPLE_ROOT_CERTIFICATES,
    true,
    environment,
    expectedBundleId,
    environment === Environment.PRODUCTION ? APPLE_APP_ID : undefined,
  )
  return await verifier.verifyAndDecodeRenewalInfo(signedRenewalInfo) as Record<string, unknown>
}

export async function verifyActiveApplePurchase(
  originalTransactionId: string,
  productId: string,
  expectedBundleId: string,
): Promise<boolean> {
  return verifyAppleSubscriptionRecord(originalTransactionId, productId, expectedBundleId, true)
}

export async function verifyAppleSubscriptionRecord(
  originalTransactionId: string,
  productId: string,
  expectedBundleId: string,
  requireActive = false,
): Promise<boolean> {
  const result = await verifyAppleSubscriptionRecordDetailed(
    originalTransactionId,
    productId,
    expectedBundleId,
    requireActive,
  )
  return result.verified
}

export async function verifyAppleSubscriptionRecordDetailed(
  originalTransactionId: string,
  productId: string,
  expectedBundleId: string,
  requireActive = false,
  tryBothEnvironments = false,
  allowHistoricalSignedDateVerification = false,
  reportVerificationError?: (phase: 'strict' | 'signed_date', error: unknown) => void,
  inspectSignedTransaction?: (jws: string, environment: Environment) => Promise<void>,
): Promise<{
  verified: boolean
  reason?: string
  environment?: 'Production' | 'Sandbox'
  verificationMode?: 'portable_signed_date'
}> {
  if (!/^[0-9]+$/.test(originalTransactionId)) {
    return { verified: false, reason: 'invalid_transaction_id' }
  }
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

  const bases = [
    'https://api.storekit.apple.com',
    'https://api.storekit-sandbox.apple.com',
  ]
  for (const [index, base] of bases.entries()) {
    const response = await fetch(`${base}/inApps/v1/subscriptions/${originalTransactionId}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    })
    if (response.status === 404 && base.includes('api.storekit.apple.com')) {
      const error = await response.json().catch(() => null) as { errorCode?: number } | null
      if (error?.errorCode === 4040010) continue
    }
    if (!response.ok) throw new Error(`Apple subscription status request failed: ${response.status}`)
    const body = await response.json() as AppleStatusResponse
    if (body.bundleId !== expectedBundleId) {
      return { verified: false, reason: 'bundle_id_mismatch' }
    }
    if (!Array.isArray(body.data)) {
      if (tryBothEnvironments && index === 0) continue
      return { verified: false, reason: 'subscription_data_missing' }
    }
    const environment = base.includes('sandbox') ? Environment.SANDBOX : Environment.PRODUCTION
    let failureReason = 'subscription_not_found'
    const verifier = new SignedDataVerifier(
      APPLE_ROOT_CERTIFICATES,
      true,
      environment,
      expectedBundleId,
      environment === Environment.PRODUCTION ? APPLE_APP_ID : undefined,
    )
    let foundTransaction = false
    for (const group of body.data) {
      for (const item of group.lastTransactions ?? []) {
        if (item.originalTransactionId !== originalTransactionId) continue
        foundTransaction = true
        if (requireActive ? item.status !== 1 : ![1, 2, 3, 4].includes(item.status ?? 0)) {
          failureReason = 'subscription_status_not_eligible'
          continue
        }
        if (!item.signedTransactionInfo) {
          failureReason = 'signed_transaction_missing'
          continue
        }
        await inspectSignedTransaction?.(item.signedTransactionInfo, environment)
        let transaction
        let verificationMode: 'portable_signed_date' | undefined
        try {
          transaction = await verifier.verifyAndDecodeTransaction(item.signedTransactionInfo)
        } catch (error) {
          reportVerificationError?.('strict', error)
          failureReason = appleVerificationFailureCode(error)
          if (!allowHistoricalSignedDateVerification || requireActive ||
              !(error && typeof error === 'object' && 'status' in error &&
                (error as { status?: unknown }).status === 1)) continue
          try {
            transaction = await verifyAppleSignedTransactionPortable(
              item.signedTransactionInfo,
              expectedBundleId,
              environment,
              APPLE_ROOT_CERTIFICATES,
            )
            verificationMode = 'portable_signed_date'
          } catch (portableError) {
            reportVerificationError?.('signed_date', portableError)
            const code = portableError instanceof Error && /^[a-z_]+$/.test(portableError.message)
              ? portableError.message : 'verification_failed'
            failureReason = `portable_${code}`
            continue
          }
        }
        const expiry = transaction.expiresDate
        if (transaction.bundleId !== expectedBundleId ||
            transaction.originalTransactionId !== originalTransactionId ||
            transaction.productId !== productId) {
          failureReason = 'signed_transaction_mismatch'
          continue
        }
        if (typeof expiry !== 'number' || expiry <= 0 ||
            (requireActive && expiry <= Date.now())) {
          failureReason = 'subscription_expired'
          continue
        }
        if (transaction.revocationDate != null) {
          failureReason = 'subscription_revoked'
          continue
        }
        return {
          verified: true,
          environment: base.includes('sandbox') ? 'Sandbox' : 'Production',
          ...(verificationMode ? { verificationMode } : {}),
        }
      }
    }
    if (tryBothEnvironments && index === 0 && !foundTransaction) continue
    return { verified: false, reason: failureReason,
      environment: base.includes('sandbox') ? 'Sandbox' : 'Production' }
  }
  return { verified: false, reason: 'subscription_not_found' }
}
