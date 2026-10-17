import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  getCredits,
  googleSubscriptionCreditsForProduct,
  setMonthlySubscriptionCredits,
} from '../_shared/credits.ts'
import { verifySubscription } from '../_shared/google_play.ts'
import { resolveCreditWallet, WalletAccessError } from '../_shared/wallet_auth.ts'
import {
  logSubscriptionAudit,
  safeSubscriptionFailureCode,
  subscriptionFailureHttpStatus,
  subscriptionTransactionFingerprint,
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

