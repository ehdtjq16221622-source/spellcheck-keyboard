// Feature-flagged guest registration and canary-only Apple linking.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { verifyAppleIdentityToken } from '../_shared/apple_auth.ts'
import { walletTokenHash } from '../_shared/wallet_auth.ts'
import { enrollBonusCanaryDevice, isBonusCanaryDevice } from '../_shared/devicecheck.ts'

const BUNDLE_ID = 'com.kingboard.app'

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

function isHexSecret(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return respond({ error: 'Not found.' }, 404)
  const canaryEnabled = Deno.env.get('WALLET_BONUS_CANARY_ENABLED') === 'true'
  if (!canaryEnabled && (Deno.env.get('WALLET_SESSIONS_ENABLED') !== 'true' ||
      (Deno.env.get('WALLET_LINK_V2_ENABLED') !== 'true' &&
       Deno.env.get('WALLET_GUEST_V2_ENABLED') !== 'true'))) {
    return respond({ error: 'Not found.' }, 404)
  }

  const allowlist = new Set(
    (Deno.env.get('WALLET_LINK_V2_CANARY_APPLE_IDS') ?? '')
      .split(',').map((id) => id.trim()).filter(Boolean),
  )
  try {
    const body = await req.json()
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    if (body.action === 'enroll_bonus_canary') {
      if (!canaryEnabled || typeof body.identityToken !== 'string' ||
          body.identityToken.length > 16_384 || typeof body.deviceToken !== 'string') {
        return respond({ error: 'Not found.' }, 404)
      }
      const identity = await verifyAppleIdentityToken(body.identityToken, BUNDLE_ID)
      if (!identity || !allowlist.has(identity.sub)) return respond({ error: 'Not found.' }, 404)
      const { data: freeUse, error } = await supabase.from('credit_transactions')
        .select('id').eq('device_id', identity.sub).lt('free_delta', 0).limit(1)
      if (error) throw error
      if (!freeUse?.length) return respond({ error: 'Free-credit use needs review.' }, 409)
      await enrollBonusCanaryDevice(body.deviceToken)
      return respond({ enrolled: true })
    }

    if (body.action === 'register_canary') {
      if (!canaryEnabled || !isHexSecret(body.walletSecret) ||
          typeof body.deviceToken !== 'string' ||
          typeof body.identityToken !== 'string' || body.identityToken.length > 16_384) {
        return respond({ error: 'Not found.' }, 404)
      }
      const identity = await verifyAppleIdentityToken(body.identityToken, BUNDLE_ID)
      if (!identity || !allowlist.has(identity.sub) ||
          !(await isBonusCanaryDevice(body.deviceToken))) {
        return respond({ error: 'Not found.' }, 404)
      }
      const { data: walletId, error } = await supabase.rpc('register_guest_wallet_v2', {
        p_secret_hash: await sha256(body.walletSecret), p_initial_bonus: 0,
      })
      if (error) throw error
      const { data: wallet, error: walletError } = await supabase.from('device_credits')
        .select('free_credits, paid_credits, apple_user_id').eq('device_id', walletId).single()
      if (walletError) throw walletError
      if (wallet.apple_user_id !== null) return respond({ error: 'Wallet requires review.' }, 409)
      return respond({ walletId, freeCredits: wallet.free_credits,
        paidCredits: wallet.paid_credits, state: 'pending' }, 201)
    }

    if (body.action === 'register' || body.action === 'register_after_logout') {
      if (!isHexSecret(body.walletSecret)) return respond({ error: 'Invalid wallet proof.' }, 400)
      const guestEnabled = Deno.env.get('WALLET_SESSIONS_ENABLED') === 'true' &&
        Deno.env.get('WALLET_GUEST_V2_ENABLED') === 'true'
      const markedCanary = !guestEnabled && canaryEnabled && body.action === 'register' &&
        typeof body.deviceToken === 'string' &&
        await isBonusCanaryDevice(body.deviceToken)
      if (!guestEnabled && !markedCanary) return respond({ error: 'Not found.' }, 404)
      if (guestEnabled && body.action === 'register' &&
          Deno.env.get('WALLET_DEVICECHECK_BONUS_ENABLED') !== 'true') {
        return respond({ error: 'Device verification is not ready.' }, 503)
      }
      if (body.action === 'register_after_logout') {
        if (!isHexSecret(body.sessionToken)) return respond({ error: 'Invalid wallet session.' }, 400)
        const { data: session, error } = await supabase.from('credit_wallet_sessions')
          .select('apple_sub, expires_at, revoked_at')
          .eq('token_hash', await walletTokenHash(body.sessionToken)).maybeSingle()
        if (error) throw error
        if (!session || session.revoked_at ||
            Date.parse(session.expires_at) <= Date.now()) {
          return respond({ error: 'Active Apple wallet session required.' }, 401)
        }
      }
      const secretHash = await sha256(body.walletSecret)
      let initialBonus = 0
      let deviceAlreadyMarked = false
      const deviceCheckBonus = body.action === 'register' && !markedCanary &&
        Deno.env.get('WALLET_DEVICECHECK_BONUS_ENABLED') === 'true'
      if (body.action === 'register' && !markedCanary) {
        if (deviceCheckBonus) {
          if (typeof body.deviceToken !== 'string') {
            return respond({ error: 'Device verification required.' }, 409)
          }
          deviceAlreadyMarked = await isBonusCanaryDevice(body.deviceToken)
        } else {
          initialBonus = 500
        }
      }
      const { data: walletId, error } = await supabase.rpc('register_guest_wallet_v2', {
        p_secret_hash: secretHash,
        p_initial_bonus: initialBonus,
      })
      if (error) throw error
      if (typeof walletId !== 'string' || !walletId.startsWith('v2:')) {
        throw new Error('Missing registered wallet ID')
      }
      if (deviceCheckBonus) {
        if (!deviceAlreadyMarked) {
          const { data: reservation, error: reserveError } = await supabase
            .rpc('reserve_guest_install_bonus', {
              p_wallet_id: walletId, p_secret_hash: secretHash,
            })
          if (reserveError) throw reserveError
          if (reservation !== 'pending' && reservation !== 'granted') {
            throw new Error('Missing install bonus reservation')
          }
          await enrollBonusCanaryDevice(body.deviceToken)
        }
        // A retry after DeviceCheck succeeded but the final DB write failed
        // completes the pending claim for this same wallet secret only.
        const { error: completeError } = await supabase
          .rpc('complete_guest_install_bonus', {
            p_wallet_id: walletId, p_secret_hash: secretHash,
          })
        if (completeError) throw completeError
      }
      const { data: wallet, error: walletError } = await supabase.from('device_credits')
        .select('free_credits, paid_credits, apple_user_id')
        .eq('device_id', walletId).single()
      if (walletError) throw walletError
      if (wallet.apple_user_id !== null) return respond({ error: 'Wallet already linked.' }, 409)
      const { data: credential, error: credentialError } = await supabase
        .from('wallet_v2_credentials').select('state')
        .eq('wallet_id', walletId).single()
      if (credentialError) throw credentialError
      return respond({ walletId, freeCredits: wallet.free_credits,
        paidCredits: wallet.paid_credits, state: credential.state }, 201)
    }

    if (body.action === 'activate') {
      if (!canaryEnabled && (Deno.env.get('WALLET_SESSIONS_ENABLED') !== 'true' ||
          Deno.env.get('WALLET_GUEST_V2_ENABLED') !== 'true')) {
        return respond({ error: 'Not found.' }, 404)
      }
      if (!isHexSecret(body.walletSecret) || typeof body.walletId !== 'string' ||
          !/^v2:[0-9a-f-]{36}$/.test(body.walletId)) {
        return respond({ error: 'Invalid wallet proof.' }, 400)
      }
      const { data: activated, error } = await supabase.rpc('activate_guest_wallet_v2', {
        p_wallet_id: body.walletId,
        p_secret_hash: await sha256(body.walletSecret),
      })
      if (error?.code === 'P0001') return respond({ error: 'Wallet possession proof failed.' }, 403)
      if (error) throw error
      return respond({ walletId: body.walletId, activated: Boolean(activated) })
    }

    if (Deno.env.get('WALLET_SESSIONS_ENABLED') !== 'true' ||
        Deno.env.get('WALLET_LINK_V2_ENABLED') !== 'true' || allowlist.size === 0) {
      return respond({ error: 'Not found.' }, 404)
    }

    if (body.action === 'rotate_session' || body.action === 'revoke_session') {
      if (!isHexSecret(body.sessionToken)) return respond({ error: 'Invalid wallet session.' }, 400)
      const oldHash = await walletTokenHash(body.sessionToken)
      const { data: session, error: readError } = await supabase
        .from('credit_wallet_sessions')
        .select('apple_sub')
        .eq('token_hash', oldHash)
        .maybeSingle()
      if (readError) throw readError
      if (!session) return respond({ error: 'Not found.' }, 404)
      if (body.action === 'revoke_session') {
        const { error } = await supabase.rpc('revoke_apple_wallet_session', { p_token_hash: oldHash })
        if (error) throw error
        return respond({ state: 'revoked' })
      }
      if (!isHexSecret(body.nextSessionToken)) return respond({ error: 'Invalid next session.' }, 400)
      const { data: walletId, error } = await supabase.rpc('rotate_apple_wallet_session', {
        p_old_hash: oldHash,
        p_new_hash: await walletTokenHash(body.nextSessionToken),
        p_expires_at: new Date(Date.now() + 29 * 24 * 60 * 60 * 1000).toISOString(),
      })
      if (error?.code === 'P0001') return respond({ error: 'Wallet session must be renewed by Apple sign-in.' }, 401)
      if (error) throw error
      return respond({ walletId, expiresInSeconds: 29 * 86400, state: 'active' })
    }

    if (typeof body?.identityToken !== 'string' || body.identityToken.length > 16_384) {
      return respond({ error: 'Invalid Apple identity.' }, 401)
    }
    const identity = await verifyAppleIdentityToken(body.identityToken, BUNDLE_ID)
    if (!identity || !allowlist.has(identity.sub)) {
      return respond({ error: 'Not found.' }, 404)
    }

    if (body.action === 'sign_in') {
      const bytes = crypto.getRandomValues(new Uint8Array(32))
      const sessionToken = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
      const { data: walletId, error } = await supabase.rpc('issue_apple_wallet_session', {
        p_apple_sub: identity.sub,
        p_token_hash: await walletTokenHash(sessionToken),
        p_expires_at: new Date(Date.now() + 29 * 24 * 60 * 60 * 1000).toISOString(),
      })
      if (error?.code === 'P0001' && error.message?.includes('Apple wallet does not exist')) {
        return respond({ error: 'Apple wallet not found.', code: 'APPLE_WALLET_NOT_FOUND' }, 409)
      }
      if (error) throw error
      return respond({ walletId, sessionToken, expiresInSeconds: 29 * 86400, state: 'pending' })
    }

    if (body.action === 'activate_session') {
      if (!isHexSecret(body.sessionToken)) return respond({ error: 'Invalid wallet session.' }, 400)
      const tokenHash = await walletTokenHash(body.sessionToken)
      const { data: session, error: readError } = await supabase
        .from('credit_wallet_sessions')
        .select('apple_sub')
        .eq('token_hash', tokenHash)
        .maybeSingle()
      if (readError) throw readError
      if (!session || session.apple_sub !== identity.sub) {
        return respond({ error: 'Wallet session does not match Apple account.' }, 403)
      }
      const { data: walletId, error } = await supabase.rpc('activate_apple_wallet_session', {
        p_token_hash: tokenHash,
      })
      if (error) throw error
      return respond({ walletId, state: 'active' })
    }

    if (body.action === 'merge_linked') {
      if (!isHexSecret(body.sessionToken) ||
          typeof body.idempotencyKey !== 'string' ||
          body.idempotencyKey.length < 1 || body.idempotencyKey.length > 128) {
        return respond({ error: 'Invalid merge proof.' }, 400)
      }
      const { data, error } = await supabase.rpc('merge_linked_apple_subject_wallets_once', {
        p_apple_sub: identity.sub,
        p_request_id: body.idempotencyKey,
        p_token_hash: await walletTokenHash(body.sessionToken),
      })
      if (error?.code === 'P0001') return respond({ error: 'Wallet transfer requires review.' }, 409)
      if (error) throw error
      const result = data?.[0]
      if (!result) throw new Error('Missing merge result')
      return respond({
        decision: result.decision,
        canonicalWalletId: result.canonical_wallet_id,
        freeCredits: result.free_credits_remaining,
        paidCredits: result.paid_credits_remaining,
      })
    }

    if (body.action === 'merge_legacy') {
      if (typeof body.sourceWalletId !== 'string' ||
          body.sourceWalletId.length < 1 || body.sourceWalletId.length > 512 ||
          body.sourceWalletId.startsWith('v2:') ||
          !isHexSecret(body.sessionToken) ||
          typeof body.idempotencyKey !== 'string' ||
          body.idempotencyKey.length < 1 || body.idempotencyKey.length > 128) {
        return respond({ error: 'Invalid legacy merge proof.' }, 400)
      }
      // Legacy IDs are public identifiers, not possession proofs. Keep this
      // route closed except for a separately reviewed subject/source pair.
      if (Deno.env.get('WALLET_LEGACY_MERGE_ENABLED') !== 'true') {
        return respond({ error: 'Wallet transfer requires review.' }, 409)
      }
      const approvedPairs = JSON.parse(
        Deno.env.get('WALLET_LEGACY_MERGE_CANARY_PAIRS') ?? '{}',
      ) as Record<string, string[]>
      if (!Array.isArray(approvedPairs[identity.sub]) ||
          !approvedPairs[identity.sub].includes(body.sourceWalletId)) {
        return respond({ error: 'Wallet transfer requires review.' }, 409)
      }
      const { data, error } = await supabase.rpc('merge_verified_legacy_wallet_once', {
        p_source_wallet_id: body.sourceWalletId,
        p_apple_sub: identity.sub,
        p_session_token_hash: await walletTokenHash(body.sessionToken),
        p_request_id: body.idempotencyKey,
      })
      if (error?.code === 'P0001') return respond({ error: 'Wallet transfer requires review.' }, 409)
      if (error) throw error
      const result = data?.[0]
      if (!result) throw new Error('Missing legacy merge result')
      return respond({
        decision: result.decision,
        canonicalWalletId: result.canonical_wallet_id,
        freeCredits: result.free_credits_remaining,
        paidCredits: result.paid_credits_remaining,
      })
    }

    if (!isHexSecret(body.walletSecret) || typeof body.walletId !== 'string' ||
        !/^v2:[0-9a-f-]{36}$/.test(body.walletId)) {
      return respond({ error: 'Invalid wallet proof.' }, 400)
    }
    const secretHash = await sha256(body.walletSecret)

    if (body.action === 'merge_guest') {
      if (!isHexSecret(body.sessionToken) ||
          typeof body.idempotencyKey !== 'string' ||
          body.idempotencyKey.length < 1 || body.idempotencyKey.length > 128) {
        return respond({ error: 'Invalid merge proof.' }, 400)
      }
      const { data, error } = await supabase.rpc('merge_verified_v2_guest_wallet_once', {
        p_guest_wallet_id: body.walletId,
        p_guest_secret_hash: secretHash,
        p_apple_sub: identity.sub,
        p_session_token_hash: await walletTokenHash(body.sessionToken),
        p_request_id: body.idempotencyKey,
      })
      if (error?.code === 'P0001') return respond({ error: 'Wallet transfer requires review.' }, 409)
      if (error) throw error
      const result = data?.[0]
      if (!result) throw new Error('Missing guest merge result')
      return respond({
        decision: result.decision,
        canonicalWalletId: result.canonical_wallet_id,
        freeCredits: result.free_credits_remaining,
        paidCredits: result.paid_credits_remaining,
      })
    }

    if (body.action === 'link') {
      if (typeof body.idempotencyKey !== 'string' ||
          body.idempotencyKey.length < 1 || body.idempotencyKey.length > 128) {
        return respond({ error: 'Invalid idempotency key.' }, 400)
      }
      const { data, error } = await supabase.rpc('link_apple_wallet_v2', {
        p_wallet_id: body.walletId,
        p_secret_hash: secretHash,
        p_apple_sub: identity.sub,
        p_idempotency_key: body.idempotencyKey,
      })
      if (error?.code === 'P0001') return respond({ error: 'Wallet link requires review.' }, 409)
      if (error) throw error
      const result = data?.[0]
      if (!result) throw new Error('Missing wallet link result')
      return respond({
        decision: result.decision,
        canonicalWalletId: result.canonical_wallet_id,
        guestTransferred: false,
      })
    }

    return respond({ error: 'Unknown action.' }, 400)
  } catch (error) {
    console.error('[wallet_link_v2]', error)
    return respond({ error: 'Wallet linking unavailable.' }, 500)
  }
})
