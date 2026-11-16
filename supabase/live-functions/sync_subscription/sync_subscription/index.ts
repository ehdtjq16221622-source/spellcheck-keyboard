import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  getCredits,
  googleSubscriptionCreditsForProduct,
  setMonthlySubscriptionCredits,
} from './_shared/credits.ts'
import { acknowledgeSubscription, verifySubscription } from './_shared/google_play.ts'
import { GoogleSubscriptionInputError, googleV2SyncInput, isGoogleV2Product } from './_shared/google_subscription_v2.ts'
import { resolveCreditWallet, WalletAccessError } from './_shared/wallet_auth.ts'
import {
  logSubscriptionAudit,
  safeSubscriptionFailureCode,
  subscriptionFailureHttpStatus,
  subscriptionTransactionFingerprint,
  subscriptionWalletFingerprint,
} from './_shared/subscription_audit.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

type DeviceSubscriptionRow = {
  device_id: string
  product_id: string
  purchase_token: string
  subscription_state: string
  expiry_time_millis: number | null
  latest_order_id: string | null
  last_cycle_key: string | null
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const auditId = crypto.randomUUID()
  let auditStage = 'parse_request'
  let auditWalletFingerprint: string | undefined
  let auditTransactionFingerprint: string | undefined
  let auditCanary = false
  try {
    const { deviceId, productId, purchaseToken, packageName } = await req.json()
    if (!deviceId || !productId || !purchaseToken) {
      logSubscriptionAudit('warn', auditId, 'rejected', {
        stage: auditStage, source: 'google_play', failureCode: 'missing_required_fields',
      })
      return new Response(
        JSON.stringify({ error: 'Missing required subscription fields.', audit_id: auditId }),
        { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } }
      )
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // Current plans (same products and credits as iOS): signed-in wallet session, account-token
    // binding, linked-token plan changes, and server-side acknowledgement.
    if (isGoogleV2Product(productId)) {
      const v2PackageName = Deno.env.get('GOOGLE_PLAY_PACKAGE_NAME') ?? 'com.spellcheck.keyboard'
      auditStage = 'wallet_resolution'
      const wallet = await resolveCreditWallet(req, supabase, deviceId, true)
      auditWalletFingerprint = await subscriptionWalletFingerprint(wallet.walletId)
      const { data: owner, error: ownerError } = await supabase
        .from('device_credits').select('apple_user_id').eq('device_id', wallet.walletId).maybeSingle()
      if (ownerError) throw ownerError
      if (!wallet.authenticated || !owner?.apple_user_id) {
        return new Response(JSON.stringify({ error: 'google_sign_in_required', audit_id: auditId }),
          { status: 403, headers: { ...cors, 'Content-Type': 'application/json' } })
      }
      auditStage = 'account_token'
      const { data: accountToken, error: tokenError } = await supabase.rpc('credit_pack_account_token', { p_wallet_id: wallet.walletId })
      if (tokenError || typeof accountToken !== 'string') throw tokenError ?? new Error('account_token_unavailable')

      auditStage = 'google_verification'
      const verified = await verifySubscription(v2PackageName, productId, purchaseToken)
      auditTransactionFingerprint = await subscriptionTransactionFingerprint(`${purchaseToken}:${productId}`)
      const isOurAccount = (value: string | null) =>
        typeof value === 'string' && value.toLowerCase() === accountToken.toLowerCase()
      let boundToWallet = isOurAccount(verified.obfuscatedAccountId)
      if (!boundToWallet && !verified.obfuscatedAccountId) {
        // Bought or resubscribed in the Play Store itself: Google carries no account ID. Accept it
        // only when it continues a subscription this wallet already holds.
        boundToWallet = isOurAccount(verified.expiredObfuscatedAccountId)
        const earlierTokens = [purchaseToken, verified.linkedPurchaseToken, verified.expiredPurchaseToken]
          .filter((token): token is string => typeof token === 'string' && token.length > 0 && token.length <= 512)
        if (!boundToWallet && earlierTokens.length > 0) {
          const { data: held, error: heldError } = await supabase.from('device_subscriptions')
            .select('device_id').in('purchase_token', earlierTokens)
          if (heldError) throw heldError
          boundToWallet = Array.isArray(held) && held.length > 0 &&
            held.every((row: { device_id: string }) => row.device_id === wallet.walletId)
        }
      }
      if (!boundToWallet) {
        logSubscriptionAudit('warn', auditId, 'rejected', {
          stage: 'google_account_binding', source: 'google_play_v2', failureCode: 'google_account_binding_mismatch',
          walletFingerprint: auditWalletFingerprint, transactionFingerprint: auditTransactionFingerprint,
        })
        return new Response(JSON.stringify({ error: 'Subscription belongs to a different account.', audit_id: auditId }),
          { status: 403, headers: { ...cors, 'Content-Type': 'application/json' } })
      }
      let input
      try {
        input = googleV2SyncInput(verified, productId, purchaseToken)
      } catch (error) {
        if (error instanceof GoogleSubscriptionInputError) {
          const waiting = error.code === 'subscription_pending' || error.code === 'subscription_change_scheduled'
          return new Response(JSON.stringify({ error: error.code, audit_id: auditId }),
            { status: waiting ? 202 : 400, headers: { ...cors, 'Content-Type': 'application/json' } })
        }
        throw error
      }
      auditStage = 'atomic_subscription_and_grant'
      const { data, error } = await supabase.rpc('sync_google_subscription_v2_once', {
        p_device_id: wallet.walletId, p_product_id: productId, p_purchase_token: purchaseToken,
        p_linked_purchase_token: input.linkedPurchaseToken, p_state: input.state,
        p_expiry_time_millis: input.expiryTimeMillis, p_order_id: verified.orderId, p_cycle_key: input.cycleKey,
        p_amount: input.amount,
        p_metadata: { audit_id: auditId, transaction_fingerprint: auditTransactionFingerprint,
          google_purchase_verified: true, test_purchase: verified.testPurchase },
      })
      // The old token of a changed plan: the wallet already moved to the new one. Not a failure.
      if (error && /not the current Google subscription/.test(error.message ?? '')) {
        return new Response(JSON.stringify({ error: 'subscription_not_current', audit_id: auditId }),
          { status: 409, headers: { ...cors, 'Content-Type': 'application/json' } })
      }
      if (error) throw error
      const result = Array.isArray(data) ? data[0] : data
      if (!result) throw new Error('Google subscription sync response was empty.')
      let acknowledged = verified.acknowledged
      if (!acknowledged && input.state === 'SUBSCRIPTION_STATE_ACTIVE') {
        auditStage = 'google_acknowledge'
        try {
          await acknowledgeSubscription(v2PackageName, productId, purchaseToken)
          acknowledged = true
        } catch {
          // The grant is recorded; the app syncs again on next launch and acknowledgement is retried.
        }
      }
      logSubscriptionAudit('info', auditId, 'atomic_sync_completed', {
        stage: auditStage, source: 'google_play_v2', state: input.state, active: input.state === 'SUBSCRIPTION_STATE_ACTIVE',
        grantApplied: result.applied === true, walletFingerprint: auditWalletFingerprint,
        transactionFingerprint: auditTransactionFingerprint,
      })
      return new Response(JSON.stringify({
        subscription_active: input.state === 'SUBSCRIPTION_STATE_ACTIVE' || input.state === 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
        subscription_state: input.state,
        subscription_expiry_time_millis: input.expiryTimeMillis,
        monthly_credit_granted: result.applied === true,
        free_credits_remaining: Number(result.free_credits_remaining),
        paid_credits_remaining: Number(result.paid_credits_remaining),
        credits_remaining: Number(result.credits_remaining),
        acknowledged,
        audit_id: auditId,
      }), { headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    const expectedPackageName =
      Deno.env.get('GOOGLE_PLAY_PACKAGE_NAME') ??
      packageName ??
      'com.spellcheck.keyboard'
    const monthlyCredits = googleSubscriptionCreditsForProduct(productId)

    auditStage = 'google_verification'
    const verified = await verifySubscription(expectedPackageName, productId, purchaseToken)
    auditWalletFingerprint = await subscriptionWalletFingerprint(deviceId)
    auditTransactionFingerprint = await subscriptionTransactionFingerprint(
      [purchaseToken, productId, verified.cycleKey ?? ''].join(':'),
    )
    logSubscriptionAudit('info', auditId, 'verification_completed', {
      stage: auditStage, source: 'google_play',
      product: productId === 'kingboard_monthly_1000' ? 'premium' : 'basic',
      state: verified.state, active: verified.active,
      walletFingerprint: auditWalletFingerprint,
      transactionFingerprint: auditTransactionFingerprint,
    })

    if (
      verified.obfuscatedAccountId &&
      verified.obfuscatedAccountId !== deviceId
    ) {
      logSubscriptionAudit('warn', auditId, 'rejected', {
        stage: 'google_account_binding', source: 'google_play',
        walletFingerprint: auditWalletFingerprint,
        transactionFingerprint: auditTransactionFingerprint,
        failureCode: 'google_account_binding_mismatch',
      })
      return new Response(
        JSON.stringify({ error: 'Subscription belongs to a different device.', audit_id: auditId }),
        { status: 403, headers: { ...cors, 'Content-Type': 'application/json' } }
      )
    }

    // Verify the store-bound device ID first, then resolve linked sessions so
    // subscription state, monthly credits, and the returned balance use one wallet.
    auditStage = 'wallet_resolution'
    const wallet = await resolveCreditWallet(req, supabase, deviceId)
    auditWalletFingerprint = await subscriptionWalletFingerprint(wallet.walletId)
    const atomicCanaryWallets = (Deno.env.get('GOOGLE_SUBSCRIPTION_ATOMIC_CANARY_WALLETS') ?? '')
      .split(',').map((id) => id.trim()).filter(Boolean)
    auditCanary = atomicCanaryWallets.includes(deviceId) || atomicCanaryWallets.includes(wallet.walletId)

    if (auditCanary) {
      if (!['kingboard_monthly_500', 'kingboard_monthly_1000'].includes(productId)) {
        logSubscriptionAudit('warn', auditId, 'rejected', {
          stage: 'product_validation', source: 'google_play', canary: true,
          walletFingerprint: auditWalletFingerprint,
          transactionFingerprint: auditTransactionFingerprint,
          failureCode: 'unknown_subscription_product',
        })
        return new Response(JSON.stringify({ error: 'Unknown subscription product.', audit_id: auditId }), {
          status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }

      auditStage = 'atomic_subscription_and_grant'
      const cycleKey = verified.active && verified.cycleKey
        ? [purchaseToken, productId, verified.cycleKey].join(':')
        : null
      const { data, error } = await supabase.rpc('sync_google_subscription_once', {
        p_device_id: wallet.walletId,
        p_product_id: productId,
        p_purchase_token: purchaseToken,
        p_state: verified.state,
        p_expiry_time_millis: verified.expiryTimeMillis,
        p_order_id: verified.orderId,
        p_cycle_key: cycleKey,
        p_amount: monthlyCredits,
        p_metadata: {
          audit_id: auditId,
          transaction_fingerprint: auditTransactionFingerprint,
          google_purchase_verified: true,
        },
      })
      if (error) throw error
      const result = Array.isArray(data) ? data[0] : data
      if (!result) throw new Error('Google subscription sync response was empty.')
      logSubscriptionAudit('info', auditId, 'atomic_sync_completed', {
        stage: auditStage, source: 'google_play',
        product: productId === 'kingboard_monthly_1000' ? 'premium' : 'basic',
        state: verified.state, active: verified.active, canary: true,
        grantApplied: result.applied === true,
        walletFingerprint: auditWalletFingerprint,
        transactionFingerprint: auditTransactionFingerprint,
      })
      return new Response(JSON.stringify({
        subscription_active: verified.active,
        subscription_state: verified.state,
        subscription_expiry_time_millis: verified.expiryTimeMillis,
        monthly_credit_granted: result.applied === true,
        free_credits_remaining: Number(result.free_credits_remaining),
        paid_credits_remaining: Number(result.paid_credits_remaining),
        credits_remaining: Number(result.credits_remaining),
        audit_id: auditId,
      }), { headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    const { data: existing, error: existingError } = await supabase
      .from('device_subscriptions')
      .select(
        'device_id, product_id, purchase_token, subscription_state, expiry_time_millis, latest_order_id, last_cycle_key'
      )
      .eq('device_id', wallet.walletId)
      .maybeSingle()

    if (existingError) throw existingError

    let monthlyGrantApplied = false
    const previousCycle = (existing as DeviceSubscriptionRow | null)?.last_cycle_key ?? null
    if (verified.active && verified.cycleKey && previousCycle !== verified.cycleKey) {
      const grant = await setMonthlySubscriptionCredits(
        supabase,
        wallet.walletId,
        monthlyCredits,
        [purchaseToken, productId, verified.cycleKey].join(':'),
        { productId, orderId: verified.orderId, cycleKey: verified.cycleKey, audit_id: auditId }
      )
      monthlyGrantApplied = grant.applied
    }

    const row: DeviceSubscriptionRow = {
      device_id: wallet.walletId,
      product_id: productId,
      purchase_token: purchaseToken,
      subscription_state: verified.state,
      expiry_time_millis: verified.expiryTimeMillis,
      latest_order_id: verified.orderId,
      last_cycle_key: verified.cycleKey,
    }

    const { error: upsertError } = await supabase
      .from('device_subscriptions')
      .upsert(
        {
          ...row,
          last_verified_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'device_id' }
      )
    if (upsertError) throw upsertError

    const credits = await getCredits(supabase, wallet.walletId)

    return new Response(
      JSON.stringify({
        subscription_active: verified.active,
        subscription_state: verified.state,
        subscription_expiry_time_millis: verified.expiryTimeMillis,
        monthly_credit_granted: monthlyGrantApplied,
        free_credits_remaining: credits.freeCredits,
        paid_credits_remaining: credits.paidCredits,
        credits_remaining: credits.remaining,
        audit_id: auditId,
      }),
      { headers: { ...cors, 'Content-Type': 'application/json' } }
    )
  } catch (e) {
    const failureCode = safeSubscriptionFailureCode(auditStage, e)
    const conflictStatus = subscriptionFailureHttpStatus(e)
    logSubscriptionAudit('error', auditId, 'sync_failed', {
      stage: auditStage, source: 'google_play', canary: auditCanary,
      failureCode, walletFingerprint: auditWalletFingerprint,
      transactionFingerprint: auditTransactionFingerprint,
    })
    return new Response(
      JSON.stringify({ error: 'Subscription sync failed.', code: failureCode, audit_id: auditId }),
      {
        status: e instanceof WalletAccessError ? e.status : conflictStatus ?? 500,
        headers: { ...cors, 'Content-Type': 'application/json' },
      }
    )
  }
})

