// Links a device_credits row to an Apple ID after Sign in with Apple succeeds
// on the client. The client posts { deviceId, appleUserId, identityToken } and
// we verify the JWT against Apple's JWKS before touching the database.
//
// Legacy endpoint. Keep existing rows intact when two wallets conflict.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { verifyAppleIdentityToken } from './_shared/apple_auth.ts'
import { requiresWalletSession } from './_shared/wallet_auth.ts'

const BUNDLE_ID = 'com.kingboard.app'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

async function reject409(
  body: { error: string; code: string },
  path: string,
  deviceId: string,
  appleUserId: string,
) {
  try {
    const fingerprint = async (value: string) => {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 16)
    }
    console.info(JSON.stringify({
      event: 'legacy_apple_link_rejected',
      code: body.code,
      path,
      wallet_fingerprint: await fingerprint(deviceId),
      apple_fingerprint: await fingerprint(appleUserId),
    }))
  } catch {
    // Diagnostic logging must never change the login response.
  }
  return json(body, 409)
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const { deviceId, appleUserId, identityToken } = await req.json()
    if (typeof deviceId !== 'string' || !deviceId) return json({ error: 'Missing deviceId.' }, 400)
    if (typeof appleUserId !== 'string' || !appleUserId) return json({ error: 'Missing appleUserId.' }, 400)
    if (typeof identityToken !== 'string' || !identityToken) return json({ error: 'Missing identityToken.' }, 400)

    const identity = await verifyAppleIdentityToken(identityToken, BUNDLE_ID)
    if (!identity || identity.sub !== appleUserId) {
      return json({ error: 'Invalid identity token.' }, 401)
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    if (await requiresWalletSession(supabase, deviceId) ||
        await requiresWalletSession(supabase, identity.sub)) {
      return reject409({
        error: '지갑을 안전하게 연결하려면 최신 버전으로 업데이트해 주세요.',
        code: 'WALLET_UPDATE_REQUIRED',
      }, 'session_required', deviceId, identity.sub)
    }

    // An existing Apple wallet cannot be moved to an unverified request ID.
    const { data: existingLinked, error: findError } = await supabase
      .from('device_credits')
      .select('device_id, free_credits, paid_credits, subscription_credits')
      .eq('apple_user_id', appleUserId)
      .maybeSingle()
    if (findError) throw findError

    if (existingLinked) {
      if (existingLinked.device_id !== deviceId) {
        // Apple proof permits reading its existing raw-ID row, never transferring
        // a device wallet or falling through to the protected canonical balance.
        if (deviceId === identity.sub && existingLinked.device_id.startsWith('v2:')) {
          const { data: legacy, error: legacyError } = await supabase
            .from('device_credits')
            .select('device_id, apple_user_id, free_credits, paid_credits, subscription_credits')
            .eq('device_id', deviceId).maybeSingle()
          if (legacyError) throw legacyError
          if (legacy?.device_id === deviceId && legacy.apple_user_id === null) {
            return json({
              free_credits_remaining: legacy.free_credits,
              paid_credits_remaining: legacy.paid_credits + legacy.subscription_credits,
              credits_remaining: legacy.free_credits + legacy.paid_credits + legacy.subscription_credits,
              canonical_device_id: deviceId,
              migrated: false,
              granted_install_bonus: false,
            })
          }
        }
        return reject409({
          error: '지갑을 안전하게 연결하려면 최신 버전으로 업데이트해 주세요.',
          code: 'WALLET_UPDATE_REQUIRED',
        }, 'existing_apple_wallet', deviceId, identity.sub)
      }
      return json({
        free_credits_remaining: existingLinked.free_credits,
        paid_credits_remaining: existingLinked.paid_credits + existingLinked.subscription_credits,
        credits_remaining: existingLinked.free_credits + existingLinked.paid_credits + existingLinked.subscription_credits,
        canonical_device_id: deviceId,
        migrated: false,
        granted_install_bonus: false,
      })
    }

    // Stage 1 links only unprotected existing legacy wallets; no credits move.
    const { data: currentRow, error: currentError } = await supabase
      .from('device_credits')
      .select('device_id, apple_user_id, free_credits, paid_credits, subscription_credits')
      .eq('device_id', deviceId)
      .maybeSingle()
    if (currentError) throw currentError

    if (currentRow) {
      if (currentRow.apple_user_id && currentRow.apple_user_id !== appleUserId) {
        return reject409({
          error: '이 기기 지갑은 다른 Apple 계정에 연결되어 있어요.',
          code: 'WALLET_OWNERSHIP_CONFLICT',
        }, 'current_other_owner', deviceId, identity.sub)
      }
      if (!currentRow.apple_user_id) {
        const { data: claim, error: claimError } = await supabase.rpc(
          'claim_unprotected_legacy_apple_wallet',
          { p_device_id: deviceId, p_apple_sub: identity.sub }
        ).single()
        if (claimError || !claim) throw claimError ?? new Error('Legacy link claim returned no row')
        if (claim.decision === 'linked' || claim.decision === 'already_linked') {
          return json({
            free_credits_remaining: claim.free_credits,
            paid_credits_remaining: claim.paid_credits + claim.subscription_credits,
            credits_remaining: claim.free_credits + claim.paid_credits + claim.subscription_credits,
            canonical_device_id: deviceId,
            migrated: false,
            granted_install_bonus: false,
          })
        }
        if (claim.decision === 'other_owner') {
          return reject409({
            error: '이 기기 지갑은 다른 Apple 계정에 연결되어 있어요.',
            code: 'WALLET_OWNERSHIP_CONFLICT',
          }, 'claim_other_owner', deviceId, identity.sub)
        }
        if (claim.decision === 'missing') {
          return reject409({
            error: '새 지갑은 앱을 최신 버전으로 업데이트한 뒤 등록해 주세요.',
            code: 'WALLET_REGISTRATION_REQUIRED',
          }, 'claim_missing', deviceId, identity.sub)
        }
        return reject409({
          error: '지갑을 안전하게 연결하려면 최신 버전으로 업데이트해 주세요.',
          code: 'WALLET_UPDATE_REQUIRED',
        }, claim.decision === 'protected' ? 'claim_protected' :
          claim.decision === 'apple_existing' ? 'claim_apple_existing' :
          'claim_unexpected', deviceId, identity.sub)
      }
      return json({
        free_credits_remaining: currentRow.free_credits,
        paid_credits_remaining: currentRow.paid_credits + currentRow.subscription_credits,
        credits_remaining: currentRow.free_credits + currentRow.paid_credits + currentRow.subscription_credits,
        canonical_device_id: deviceId,
        migrated: false,
        granted_install_bonus: false,
      })
    }

    // Apple authentication alone is not proof of a first device install.
    // New bonus wallets must come from the DeviceCheck-backed V2 claim flow.
    return reject409({
      error: '새 지갑은 앱을 최신 버전으로 업데이트한 뒤 등록해 주세요.',
      code: 'WALLET_REGISTRATION_REQUIRED',
    }, 'missing_wallet', deviceId, identity.sub)
  } catch (e) {
    console.error('[link_apple_user]', e)
    return json({ error: String(e) }, 500)
  }
})

