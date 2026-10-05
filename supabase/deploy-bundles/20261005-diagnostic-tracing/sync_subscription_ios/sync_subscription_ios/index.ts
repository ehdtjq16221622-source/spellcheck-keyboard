import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  getCredits,
  setMonthlySubscriptionCredits,
  subscriptionCreditsForProduct,
} from '../_shared/credits.ts'
import { verifyAppleSubscription } from '../_shared/apple_receipt.ts'
import {
  verifyActiveApplePurchase,
  verifyAppleTransactionJws,
} from '../_shared/apple_subscription_status.ts'
import { resolveCreditWallet, WalletAccessError } from '../_shared/wallet_auth.ts'
import {
  logSubscriptionAudit,
  safeSubscriptionFailureCode,
  subscriptionFailureHttpStatus,
  subscriptionWalletFingerprint,
} from '../_shared/subscription_audit.ts'

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

function subscriptionFailureResponse(
  error: string,
  diagnosticId: string,
  failureStage: string,
  status: number,
  corsHeaders: Record<string, string>,
): Response {
  return new Response(JSON.stringify({
    error,
    audit_id: diagnosticId,
    diagnostic_id: diagnosticId,
    failure_stage: failureStage,
  }), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
      'X-Kingboard-Diagnostic-ID': diagnosticId,
      'Access-Control-Expose-Headers': 'X-Kingboard-Diagnostic-ID',
    },
  })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const auditId = crypto.randomUUID()
  let auditStage = 'parse_request'
  let auditProduct: 'basic' | 'premium' | 'pro' | 'other' = 'other'
  let auditSource: 'storekit_jws' | 'app_receipt' | 'unknown' = 'unknown'
  let auditIsCanary = false
  let auditWalletFingerprint: string | undefined
  try {
    const { deviceId: requestedDeviceId, productId, jwsToken, receiptData, bundleId } = await req.json()
    auditProduct = productId === 'com.kingboard.app.monthly_basic' ? 'basic'
      : productId === 'com.kingboard.app.monthly_premium' ? 'premium'
      : productId === 'com.kingboard.app.monthly_pro' ? 'pro' : 'other'
    auditSource = jwsToken ? 'storekit_jws' : receiptData ? 'app_receipt' : 'unknown'
    if (!requestedDeviceId || !productId || (!jwsToken && !receiptData)) {
      logSubscriptionAudit('warn', auditId, 'rejected', {
        stage: auditStage, product: auditProduct, source: auditSource,
        failureCode: 'missing_required_fields',
      })
      return new Response(
        JSON.stringify({ error: 'Missing required subscription fields.', audit_id: auditId, diagnostic_id: auditId, failure_stage: auditStage }),
        { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } }
      )
    }
    auditWalletFingerprint = await subscriptionWalletFingerprint(requestedDeviceId)
    auditStage = 'supabase_client_setup'
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )
    auditStage = 'wallet_resolution'
    const { data: walletAlias, error: aliasError } = await supabase
      .from('credit_wallet_aliases')
      .select('canonical_wallet_id')
      .eq('source_wallet_id', requestedDeviceId)
      .maybeSingle()
    if (aliasError) throw aliasError
    const resolvedWalletId = walletAlias?.canonical_wallet_id ?? requestedDeviceId
    const canaryWallets = (Deno.env.get('IOS_SUBSCRIPTION_ATOMIC_CANARY_WALLETS') ?? '')
      .split(',').map((id) => id.trim()).filter(Boolean)
    auditStage = 'canary_classification'
    const isCanary = canaryWallets.includes(requestedDeviceId) ||
      canaryWallets.includes(resolvedWalletId)
    const atomicAllUsersRequested =
      Deno.env.get('IOS_SUBSCRIPTION_ATOMIC_ALL_USERS_ENABLED') === 'true'
    if (atomicAllUsersRequested && Deno.env.get('WALLET_SESSIONS_ENABLED') !== 'true') {
      throw new WalletAccessError('앱을 최신 버전으로 업데이트해 주세요.', 503)
    }
    // Enabling rollout admits authenticated new clients, not every old request.
    const wallet = await resolveCreditWallet(req, supabase, requestedDeviceId,
      isCanary || Boolean(walletAlias))
    const useAtomicSync = isCanary || (atomicAllUsersRequested && wallet.authenticated)
    auditIsCanary = isCanary
    logSubscriptionAudit('info', auditId, 'request_accepted', {
      stage: 'request_accepted', product: auditProduct, source: auditSource, canary: isCanary,
      walletFingerprint: auditWalletFingerprint,
    })
    if (useAtomicSync && ![
      'com.kingboard.app.monthly_basic',
      'com.kingboard.app.monthly_premium',
      'com.kingboard.app.monthly_pro',
    ].includes(productId)) {
      logSubscriptionAudit('warn', auditId, 'rejected', {
        stage: 'product_validation', product: auditProduct, source: auditSource,
        canary: isCanary, failureCode: 'unknown_subscription_product',
      })
      return new Response(JSON.stringify({ error: 'Unknown subscription product.', audit_id: auditId, diagnostic_id: auditId, failure_stage: auditStage }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }
    const deviceId = wallet.walletId

    const expectedBundleId = useAtomicSync
      ? (Deno.env.get('APPLE_APP_BUNDLE_ID') ?? 'com.kingboard.app')
      : (Deno.env.get('APPLE_APP_BUNDLE_ID') ?? bundleId ?? 'com.kingboard.app')

    // StoreKit 2 clients send jwsToken (transaction.jwsRepresentation).
    // Older clients (or restore-purchase flows) may still send receiptData.
    let verified: Awaited<ReturnType<typeof verifyAppleSubscription>>
    auditStage = 'apple_verification'
    logSubscriptionAudit('info', auditId, 'verification_started', {
      stage: auditStage, product: auditProduct, source: auditSource, canary: isCanary,
    })
    if (isCanary) {
      if (!receiptData) {
        logSubscriptionAudit('warn', auditId, 'rejected', {
          stage: 'apple_verification', product: auditProduct, source: auditSource,
          canary: true, failureCode: 'receipt_required',
        })
        return new Response(JSON.stringify({ error: 'Apple receipt is required for this wallet.', audit_id: auditId, diagnostic_id: auditId, failure_stage: auditStage }), {
          status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }
      verified = await verifyAppleSubscription(receiptData as string, productId, expectedBundleId)
    } else if (jwsToken) {
      try {
        const payload = await verifyAppleTransactionJws(
          jwsToken as string,
          expectedBundleId,
          productId,
        )
        const expiryMs = typeof payload.expiresDate === 'number' ? payload.expiresDate : null
        const isActive = expiryMs != null && expiryMs > Date.now()
        verified = {
          active: isActive,
          state: isActive ? 'SUBSCRIPTION_STATE_ACTIVE' : 'SUBSCRIPTION_STATE_EXPIRED',
          expiryTimeMillis: expiryMs,
          cycleKey: expiryMs != null ? String(expiryMs) : null,
          orderId: payload.transactionId ?? null,
          originalTransactionId: payload.originalTransactionId ?? payload.transactionId ?? null,
          latestReceipt: null,
          environment: payload.environment ?? null,
        }
      } catch (jwsError) {
        if (!receiptData) throw jwsError
        logSubscriptionAudit('warn', auditId, 'jws_fallback_to_receipt', {
          stage: 'apple_verification', product: auditProduct, source: auditSource,
          canary: isCanary, failureCode: 'jws_verification_failed',
        })
        verified = await verifyAppleSubscription(receiptData as string, productId, expectedBundleId, false)
      }
    } else {
      verified = await verifyAppleSubscription(receiptData as string, productId, expectedBundleId, false)
    }
    if (useAtomicSync && (!verified.originalTransactionId || verified.state === 'SUBSCRIPTION_STATE_NOT_FOUND')) {
      logSubscriptionAudit('warn', auditId, 'verification_rejected', {
        stage: 'apple_verification', product: auditProduct, source: auditSource,
        canary: isCanary, state: verified.state, active: verified.active,
        failureCode: 'subscription_not_found',
      })
      return new Response(JSON.stringify({ error: 'Subscription purchase was not found.', audit_id: auditId, diagnostic_id: auditId, failure_stage: auditStage }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }
    logSubscriptionAudit('info', auditId, 'verification_completed', {
      stage: 'apple_verification', product: auditProduct, source: auditSource,
      environment: verified.environment, state: verified.state, active: verified.active,
      canary: isCanary,
    })

    auditStage = 'subscription_lookup'
    const { data: existing, error: existingError } = await supabase
      .from('device_subscriptions')
      .select(
        'device_id, product_id, purchase_token, subscription_state, expiry_time_millis, latest_order_id, last_cycle_key'
      )
      .eq('device_id', deviceId)
      .maybeSingle()

    if (existingError) throw existingError

    let appleCurrentProductVerified = false
    if (useAtomicSync && existing?.product_id && existing.product_id !== productId) {
      auditStage = 'plan_change_verification'
      if (!verified.active || !verified.originalTransactionId) {
        logSubscriptionAudit('warn', auditId, 'rejected', {
          stage: 'plan_change_verification', product: auditProduct, source: auditSource,
          canary: isCanary, state: verified.state, active: verified.active,
          failureCode: 'new_plan_not_active',
        })
        return new Response(JSON.stringify({ error: 'The new subscription plan is not active.', audit_id: auditId, diagnostic_id: auditId, failure_stage: auditStage }), {
          status: 409, headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }
      appleCurrentProductVerified = await verifyActiveApplePurchase(
        verified.originalTransactionId, productId, expectedBundleId,
      )
      if (!appleCurrentProductVerified) {
        logSubscriptionAudit('warn', auditId, 'rejected', {
          stage: 'plan_change_verification', product: auditProduct, source: auditSource,
          canary: isCanary, failureCode: 'apple_plan_not_confirmed',
        })
        return new Response(JSON.stringify({ error: 'Apple has not confirmed the new subscription plan.', audit_id: auditId, diagnostic_id: auditId, failure_stage: auditStage }), {
          status: 409, headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }
    }

    const purchaseToken = useAtomicSync ? verified.originalTransactionId! :
      verified.originalTransactionId ?? verified.orderId ?? `ios:${deviceId}:${productId}`
    const row: DeviceSubscriptionRow = {
      device_id: deviceId,
      product_id: productId,
      purchase_token: purchaseToken,
      subscription_state: verified.state,
      expiry_time_millis: verified.expiryTimeMillis,
      latest_order_id: verified.orderId,
      last_cycle_key: verified.cycleKey,
    }

    if (useAtomicSync) {
      const grantKey = verified.active && verified.cycleKey
        ? [verified.originalTransactionId ?? verified.orderId ?? deviceId, productId, verified.cycleKey].join(':')
        : null
      auditStage = 'atomic_subscription_and_grant'
      const { data, error } = await supabase.rpc('sync_ios_subscription_once', {
        p_device_id: deviceId,
        p_product_id: productId,
        p_purchase_token: purchaseToken,
        p_state: verified.state,
        p_expiry_time_millis: verified.expiryTimeMillis,
        p_order_id: verified.orderId,
        p_cycle_key: grantKey,
        p_amount: subscriptionCreditsForProduct(productId),
        p_metadata: {
          productId,
          orderId: verified.orderId,
          originalTransactionId: verified.originalTransactionId,
          cycleKey: verified.cycleKey,
          environment: verified.environment,
          apple_current_product_verified: appleCurrentProductVerified,
          audit_id: auditId,
        },
      })
      if (error) throw error
      const result = Array.isArray(data) ? data[0] : data
      if (!result) throw new Error('Subscription sync response was empty.')
      logSubscriptionAudit('info', auditId, 'atomic_sync_completed', {
        stage: auditStage, product: auditProduct, source: auditSource,
        environment: verified.environment, state: verified.state, active: verified.active,
        canary: isCanary, grantApplied: result.applied === true,
      })
      return new Response(JSON.stringify({
        subscription_active: verified.active,
        subscription_state: verified.state,
        subscription_expiry_time_millis: verified.expiryTimeMillis,
        subscription_environment: verified.environment,
        monthly_credit_granted: result.applied === true,
        free_credits_remaining: Number(result.free_credits_remaining),
        paid_credits_remaining: Number(result.paid_credits_remaining),
        credits_remaining: Number(result.credits_remaining),
        audit_id: auditId,
      }), { headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    auditStage = 'subscription_record_write'
    const timestamps = {
      last_verified_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

    // A StoreKit subscription keeps the same original transaction ID when the
    // user changes plans or reinstalls the app. Move that verified entitlement
    // to the current local device row instead of failing the unique-token check.
    const { data: tokenOwner, error: tokenOwnerError } = await supabase
      .from('device_subscriptions')
      .select('device_id')
      .eq('purchase_token', purchaseToken)
      .maybeSingle()
    if (tokenOwnerError) throw tokenOwnerError

    let upsertError: unknown = null
    if (tokenOwner && tokenOwner.device_id !== deviceId) {
      const { error: removeCurrentError } = await supabase
        .from('device_subscriptions')
        .delete()
        .eq('device_id', deviceId)
      if (removeCurrentError) throw removeCurrentError

      const { error } = await supabase
        .from('device_subscriptions')
        .update({ ...row, ...timestamps })
        .eq('purchase_token', purchaseToken)
      upsertError = error
    } else {
      const { error } = await supabase
        .from('device_subscriptions')
        .upsert({ ...row, ...timestamps }, { onConflict: 'device_id' })
      upsertError = error
    }
    if (upsertError) throw upsertError
    logSubscriptionAudit('info', auditId, 'subscription_record_saved', {
      stage: auditStage, product: auditProduct, source: auditSource,
      environment: verified.environment, state: verified.state, active: verified.active,
      canary: false,
    })

    let monthlyGrantApplied = false
    if (verified.active && verified.cycleKey) {
      const grantKey = [
        verified.originalTransactionId ?? verified.orderId ?? deviceId,
        productId,
        verified.cycleKey,
      ].join(':')
      auditStage = 'monthly_credit_grant'
      logSubscriptionAudit('info', auditId, 'grant_started', {
        stage: auditStage, product: auditProduct, source: auditSource,
        environment: verified.environment, state: verified.state, active: verified.active,
        canary: false,
      })
      const grant = await setMonthlySubscriptionCredits(
        supabase,
        deviceId,
        subscriptionCreditsForProduct(productId),
        grantKey,
        {
          productId,
          orderId: verified.orderId,
          originalTransactionId: verified.originalTransactionId,
          cycleKey: verified.cycleKey,
          environment: verified.environment,
          audit_id: auditId,
        }
      )
      monthlyGrantApplied = grant.applied
      logSubscriptionAudit('info', auditId, 'grant_completed', {
        stage: auditStage, product: auditProduct, source: auditSource,
        environment: verified.environment, state: verified.state, active: verified.active,
        canary: false, grantApplied: monthlyGrantApplied,
      })
    }

    auditStage = 'balance_readback'
    const credits = await getCredits(supabase, deviceId)
    logSubscriptionAudit('info', auditId, 'sync_completed', {
      stage: auditStage, product: auditProduct, source: auditSource,
      environment: verified.environment, state: verified.state, active: verified.active,
      canary: false, grantApplied: monthlyGrantApplied,
    })

    return new Response(
      JSON.stringify({
        subscription_active: verified.active,
        subscription_state: verified.state,
        subscription_expiry_time_millis: verified.expiryTimeMillis,
        subscription_environment: verified.environment,
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
    logSubscriptionAudit('error', auditId, 'sync_failed', {
      stage: auditStage, product: auditProduct, source: auditSource,
      canary: auditIsCanary, failureCode,
      walletFingerprint: auditWalletFingerprint,
    })
    const conflictStatus = subscriptionFailureHttpStatus(e)
    const safeMessage = e instanceof WalletAccessError
      ? e.message
      : conflictStatus
      ? failureCode
      : 'Subscription synchronization failed.'
    return subscriptionFailureResponse(
      safeMessage,
      auditId,
      auditStage,
      e instanceof WalletAccessError ? e.status : conflictStatus ?? 500,
      cors,
    )
  }
})
