// Verifies Google-signed ID tokens:
//   * Sign in with Google on Android (Credential Manager), audience = our OAuth web client ID(s)
//   * Pub/Sub authenticated push (Real-time developer notifications), audience = the push endpoint
// Google docs: https://developers.google.com/identity/gsi/web/guides/verify-google-id-token

import { createRemoteJWKSet, jwtVerify } from 'https://esm.sh/jose@5.6.3'

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com']

// Wallet subjects for Google accounts are stored next to Apple subjects (device_credits.apple_user_id,
// credit_wallet_sessions.apple_sub). The prefix keeps the two namespaces apart: Apple subjects never
// contain ':' and the database rejects 'google:' outside V2 wallets (migration 20261114100000).
export const GOOGLE_SUBJECT_PREFIX = 'google:'

const jwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL))

export interface GoogleIdentity {
  /** Wallet subject: 'google:' + Google's stable account ID. */
  subject: string
  googleSub: string
  email?: string
  emailVerified?: boolean
}

export function googleAudiences(raw = Deno.env.get('GOOGLE_OAUTH_CLIENT_IDS') ?? ''): string[] {
  return raw.split(',').map((id) => id.trim()).filter(Boolean)
}

export function isGoogleSubject(subject: unknown): boolean {
  return typeof subject === 'string' && subject.startsWith(GOOGLE_SUBJECT_PREFIX)
}

export async function verifyGoogleIdentityToken(
  token: string,
  audiences: string[] = googleAudiences(),
): Promise<GoogleIdentity | null> {
  if (audiences.length === 0 || typeof token !== 'string' || token.length === 0 || token.length > 16_384) {
    return null
  }
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: GOOGLE_ISSUERS, audience: audiences })
    const sub = payload.sub
    // Google account IDs are numeric strings of up to 255 characters.
    if (typeof sub !== 'string' || !/^[0-9]{1,255}$/.test(sub)) return null
    return {
      subject: GOOGLE_SUBJECT_PREFIX + sub,
      googleSub: sub,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      emailVerified: payload.email_verified === true || payload.email_verified === 'true',
    }
  } catch (error) {
    console.error('[google_auth] identity token rejected', error instanceof Error ? error.name : 'unknown')
    return null
  }
}

/** Pub/Sub push: the OIDC token must name our audience and the configured push service account. */
export async function verifyGooglePushToken(
  authorization: string | null,
  audience: string,
  serviceAccountEmail: string,
): Promise<boolean> {
  const token = authorization ? /^Bearer (\S{1,16384})$/.exec(authorization)?.[1] : undefined
  if (!token || !audience || !serviceAccountEmail) return false
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: GOOGLE_ISSUERS, audience })
    return payload.email === serviceAccountEmail &&
      (payload.email_verified === true || payload.email_verified === 'true')
  } catch {
    return false
  }
}
