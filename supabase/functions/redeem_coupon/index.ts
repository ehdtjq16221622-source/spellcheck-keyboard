import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { addPaidCredits, redeemCouponOnce } from '../_shared/credits.ts'
import {
  enforceRateLimit,
  requireNonEmptyText,
  requireTextDeviceId,
} from '../_shared/usage_guard.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const TEST_COUPONS: Record<string, number> = {
  KINGBOARDTEST5000: 5000,
  KINGBOARDTEST10000: 10000,
}

function normalizeCouponCode(code: string): string {
  return code.trim().toUpperCase().replace(/[\s-]+/g, '')
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const { deviceId, couponCode } = await req.json()
    const normalizedDeviceId = requireTextDeviceId(deviceId)
    const rawCouponCode = requireNonEmptyText(couponCode, '쿠폰 번호')
    const normalizedCode = normalizeCouponCode(rawCouponCode)
    const awardedCredits = TEST_COUPONS[normalizedCode]

    if (!awardedCredits) {
      return new Response(
        JSON.stringify({ ok: false, error: '유효하지 않은 쿠폰입니다.' }),
        { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } },
      )
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    const rateLimit = await enforceRateLimit(supabase, 'redeem_coupon', normalizedDeviceId, 6, 60_000)
    if (!rateLimit.allowed) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.',
          reset_at: rateLimit.resetAt,
        }),
        { status: 429, headers: { ...cors, 'Content-Type': 'application/json' } },
      )
    }

    const couponCheck = await redeemCouponOnce(
      supabase,
      normalizedDeviceId,
      normalizedCode,
      awardedCredits,
    )
    if (!couponCheck.allowed) {
      return new Response(
        JSON.stringify({ ok: false, error: '이미 사용한 쿠폰입니다.' }),
        { status: 409, headers: { ...cors, 'Content-Type': 'application/json' } },
      )
    }

    const credits = await addPaidCredits(supabase, normalizedDeviceId, awardedCredits)

    return new Response(
      JSON.stringify({
        ok: true,
        message: `쿠폰 적용 완료 · 크레딧 +${awardedCredits}`,
        awarded_credits: awardedCredits,
        free_credits_remaining: credits.freeCredits,
        paid_credits_remaining: credits.paidCredits,
        credits_remaining: credits.remaining,
      }),
      { headers: { ...cors, 'Content-Type': 'application/json' } },
    )
  } catch (e) {
    const message =
      e instanceof Error ? e.message
      : (e && typeof e === 'object') ? JSON.stringify(e)
      : String(e)
    return new Response(
      JSON.stringify({ ok: false, error: message }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } },
    )
  }
})
