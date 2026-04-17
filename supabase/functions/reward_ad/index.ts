import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  REWARDED_AD_CREDITS,
  addPaidCredits,
  persistRewardAdClaim,
  recordRewardAdClaim,
} from '../_shared/credits.ts'
import {
  UserFacingError,
  enforceRateLimit,
  requireTextDeviceId,
} from '../_shared/usage_guard.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const { deviceId } = await req.json()
    const normalizedDeviceId = requireTextDeviceId(deviceId)

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    const rateLimit = await enforceRateLimit(supabase, 'reward_ad', normalizedDeviceId, 8, 60_000)
    if (!rateLimit.allowed) {
      return new Response(
        JSON.stringify({
          error: 'RATE_LIMITED',
          message: '잠시 후 다시 시도해 주세요.',
          reset_at: rateLimit.resetAt,
        }),
        { status: 429, headers: { ...cors, 'Content-Type': 'application/json' } },
      )
    }

    const rewardCheck = await recordRewardAdClaim(supabase, normalizedDeviceId)
    if (!rewardCheck.allowed) {
      const message =
        rewardCheck.reason === 'cooldown'
          ? '광고 보상은 잠시 후 다시 받을 수 있어요.'
          : '오늘은 광고 보상을 모두 받았어요.'

      return new Response(
        JSON.stringify({
          error: rewardCheck.reason === 'cooldown' ? 'COOLDOWN_ACTIVE' : 'DAILY_LIMIT_REACHED',
          message,
          retry_after_seconds: rewardCheck.retryAfterSeconds ?? null,
        }),
        { status: 429, headers: { ...cors, 'Content-Type': 'application/json' } },
      )
    }

    const credits = await addPaidCredits(supabase, normalizedDeviceId, REWARDED_AD_CREDITS)
    await persistRewardAdClaim(supabase, normalizedDeviceId, REWARDED_AD_CREDITS)

    return new Response(
      JSON.stringify({
        free_credits_remaining: credits.freeCredits,
        paid_credits_remaining: credits.paidCredits,
        credits_remaining: credits.remaining,
      }),
      { headers: { ...cors, 'Content-Type': 'application/json' } },
    )
  } catch (e) {
    if (e instanceof UserFacingError) {
      return new Response(
        JSON.stringify({ error: e.message }),
        { status: e.status, headers: { ...cors, 'Content-Type': 'application/json' } },
      )
    }

    return new Response(
      JSON.stringify({ error: String(e) }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } },
    )
  }
})
