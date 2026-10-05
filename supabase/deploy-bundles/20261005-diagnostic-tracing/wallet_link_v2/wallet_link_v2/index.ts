// Feature-flagged guest registration and canary-only Apple linking.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { verifyAppleIdentityToken } from '../_shared/apple_auth.ts'
import {
  verifyAppleSubscriptionRecord,
  verifyAppleSubscriptionRecordDetailed,
} from '../_shared/apple_subscription_status.ts'
import { walletTokenHash } from '../_shared/wallet_auth.ts'
import { enrollBonusCanaryDevice, isBonusCanaryDevice } from '../_shared/devicecheck.ts'
import {
  logSubscriptionAudit,
  subscriptionTransactionFingerprint,
  subscriptionWalletFingerprint,
} from '../_shared/subscription_audit.ts'

const BUNDLE_ID = 'com.kingboard.app'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

function isHexSecret(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function serviceRoleKeyKind(value: string | undefined): string {
  if (!value) return 'missing'
  if (value.startsWith('sb_secret_')) return 'modern_secret_key'
  const payload = value.split('.')[1]
  if (!payload) return 'not_jwt'
  try {
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
    return claims.role === 'service_role' ? 'service_role' : 'not_service_role'
  } catch {
    return 'unreadable_jwt'
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function auditProduct(productId: string): 'basic' | 'premium' | 'pro' | 'other' {
  if (productId.endsWith('.monthly_basic')) return 'basic'
  if (productId.endsWith('.monthly_premium')) return 'premium'
  if (productId.endsWith('.monthly_pro')) return 'pro'
  return 'other'
}

async function verifySubscribedGuestPurchase(
  purchaseToken: string,
  productId: string,
  appleSub: string,
  walletId: string,
  canary: boolean,
  rolloutEnabled = false,
): Promise<boolean> {
  if (!canary && !rolloutEnabled) {
    return await verifyAppleSubscriptionRecord(purchaseToken, productId, BUNDLE_ID, false)
  }

  const result = await verifyAppleSubscriptionRecordDetailed(
    purchaseToken, productId, BUNDLE_ID, false, true, true,
  )
  if (result.verified && result.verificationMode === 'portable_signed_date') {
    logSubscriptionAudit('info', crypto.randomUUID(), 'wallet_transfer_purchase_verified_portably', {
      stage: 'wallet_transfer_apple_status',
      product: auditProduct(productId),
      environment: result.environment,
      canary,
      walletFingerprint: await subscriptionWalletFingerprint(walletId),
      transactionFingerprint: await subscriptionTransactionFingerprint(purchaseToken),
    })
  }
  if (!result.verified) {
    logSubscriptionAudit('warn', crypto.randomUUID(), 'wallet_transfer_purchase_unconfirmed', {
      stage: 'wallet_transfer_apple_status',
      product: auditProduct(productId),
      environment: result.environment,
      canary,
      failureCode: `apple_status_${result.reason ?? 'unconfirmed'}`,
      walletFingerprint: await subscriptionWalletFingerprint(walletId),
      transactionFingerprint: await subscriptionTransactionFingerprint(purchaseToken),
    })
  }
  return result.verified
}

Deno.serve(async (req: Request) => {
  const auditId = crypto.randomUUID()
  let requestAction = 'unknown'
  let stage = 'parse_request'
  const walletFingerprints = new Set<string>()
  let operationFingerprint: string | undefined
  function audit(event: string, extra: Record<string, unknown> = {}) {
    console.info(JSON.stringify({ category: 'wallet_link_audit', event, auditId,
      action: requestAction, stage, walletFingerprints: [...walletFingerprints],
      operationFingerprint, ...extra }))
  }
  function respond(body: unknown, status = 200): Response {
    audit('response', { status })
    const isFailure = status >= 400 && body !== null && typeof body === 'object' && !Array.isArray(body)
    const responseBody = isFailure
      ? { ...(body as Record<string, unknown>), diagnostic_id: auditId, failure_stage: stage }
      : body
    const response = jsonResponse(responseBody, status)
    response.headers.set('X-Wallet-Audit-ID', auditId)
    response.headers.set('X-Kingboard-Diagnostic-ID', auditId)
    response.headers.set('Access-Control-Expose-Headers', 'X-Wallet-Audit-ID, X-Kingboard-Diagnostic-ID')
    return response
  }
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
    requestAction = typeof body.action === 'string' && /^[a-z_]{1,40}$/.test(body.action)
      ? body.action : 'other'
    // Claimed IDs aid correlation only; they never authorize wallet access.
    const claimedWalletFingerprints: Record<string, string> = {}
    for (const key of ['walletId', 'sourceWalletId', 'canonicalWalletId']) {
      if (typeof body[key] === 'string' && body[key].length <= 256) {
        claimedWalletFingerprints[key] = await sha256(body[key])
      }
    }
    if (typeof body.idempotencyKey === 'string' && body.idempotencyKey.length <= 128) {
      operationFingerprint = await sha256(body.idempotencyKey)
    }
    audit('request_received', { claimedWalletFingerprints })
    if (body.action === 'availability') {
      return respond({ enabled:
        Deno.env.get('WALLET_SESSIONS_ENABLED') === 'true' &&
        Deno.env.get('WALLET_GUEST_V2_ENABLED') === 'true' &&
        Deno.env.get('WALLET_LINK_V2_ENABLED') === 'true' &&
        Deno.env.get('WALLET_LINK_V2_ALL_USERS_ENABLED') === 'true' &&
        Deno.env.get('WALLET_AUTO_MERGE_ALL_USERS_ENABLED') === 'true' &&
        Deno.env.get('WALLET_LEGACY_MERGE_ENABLED') === 'true',
      })
    }
    stage = 'create_service_client'
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      serviceRoleKey!,
    )
    async function auditedRpc(name: string, args: Record<string, unknown>) {
      stage = `rpc_${name}`
      const rpcStage = stage
      const inputWalletFingerprints: Record<string, string> = {}
      for (const key of ['p_wallet_id', 'p_guest_wallet_id', 'p_source_wallet_id',
        'p_canonical_wallet_id', 'p_apple_sub']) {
        if (typeof args[key] === 'string') inputWalletFingerprints[key] = await sha256(args[key] as string)
      }
      const operationKey = args.p_request_id ?? args.p_idempotency_key
      if (typeof operationKey === 'string') operationFingerprint = await sha256(operationKey)
      audit('rpc_started', { inputWalletFingerprints })
      const result = await supabase.rpc(name, args)
      const row = Array.isArray(result.data) ? result.data[0] : result.data
      if (!result.error) {
        for (const fingerprint of Object.values(inputWalletFingerprints)) walletFingerprints.add(fingerprint)
        if (typeof row === 'string' && /^(register_guest_wallet_v2|issue_apple_wallet_session|activate_apple_wallet_session|rotate_apple_wallet_session)$/.test(name)) {
          walletFingerprints.add(await sha256(row))
        }
        if (row && typeof row === 'object' && typeof row.canonical_wallet_id === 'string') {
          walletFingerprints.add(await sha256(row.canonical_wallet_id))
        }
      }
      audit('rpc_completed', { stage: rpcStage, inputWalletFingerprints,
        outcome: result.error ? 'rejected' : 'completed',
        sqlstate: /^[A-Z0-9]{5}$/.test(result.error?.code ?? '') ? result.error.code : undefined,
        applied: typeof result.data === 'boolean' ? result.data : undefined })
      return result
    }

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
      stage = 'rpc_register_guest_wallet_v2_canary'
      const { data: walletId, error } = await auditedRpc('register_guest_wallet_v2', {
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
      let markedCanary = false
      let deviceCheckUnavailable = false
      if (!guestEnabled && canaryEnabled && body.action === 'register' &&
          typeof body.deviceToken === 'string') {
        try {
          markedCanary = await isBonusCanaryDevice(body.deviceToken)
        } catch (error) {
          // DeviceCheck outages must not block a zero-credit wallet. The
          // bonus remains withheld until the same wallet can be verified.
          deviceCheckUnavailable = true
          audit('devicecheck_unavailable', { outcome: 'verification_pending' })
        }
      }
      let testAccountLogout = false
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
        testAccountLogout = canaryEnabled && typeof session.apple_sub === 'string' &&
          (allowlist.has(session.apple_sub) || await sha256(session.apple_sub) ===
           '014252a83ff1048722f43fecfec725a43c4ce151af89bc1aad535f0609de8c45')
      }
      if (!guestEnabled && !markedCanary && !testAccountLogout && !deviceCheckUnavailable) {
        return respond({ error: 'Not found.' }, 404)
      }
      if (guestEnabled && body.action === 'register' &&
          Deno.env.get('WALLET_DEVICECHECK_BONUS_ENABLED') !== 'true') {
        return respond({ error: 'Device verification is not ready.', code: 'GUEST_NOT_READY' }, 503)
      }
      const secretHash = await sha256(body.walletSecret)
      let initialBonus = 0
      let bonusStatus = 'complete'
      const deviceCheckRequired = body.action === 'register' && !markedCanary &&
        Deno.env.get('WALLET_DEVICECHECK_BONUS_ENABLED') === 'true'
      const deviceCheckBonus = deviceCheckRequired && typeof body.deviceToken === 'string'
      if (body.action === 'register' && !markedCanary) {
        if (deviceCheckRequired) {
          if (!deviceCheckBonus) bonusStatus = 'verification_pending'
        } else {
          initialBonus = deviceCheckUnavailable ? 0 : 500
        }
      }
      stage = 'rpc_register_guest_wallet_v2'
      const { data: walletId, error } = await auditedRpc('register_guest_wallet_v2', {
        p_secret_hash: secretHash,
        p_initial_bonus: initialBonus,
      })
      if (error) throw error
      if (typeof walletId !== 'string' || !walletId.startsWith('v2:')) {
        throw new Error('Missing registered wallet ID')
      }
      if (deviceCheckBonus) {
        const lockOwner = crypto.randomUUID()
        stage = 'rpc_acquire_guest_bonus_devicecheck_lock'
        const { data: locked, error: lockError } = await auditedRpc('acquire_guest_bonus_devicecheck_lock', { p_owner: lockOwner })
        if (lockError) throw lockError
        if (!locked) return respond({ error: 'Device verification is busy.' }, 503)
        try {
          let deviceAlreadyMarked = false
          try {
            deviceAlreadyMarked = await isBonusCanaryDevice(body.deviceToken)
          } catch (error) {
            deviceCheckUnavailable = true
            audit('devicecheck_unavailable', { outcome: 'verification_pending' })
          }
          if (!deviceCheckUnavailable) {
            if (!deviceAlreadyMarked) {
              stage = 'rpc_reserve_guest_install_bonus'
              const { data: reservation, error: reserveError } = await auditedRpc('reserve_guest_install_bonus', {
                  p_wallet_id: walletId, p_secret_hash: secretHash,
                })
              if (reserveError) throw reserveError
              if (reservation !== 'pending' && reservation !== 'granted') {
                throw new Error('Missing install bonus reservation')
              }
              if (reservation === 'pending') {
                try {
                  await enrollBonusCanaryDevice(body.deviceToken)
                } catch (error) {
                  deviceCheckUnavailable = true
                  audit('devicecheck_enrollment_unconfirmed', { outcome: 'verification_pending' })
                }
                if (!deviceCheckUnavailable) {
                  stage = 'rpc_confirm_guest_install_bonus_devicecheck'
                  const { data: confirmed, error: confirmError } = await auditedRpc('confirm_guest_install_bonus_devicecheck', {
                      p_wallet_id: walletId, p_secret_hash: secretHash,
                      p_lock_owner: lockOwner,
                    })
                  if (confirmError) throw confirmError
                  if (!confirmed) throw new Error('Missing device verification claim')
                }
              }
            } else {
              const { data: claim, error: claimError } = await supabase
                .from('guest_install_bonus_claims')
                .select('state, verification_confirmed_at')
                .eq('wallet_id', walletId).maybeSingle()
              if (claimError) throw claimError
              if (claim?.state === 'pending' && !claim.verification_confirmed_at) {
                bonusStatus = 'needs_review'
              }
            }
            if (!deviceCheckUnavailable && bonusStatus !== 'needs_review') {
              stage = 'rpc_complete_guest_install_bonus_guarded'
              const { error: completeError } = await auditedRpc('complete_guest_install_bonus_guarded', {
                  p_wallet_id: walletId, p_secret_hash: secretHash,
                  p_lock_owner: lockOwner,
                })
              if (completeError) throw completeError
            }
          }
        } finally {
          const previousStage = stage
          stage = 'rpc_release_guest_bonus_devicecheck_lock'
          const { error: releaseError } = await auditedRpc('release_guest_bonus_devicecheck_lock', { p_owner: lockOwner })
          if (releaseError) {
            console.error(JSON.stringify({
              event: 'wallet_link_v2_failure', action: requestAction, auditId,
              walletFingerprints: [...walletFingerprints], operationFingerprint,
              stage, reason: 'devicecheck_lock_release_failed',
            }))
          }
          stage = previousStage
        }
        if (deviceCheckUnavailable) bonusStatus = 'verification_pending'
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
        paidCredits: wallet.paid_credits, state: credential.state, bonusStatus }, 201)
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
      const { data: activated, error } = await auditedRpc('activate_guest_wallet_v2', {
        p_wallet_id: body.walletId,
        p_secret_hash: await sha256(body.walletSecret),
      })
      if (error?.code === 'P0001') return respond({ error: 'Wallet possession proof failed.' }, 403)
      if (error) throw error
      return respond({ walletId: body.walletId, activated: Boolean(activated) })
    }

    const allUsersEnabled = Deno.env.get('WALLET_SESSIONS_ENABLED') === 'true' &&
      Deno.env.get('WALLET_GUEST_V2_ENABLED') === 'true' &&
      Deno.env.get('WALLET_LINK_V2_ENABLED') === 'true' &&
      Deno.env.get('WALLET_LINK_V2_ALL_USERS_ENABLED') === 'true'
    const walletAutoMergeAllUsersEnabled = allUsersEnabled &&
      Deno.env.get('WALLET_AUTO_MERGE_ALL_USERS_ENABLED') === 'true'
    const appleLinkEnabled = Deno.env.get('WALLET_SESSIONS_ENABLED') === 'true' &&
      Deno.env.get('WALLET_LINK_V2_ENABLED') === 'true' &&
      (allowlist.size > 0 || allUsersEnabled)
    if (!appleLinkEnabled && body.action !== 'resume_guest_merge') {
      let testAccountAllowed = false
      if (typeof body.identityToken === 'string' && body.identityToken.length <= 16_384) {
        const testIdentity = await verifyAppleIdentityToken(body.identityToken, BUNDLE_ID)
        testAccountAllowed = !!testIdentity &&
          (await sha256(testIdentity.sub) ===
           '014252a83ff1048722f43fecfec725a43c4ce151af89bc1aad535f0609de8c45')
      } else if ((body.action === 'rotate_session' || body.action === 'revoke_session') &&
                 isHexSecret(body.sessionToken)) {
        const { data: testSession, error: testSessionError } = await supabase
          .from('credit_wallet_sessions').select('apple_sub')
          .eq('token_hash', await walletTokenHash(body.sessionToken)).maybeSingle()
        if (testSessionError) throw testSessionError
        testAccountAllowed = !!testSession?.apple_sub &&
          (await sha256(testSession.apple_sub) ===
           '014252a83ff1048722f43fecfec725a43c4ce151af89bc1aad535f0609de8c45')
      }
      if (!testAccountAllowed) return respond({ error: 'Not found.' }, 404)
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
        const { error } = await auditedRpc('revoke_apple_wallet_session', { p_token_hash: oldHash })
        if (error) throw error
        return respond({ state: 'revoked' })
      }
      if (!isHexSecret(body.nextSessionToken)) return respond({ error: 'Invalid next session.' }, 400)
      const { data: walletId, error } = await auditedRpc('rotate_apple_wallet_session', {
        p_old_hash: oldHash,
        p_new_hash: await walletTokenHash(body.nextSessionToken),
        p_expires_at: new Date(Date.now() + 29 * 24 * 60 * 60 * 1000).toISOString(),
      })
      if (error?.code === 'P0001') return respond({ error: 'Wallet session must be renewed by Apple sign-in.' }, 401)
      if (error) throw error
      return respond({ walletId, expiresInSeconds: 29 * 86400, state: 'active' })
    }

    if (body.action === 'resume_guest_merge') {
      if (!isHexSecret(body.sessionToken) || !isHexSecret(body.walletSecret) ||
          typeof body.walletId !== 'string' || !body.walletId.startsWith('v2:') ||
          typeof body.idempotencyKey !== 'string' || body.idempotencyKey.length < 1 ||
          body.idempotencyKey.length > 128) {
        return respond({ error: 'Invalid wallet merge proof.' }, 400)
      }
      const sessionHash = await walletTokenHash(body.sessionToken)
      const { data: session, error: sessionError } = await supabase
        .from('credit_wallet_sessions').select('apple_sub, wallet_id, expires_at, revoked_at')
        .eq('token_hash', sessionHash).maybeSingle()
      if (sessionError) throw sessionError
      if (!session || session.revoked_at || Date.parse(session.expires_at) <= Date.now()) {
        return respond({ error: 'Active Apple wallet session required.' }, 401)
      }
      const appleSub = session.apple_sub as string
      const subscriptionCanaries = new Set(
        (Deno.env.get('WALLET_SUBSCRIPTION_MERGE_CANARY_APPLE_IDS') ?? '')
          .split(',').map((id) => id.trim()).filter(Boolean),
      )
      const isSubscriptionCanary = subscriptionCanaries.has(appleSub) ||
        await sha256(appleSub) === '014252a83ff1048722f43fecfec725a43c4ce151af89bc1aad535f0609de8c45'
      if (!walletAutoMergeAllUsersEnabled &&
          !isSubscriptionCanary) {
        return respond({ error: 'Wallet merge unavailable.' }, 404)
      }
      const { data: canonical, error: canonicalError } = await supabase
        .from('device_credits').select('device_id').eq('apple_user_id', appleSub).maybeSingle()
      if (canonicalError) throw canonicalError
      if (!canonical || canonical.device_id !== session.wallet_id) {
        return respond({ error: 'Wallet session does not match canonical wallet.' }, 403)
      }
      const secretHash = await sha256(body.walletSecret)
      const { data: history, error: historyError } = await supabase
        .from('credit_v2_subscription_transfer_grants').select('purchase_token, request_id')
        .eq('guest_wallet_id', body.walletId).maybeSingle()
      if (historyError) throw historyError
      const { data: credential, error: credentialError } = await supabase
        .from('wallet_v2_credentials').select('secret_hash, state')
        .eq('wallet_id', body.walletId).maybeSingle()
      if (credentialError) throw credentialError
      if (credential?.secret_hash !== secretHash ||
          !['active', 'linked'].includes(credential.state)) {
        return respond({ error: 'Guest wallet proof failed.' }, 403)
      }
      let result: Record<string, unknown> | null = null
      if (history) {
        if (history.request_id !== body.idempotencyKey) {
          return respond({ error: 'Wallet merge request does not match.' }, 409)
        }
        const { data, error } = await auditedRpc('merge_verified_v2_subscribed_guest_preserving_once', {
          p_guest_wallet_id: body.walletId, p_guest_secret_hash: secretHash,
          p_apple_sub: appleSub, p_session_token_hash: sessionHash,
          p_request_id: body.idempotencyKey, p_purchase_token: history.purchase_token,
        })
        if (error?.code === 'P0001') return respond({ error: 'Subscription transfer requires review.' }, 409)
        if (error) throw error
        result = data?.[0] ?? null
      } else {
        const { data: purchase, error: purchaseError } = await supabase
          .from('device_subscriptions').select('product_id, purchase_token')
          .eq('device_id', body.walletId).maybeSingle()
        if (purchaseError) throw purchaseError
        const { data: balance, error: balanceError } = await supabase
          .from('device_credits').select('subscription_credits')
          .eq('device_id', body.walletId).maybeSingle()
        if (balanceError) throw balanceError
        if (purchase || (balance?.subscription_credits ?? 0) > 0) {
          if (!purchase?.product_id || !purchase.purchase_token ||
              !await verifySubscribedGuestPurchase(
                purchase.purchase_token, purchase.product_id, appleSub,
                body.walletId, isSubscriptionCanary, walletAutoMergeAllUsersEnabled,
              )) return respond({ error: 'Subscription transfer requires review.' }, 409)
          const { data, error } = await auditedRpc('merge_verified_v2_subscribed_guest_preserving_once', {
            p_guest_wallet_id: body.walletId, p_guest_secret_hash: secretHash,
            p_apple_sub: appleSub, p_session_token_hash: sessionHash,
            p_request_id: body.idempotencyKey, p_purchase_token: purchase.purchase_token,
          })
          if (error?.code === 'P0001') return respond({ error: 'Subscription transfer requires review.' }, 409)
          if (error) throw error
          result = data?.[0] ?? null
        } else {
          const { data, error } = await auditedRpc('merge_verified_v2_guest_wallet_once', {
            p_guest_wallet_id: body.walletId, p_guest_secret_hash: secretHash,
            p_apple_sub: appleSub, p_session_token_hash: sessionHash,
            p_request_id: body.idempotencyKey,
          })
          if (error?.code === 'P0001') return respond({ error: 'Wallet transfer requires review.' }, 409)
          if (error) throw error
          result = data?.[0] ?? null
        }
      }
      if (!result) throw new Error('Missing resumed wallet merge result')
      return respond({ decision: result.decision, canonicalWalletId: result.canonical_wallet_id })
    }

    if (typeof body?.identityToken !== 'string' || body.identityToken.length > 16_384) {
      return respond({ error: 'Invalid Apple identity.' }, 401)
    }
    const identity = await verifyAppleIdentityToken(body.identityToken, BUNDLE_ID)
    if (!identity ||
        (!allUsersEnabled && !allowlist.has(identity.sub) &&
         await sha256(identity.sub) !== '014252a83ff1048722f43fecfec725a43c4ce151af89bc1aad535f0609de8c45')) {
      return respond({ error: 'Not found.' }, 404)
    }

    if (body.action === 'sign_in') {
      const bytes = crypto.getRandomValues(new Uint8Array(32))
      const sessionToken = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
      const { data: walletId, error } = await auditedRpc('issue_apple_wallet_session', {
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
      const { data: walletId, error } = await auditedRpc('activate_apple_wallet_session', {
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
      const { data, error } = await auditedRpc('merge_linked_apple_subject_wallets_once', {
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
      // Legacy IDs are public identifiers, not possession proofs.
      if (Deno.env.get('WALLET_LEGACY_MERGE_ENABLED') !== 'true') {
        return respond({ error: 'Wallet transfer requires review.' }, 409)
      }
      // Apple proves ownership of its own subject-ID wallet. Arbitrary legacy
      // device IDs still need the separately reviewed exact-pair allowlist.
      const approvedPairs = JSON.parse(
        Deno.env.get('WALLET_LEGACY_MERGE_CANARY_PAIRS') ?? '{}',
      ) as Record<string, string[]>
      const ownsAppleSubjectWallet = walletAutoMergeAllUsersEnabled &&
        body.sourceWalletId === identity.sub
      const reviewedPair = Array.isArray(approvedPairs[identity.sub]) &&
        approvedPairs[identity.sub].includes(body.sourceWalletId)
      if (!ownsAppleSubjectWallet && !reviewedPair) {
        return respond({ error: 'Wallet transfer requires review.' }, 409)
      }
      const { data: sourceWallet, error: sourceWalletError } = await supabase
        .from('device_credits')
        .select('subscription_credits')
        .eq('device_id', body.sourceWalletId)
        .maybeSingle()
      if (sourceWalletError) throw sourceWalletError
      const { data: sourcePurchase, error: sourcePurchaseError } = await supabase
        .from('device_subscriptions')
        .select('product_id, purchase_token')
        .eq('device_id', body.sourceWalletId)
        .maybeSingle()
      if (sourcePurchaseError) throw sourcePurchaseError

      let verifiedSubscriptionToken: string | null = null
      let verifiedProductId: string | null = null
      if (Number(sourceWallet?.subscription_credits ?? 0) > 0 && !sourcePurchase) {
        const { data: latestGrant, error: grantError } = await supabase
          .from('credit_transactions')
          .select('metadata')
          .eq('device_id', body.sourceWalletId)
          .eq('transaction_type', 'subscription_monthly_grant')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()
        if (grantError) throw grantError
        const metadata = latestGrant?.metadata as Record<string, unknown> | null
        const originalTransactionId = metadata?.originalTransactionId
        const productId = metadata?.productId
        if (typeof originalTransactionId === 'string' && typeof productId === 'string') {
          verifiedSubscriptionToken = originalTransactionId
          verifiedProductId = productId
        }
      } else if (sourcePurchase) {
        verifiedSubscriptionToken = sourcePurchase.purchase_token
        verifiedProductId = sourcePurchase.product_id
      }
      if ((Number(sourceWallet?.subscription_credits ?? 0) > 0 || sourcePurchase) &&
          (!verifiedSubscriptionToken || !verifiedProductId ||
           !await verifySubscribedGuestPurchase(
             verifiedSubscriptionToken, verifiedProductId, identity.sub,
             body.sourceWalletId, false, walletAutoMergeAllUsersEnabled,
           ))) {
        return respond({ error: 'Subscription transfer requires review.' }, 409)
      }

      const { data, error } = await auditedRpc('merge_verified_legacy_wallet_v2_once', {
        p_source_wallet_id: body.sourceWalletId,
        p_apple_sub: identity.sub,
        p_session_token_hash: await walletTokenHash(body.sessionToken),
        p_request_id: body.idempotencyKey,
        p_verified_subscription_token: verifiedSubscriptionToken,
        p_verified_product_id: verifiedProductId,
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
        subscriptionCredits: result.subscription_credits_remaining,
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
      const { data, error } = await auditedRpc('merge_verified_v2_guest_wallet_once', {
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

    if (body.action === 'merge_subscribed_guest') {
      const subscriptionCanaries = new Set(
        (Deno.env.get('WALLET_SUBSCRIPTION_MERGE_CANARY_APPLE_IDS') ?? '')
          .split(',').map((id) => id.trim()).filter(Boolean),
      )
      const isSubscriptionCanary = subscriptionCanaries.has(identity.sub) ||
        await sha256(identity.sub) === '014252a83ff1048722f43fecfec725a43c4ce151af89bc1aad535f0609de8c45'
      if ((!allUsersEnabled && !isSubscriptionCanary) ||
          !isHexSecret(body.sessionToken) ||
          typeof body.idempotencyKey !== 'string' || body.idempotencyKey.length < 1 ||
          body.idempotencyKey.length > 128) {
        return respond({ error: 'Subscription transfer unavailable.' }, 409)
      }
      const { data: priorTransfer, error: priorTransferError } = await supabase
        .from('credit_v2_subscription_transfer_grants').select('purchase_token, request_id')
        .eq('guest_wallet_id', body.walletId).maybeSingle()
      if (priorTransferError) throw priorTransferError
      const { data: guestCredential, error: credentialError } = await supabase
        .from('wallet_v2_credentials').select('secret_hash, state')
        .eq('wallet_id', body.walletId).maybeSingle()
      if (credentialError) throw credentialError
      if (guestCredential?.secret_hash !== secretHash ||
          guestCredential.state !== (priorTransfer ? 'linked' : 'active')) {
        return respond({ error: 'Guest wallet proof failed.' }, 403)
      }
      let purchaseToken = priorTransfer?.purchase_token as string | undefined
      if (priorTransfer && priorTransfer.request_id !== body.idempotencyKey) {
        return respond({ error: 'Subscription transfer requires review.' }, 409)
      }
      let sourcePurchase: { product_id: string; purchase_token: string } | null = null
      if (!priorTransfer) {
        const { data, error: purchaseError } = await supabase
          .from('device_subscriptions').select('product_id, purchase_token')
          .eq('device_id', body.walletId).maybeSingle()
        if (purchaseError) throw purchaseError
        sourcePurchase = data
        purchaseToken = sourcePurchase?.purchase_token
        if (!sourcePurchase?.product_id || !purchaseToken) {
          return respond({ error: 'Subscription transfer requires review.' }, 409)
        }
      }
      if (!priorTransfer && !await verifySubscribedGuestPurchase(
        purchaseToken!, sourcePurchase!.product_id, identity.sub, body.walletId,
        isSubscriptionCanary, walletAutoMergeAllUsersEnabled,
      )) {
        // A failed purchase check must never move subscription credits. For
        // approved test accounts, defer the transfer without blocking sign-in.
        if (subscriptionCanaries.has(identity.sub) ||
            await sha256(identity.sub) === '014252a83ff1048722f43fecfec725a43c4ce151af89bc1aad535f0609de8c45') {
          return respond({ error: 'Subscription transfer requires review.' }, 409)
        }
        return respond({ error: 'Apple subscription does not match this wallet.' }, 409)
      }
      const { data, error } = await auditedRpc('merge_verified_v2_subscribed_guest_preserving_once', {
        p_guest_wallet_id: body.walletId,
        p_guest_secret_hash: secretHash,
        p_apple_sub: identity.sub,
        p_session_token_hash: await walletTokenHash(body.sessionToken),
        p_request_id: body.idempotencyKey,
        p_purchase_token: purchaseToken!,
      })
      if (error?.code === 'P0001') return respond({ error: 'Subscription transfer requires review.' }, 409)
      if (error) throw error
      const result = data?.[0]
      if (!result) throw new Error('Missing subscription transfer result')
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
      const { data, error } = await auditedRpc('link_apple_wallet_v2', {
        p_wallet_id: body.walletId,
        p_secret_hash: secretHash,
        p_apple_sub: identity.sub,
        p_idempotency_key: body.idempotencyKey,
      })
      if (error?.code === 'P0001') return respond({ error: 'Wallet link requires review.' }, 409)
      if (error) throw error
      const result = data?.[0]
      if (!result) throw new Error('Missing wallet link result')
      let needsSubscriptionTransfer = false
      if (result.decision === 'apple_existing_unmerged') {
        const { data: purchase, error: purchaseError } = await supabase
          .from('device_subscriptions').select('device_id')
          .eq('device_id', body.walletId).maybeSingle()
        if (purchaseError) throw purchaseError
        const { data: source, error: sourceError } = await supabase
          .from('device_credits').select('subscription_credits')
          .eq('device_id', body.walletId).single()
        if (sourceError) throw sourceError
        needsSubscriptionTransfer = purchase !== null || source.subscription_credits !== 0
      }
      return respond({
        decision: result.decision,
        canonicalWalletId: result.canonical_wallet_id,
        guestTransferred: false,
        needsSubscriptionTransfer,
      })
    }

    return respond({ error: 'Unknown action.' }, 400)
  } catch (error) {
    const details = error && typeof error === 'object'
      ? error as { code?: unknown; message?: unknown }
      : {}
    const message = typeof details.message === 'string' ? details.message : ''
    console.error(JSON.stringify({
      event: 'wallet_link_v2_failure',
      auditId,
      walletFingerprints: [...walletFingerprints],
      operationFingerprint,
      action: requestAction,
      stage,
      sqlstate: typeof details.code === 'string' ? details.code : null,
      reason: message === 'Service role required' ? 'service_role_required' : 'other',
      serviceRoleKeyKind: serviceRoleKeyKind(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')),
    }))
    return respond({ error: 'Wallet linking unavailable.' }, 500)
  }
})
