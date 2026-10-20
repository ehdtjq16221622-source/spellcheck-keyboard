import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  getCredits,
  setMonthlySubscriptionCredits,
  subscriptionCreditsForProduct,
} from './_shared/credits.ts'
import { verifyAppleSubscription } from './_shared/apple_receipt.ts'
import {
  verifyAppleSubscriptionRecordWithReason,
  verifyAppleTransactionJws,
} from './_shared/apple_subscription_status.ts'
import { resolveCreditWallet, WalletAccessError } from './_shared/wallet_auth.ts'
import {
  logSubscriptionAudit as writeSubscriptionAudit,
  safeSubscriptionFailureCode,
  subscriptionFailureHttpStatus,
  subscriptionWalletFingerprint,
} from './_shared/subscription_audit.ts'
import { deferDiagnostic, reportFailure, summarizeFailure } from './_shared/subscription_alerts.ts'

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
  const events: Record<string, unknown>[] = []
  const logSubscriptionAudit: typeof writeSubscriptionAudit = (level, id, event, fields) => {
    writeSubscriptionAudit(level, id, event, fields)
    events.push({ ...fields, auditId: id, event })
  }
  let auditStage = 'parse_request'
  let auditProduct: 'basic' | 'premium' | 'pro' | 'other' = 'other'
  let auditSource: 'storekit_jws' | 'app_receipt' | 'unknown' = 'unknown'
  let auditIsCanary = false
  let auditWalletFingerprint: string | undefined
  let auditRequestedWalletId: string | undefined
  let auditResolvedWalletId: string | undefined
  let auditVerifiedGrantKey: string | undefined
  let auditDetail: Record<string, unknown> | undefined
  let auditClientDiag: unknown
  let auditSyncOrigin: string | undefined
  try {
    const { deviceId: requestedDeviceId, productId, jwsToken, receiptData, bundleId, clientDiag, syncOrigin } = await req.json()
    if (typeof clientDiag === 'string') {
      const text = clientDiag.slice(0, 1500)
      try { auditClientDiag = JSON.parse(text) } catch { auditClientDiag = text }
    }
    auditSyncOrigin = typeof syncOrigin === 'string' ? syncOrigin.slice(0, 30) : undefined
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
    auditRequestedWalletId = String(requestedDeviceId).slice(0, 200)
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
    auditResolvedWalletId = wallet.walletId
    const useAtomicSync = isCanary || (atomicAllUsersRequested && wallet.authenticated)
    if (wallet.authenticated) events.push({ event: 'wallet_authenticated' })
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
        {
          const p = payload as unknown as Record<string, unknown>
          const num = (key: string) => (typeof p[key] === 'number' ? p[key] : null)
          const text = (key: string) => (typeof p[key] === 'string' ? String(p[key]).slice(0, 40) : null)
          auditDetail = {
            serverNowMs: Date.now(),
            expiresDateMs: num('expiresDate'),
            purchaseDateMs: num('purchaseDate'),
            originalPurchaseDateMs: num('originalPurchaseDate'),
            signedDateMs: num('signedDate'),
            transactionId: text('transactionId'),
            originalTransactionId: text('originalTransactionId'),
            transactionReason: text('transactionReason'),
            type: text('type'),
            isUpgraded: typeof p.isUpgraded === 'boolean' ? p.isUpgraded : null,
            productId: text('productId'),
          }
        }
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
    auditDetail = {
      ...(auditDetail ?? {}),
      serverNowMs: Date.now(),
      verifiedState: verified.state ?? null,
      verifiedActive: verified.active ?? null,
      verifiedExpiryMs: typeof verified.expiryTimeMillis === 'number' ? verified.expiryTimeMillis : null,
      verifiedOrderId: verified.orderId != null ? String(verified.orderId).slice(0, 40) : null,
      verifiedOriginalTransactionId: verified.originalTransactionId != null ? String(verified.originalTransactionId).slice(0, 40) : null,
      hasReceipt: Boolean(receiptData),
      hasJws: Boolean(jwsToken),
    }
    if (useAtomicSync && (!verified.originalTransactionId || verified.state === 'SUBSCRIPTION_STATE_NOT_FOUND')) {
      logSubscriptionAudit('warn', auditId, 'verification_rejected', {
        stage: 'apple_verification', product: auditProduct, source: auditSource,
        canary: isCanary, state: verified.state, active: verified.active,
        environment: verified.environment,
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
    auditVerifiedGrantKey = verified.active && verified.cycleKey
      ? [verified.originalTransactionId ?? verified.orderId ?? deviceId, productId, verified.cycleKey].join(':')
      : undefined

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
        return new Response(JSON.stringify({ error: 'stale_subscription_transaction', audit_id: auditId, diagnostic_id: auditId, failure_stage: auditStage }), {
          status: 409, headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }
      // Apple can take a few seconds to show the new plan after a change; look again a few times
      // before giving up. Only "still the previous plan" style answers are retried.
      let appleCheck = await verifyAppleSubscriptionRecordWithReason(
        verified.originalTransactionId, productId, expectedBundleId, true,
      )
      for (const waitMs of [1500, 3000]) {
        if (appleCheck.verified || !['signed_transaction_mismatch', 'subscription_not_found'].includes(appleCheck.reason)) break
        await new Promise((resolve) => setTimeout(resolve, waitMs))
        appleCheck = await verifyAppleSubscriptionRecordWithReason(
          verified.originalTransactionId, productId, expectedBundleId, true,
        )
      }
      appleCurrentProductVerified = appleCheck.verified
      if (!appleCurrentProductVerified) {
        logSubscriptionAudit('warn', auditId, 'rejected', {
          stage: 'plan_change_verification', product: auditProduct, source: auditSource,
          canary: isCanary, failureCode: `apple_plan_not_confirmed:${appleCheck.reason}`,
        })
        return new Response(JSON.stringify({ error: 'subscription_plan_change_unverified', audit_id: auditId, diagnostic_id: auditId, failure_stage: auditStage }), {
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
          // Stored with the existing atomic grant, never a separate success write.
          subscription_audit: {
            version: 1,
            event: appleCurrentProductVerified ? 'plan_change_applied' : 'subscription_grant',
            previous_product_id: existing?.product_id ?? null,
            product_id: productId,
            environment: verified.environment,
          },
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
  } finally {
    if (events.some(e => ['rejected', 'verification_rejected', 'sync_failed'].includes(String(e.event)))) {
      deferDiagnostic(async () => {
        const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
        let failureRecorded = false
        try {
          const failure = summarizeFailure(events)
          if (failure) {
            const saved = await db.from('subscription_sync_failures').insert({
              audit_id: failure.auditId,
              environment: failure.environment,
              stage: failure.stage,
              failure_code: String(failure.code).slice(0, 200),
              product: auditProduct,
              source: auditSource,
              wallet_fingerprint: auditWalletFingerprint ?? null,
              requested_wallet_id: auditRequestedWalletId ?? null,
              resolved_wallet_id: auditResolvedWalletId ?? null,
              detail: {
                ...(auditDetail ?? {}),
                syncOrigin: auditSyncOrigin ?? null,
                client: auditClientDiag ?? null,
                events: events.map((e) => `${e.event}${e.failureCode ? ':' + e.failureCode : ''}`).slice(0, 20),
              },
            })
            if (saved.error) throw new Error('subscription_failure_record_failed')
            failureRecorded = true
          }
        } catch {
          console.error(JSON.stringify({ category: 'subscription_alert', event: 'failure_record_failed' }))
        }
        await reportFailure(db, events, failureRecorded,
          auditResolvedWalletId && auditVerifiedGrantKey
            ? { walletId: auditResolvedWalletId, grantKey: auditVerifiedGrantKey } : undefined)
      })
    }
  }
})


