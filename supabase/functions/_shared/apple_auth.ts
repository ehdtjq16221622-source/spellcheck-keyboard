// Verifies Apple's `identityToken` JWT (from Sign in with Apple).
// Apple docs: https://developer.apple.com/documentation/sign_in_with_apple/sign_in_with_apple_rest_api

import { jwtVerify, createRemoteJWKSet } from 'https://esm.sh/jose@5.6.3'

const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys'
const APPLE_ISSUER = 'https://appleid.apple.com'

const jwks = createRemoteJWKSet(new URL(APPLE_JWKS_URL))

export interface AppleIdentity {
  sub: string
  email?: string
  emailVerified?: boolean
}

export async function verifyAppleIdentityToken(
  token: string,
  audience: string
): Promise<AppleIdentity | null> {
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: APPLE_ISSUER,
      audience,
    })
    if (typeof payload.sub !== 'string' || !payload.sub) return null
    return {
      sub: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      emailVerified:
        typeof payload.email_verified === 'boolean'
          ? payload.email_verified
          : payload.email_verified === 'true',
    }
  } catch (e) {
    console.error('[apple_auth] verify failed', e)
    return null
  }
}

