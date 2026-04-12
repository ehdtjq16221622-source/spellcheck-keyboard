import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  MONTHLY_SUBSCRIPTION_CREDITS,
  getCredits,
  setMonthlySubscriptionCredits,
} from '../_shared/credits.ts'
import { verifySubscription } from '../_shared/google_play.ts'

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
    const { deviceId, productId, purchaseToken, packageName } = await req.json()
    if (!deviceId || !productId || !purchaseToken) {
      return new Response(
        JSON.stringify({ error: 'Missing required subscription fields.' }),
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

    const verified = await verifySubscription(expectedPackageName, productId, purchaseToken)

    if (
      verified.obfuscatedAccountId &&
      verified.obfuscatedAccountId !== deviceId
    ) {
      return new Response(
        JSON.stringify({ error: 'Subscription belongs to a different device.' }),
        { status: 403, headers: { ...cors, 'Content-Type': 'application/json' } }
      )
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
    const previousCycle = (existing as DeviceSubscriptionRow | null)?.last_cycle_key ?? null
    if (verified.active && verified.cycleKey && previousCycle !== verified.cycleKey) {
      await setMonthlySubscriptionCredits(supabase, deviceId, MONTHLY_SUBSCRIPTION_CREDITS)
      monthlyGrantApplied = true
    }

    const row: DeviceSubscriptionRow = {
      device_id: deviceId,
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

    const credits = await getCredits(supabase, deviceId)

    return new Response(
      JSON.stringify({
        subscription_active: verified.active,
        subscription_state: verified.state,
        subscription_expiry_time_millis: verified.expiryTimeMillis,
        monthly_credit_granted: monthlyGrantApplied,
        free_credits_remaining: credits.freeCredits,
        paid_credits_remaining: credits.paidCredits,
        credits_remaining: credits.remaining,
      }),
      { headers: { ...cors, 'Content-Type': 'application/json' } }
    )
  } catch (e) {
    return new Response(
      JSON.stringify({ error: String(e) }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } }
    )
  }
})
