import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  getCredits,
  setMonthlySubscriptionCredits,
  subscriptionCreditsForProduct,
} from '../_shared/credits.ts'
import { verifyAppleSubscription } from '../_shared/apple_receipt.ts'
import { verifyAppleJWS } from '../_shared/apple_jws.ts'

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
    const { deviceId, productId, jwsToken, receiptData, bundleId } = await req.json()
    if (!deviceId || !productId || (!jwsToken && !receiptData)) {
      return new Response(
        JSON.stringify({ error: 'Missing required subscription fields.' }),
        { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } }
      )
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const expectedBundleId =
      Deno.env.get('APPLE_APP_BUNDLE_ID') ??
      bundleId ??
      'com.kingboard.app'

    // StoreKit 2 clients send jwsToken (transaction.jwsRepresentation).
    // Older clients (or restore-purchase flows) may still send receiptData.
    let verified: Awaited<ReturnType<typeof verifyAppleSubscription>>
    if (jwsToken) {
      try {
        const payload = await verifyAppleJWS(jwsToken as string)
        if (payload.bundleId !== expectedBundleId) {
          throw new Error('JWS bundleId does not match expected app bundle.')
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
        verified = await verifyAppleSubscription(receiptData as string, productId, expectedBundleId)
      }
    } else {
      verified = await verifyAppleSubscription(receiptData as string, productId, expectedBundleId)
    }

    const { data: existing, error: existingError } = await supabase
      .from('device_subscriptions')
      .select(
        'device_id, product_id, purchase_token, subscription_state, expiry_time_millis, latest_order_id, last_cycle_key'
      )
      .eq('device_id', deviceId)
      .maybeSingle()

    if (existingError) throw existingError

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

    const row: DeviceSubscriptionRow = {
      device_id: deviceId,
      product_id: productId,
      purchase_token:
        verified.originalTransactionId ??
        verified.orderId ??
        `ios:${deviceId}:${productId}`,
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
    return new Response(
      JSON.stringify({ error: String(e) }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } }
    )
  }
})
