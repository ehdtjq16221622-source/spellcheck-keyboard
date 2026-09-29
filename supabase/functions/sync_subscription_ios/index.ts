import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  getCredits,
  setMonthlySubscriptionCredits,
  subscriptionCreditsForProduct,
} from '../_shared/credits.ts'
import { verifyAppleSubscription } from '../_shared/apple_receipt.ts'
import { verifyAppleJWS } from '../_shared/apple_jws.ts'
import { verifyActiveApplePurchase } from '../_shared/apple_subscription_status.ts'
import { resolveCreditWallet, WalletAccessError } from '../_shared/wallet_auth.ts'

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

  try {
    const { deviceId: requestedDeviceId, productId, jwsToken, receiptData, bundleId } = await req.json()
    if (!requestedDeviceId || !productId || (!jwsToken && !receiptData)) {
      return new Response(
        JSON.stringify({ error: 'Missing required subscription fields.' }),
        { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } }
      )
    }
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )
    const canaryWallets = (Deno.env.get('IOS_SUBSCRIPTION_ATOMIC_CANARY_WALLETS') ?? '')
      .split(',').map((id) => id.trim()).filter(Boolean)
    const isCanary = canaryWallets.includes(requestedDeviceId)
    if (isCanary && ![
      'com.kingboard.app.monthly_basic',
      'com.kingboard.app.monthly_premium',
      'com.kingboard.app.monthly_pro',
    ].includes(productId)) {
      return new Response(JSON.stringify({ error: 'Unknown subscription product.' }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }
    const deviceId = isCanary
      ? (await resolveCreditWallet(req, supabase, requestedDeviceId, true)).walletId
      : requestedDeviceId

    const expectedBundleId = isCanary
      ? (Deno.env.get('APPLE_APP_BUNDLE_ID') ?? 'com.kingboard.app')
      : (Deno.env.get('APPLE_APP_BUNDLE_ID') ?? bundleId ?? 'com.kingboard.app')

    // StoreKit 2 clients send jwsToken (transaction.jwsRepresentation).
    // Older clients (or restore-purchase flows) may still send receiptData.
    let verified: Awaited<ReturnType<typeof verifyAppleSubscription>>
    if (isCanary) {
      if (!receiptData) {
        return new Response(JSON.stringify({ error: 'Apple receipt is required for this wallet.' }), {
          status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }
      verified = await verifyAppleSubscription(receiptData as string, productId, expectedBundleId)
    } else if (jwsToken) {
      try {
        const payload = await verifyAppleJWS(jwsToken as string)
        if (payload.bundleId !== expectedBundleId) {
          throw new Error('JWS bundleId does not match expected app bundle.')
        }
        if (payload.productId !== productId) {
          throw new Error('JWS productId does not match the requested product.')
        }
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
        console.warn('[sync_subscription_ios] JWS verification failed, falling back to receipt verification', jwsError)
        verified = await verifyAppleSubscription(receiptData as string, productId, expectedBundleId, false)
      }
    } else {
      verified = await verifyAppleSubscription(receiptData as string, productId, expectedBundleId, false)
    }
    if (isCanary && (!verified.originalTransactionId || verified.state === 'SUBSCRIPTION_STATE_NOT_FOUND')) {
      return new Response(JSON.stringify({ error: 'Subscription purchase was not found.' }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }

    const { data: existing, error: existingError } = await supabase
      .from('device_subscriptions')
      .select(
        'device_id, product_id, purchase_token, subscription_state, expiry_time_millis, latest_order_id, last_cycle_key'
      )
      .eq('device_id', deviceId)
      .maybeSingle()

    if (existingError) throw existingError

    let appleCurrentProductVerified = false
    if (isCanary && existing?.product_id && existing.product_id !== productId) {
      if (!verified.active || !verified.originalTransactionId) {
        return new Response(JSON.stringify({ error: 'The new subscription plan is not active.' }), {
          status: 409, headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }
      appleCurrentProductVerified = await verifyActiveApplePurchase(
        verified.originalTransactionId, productId, expectedBundleId,
      )
      if (!appleCurrentProductVerified) {
        return new Response(JSON.stringify({ error: 'Apple has not confirmed the new subscription plan.' }), {
          status: 409, headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }
    }

    const purchaseToken = isCanary ? verified.originalTransactionId! :
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

    if (isCanary) {
      const grantKey = verified.active && verified.cycleKey
        ? [verified.originalTransactionId ?? verified.orderId ?? deviceId, productId, verified.cycleKey].join(':')
        : null
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
        },
      })
      if (error) throw error
      const result = Array.isArray(data) ? data[0] : data
      if (!result) throw new Error('Subscription sync response was empty.')
      return new Response(JSON.stringify({
        subscription_active: verified.active,
        subscription_state: verified.state,
        subscription_expiry_time_millis: verified.expiryTimeMillis,
        subscription_environment: verified.environment,
        monthly_credit_granted: result.applied === true,
        free_credits_remaining: Number(result.free_credits_remaining),
        paid_credits_remaining: Number(result.paid_credits_remaining),
        credits_remaining: Number(result.credits_remaining),
      }), { headers: { ...cors, 'Content-Type': 'application/json' } })
    }

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

    let monthlyGrantApplied = false
    if (verified.active && verified.cycleKey) {
      const grantKey = [
        verified.originalTransactionId ?? verified.orderId ?? deviceId,
        productId,
        verified.cycleKey,
      ].join(':')
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
        }
      )
      monthlyGrantApplied = grant.applied
    }

    const credits = await getCredits(supabase, deviceId)

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
      }),
      { headers: { ...cors, 'Content-Type': 'application/json' } }
    )
  } catch (e) {
    console.error('[sync_subscription_ios]', e)
    const message = e instanceof Error ? e.message : JSON.stringify(e)
    return new Response(
      JSON.stringify({ error: message }),
      { status: e instanceof WalletAccessError ? e.status : 500, headers: { ...cors, 'Content-Type': 'application/json' } }
    )
  }
})
