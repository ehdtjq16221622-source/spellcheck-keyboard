import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { REWARDED_AD_CREDITS, addPaidCreditsOnce } from '../_shared/credits.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const { deviceId, rewardEventId } = await req.json()
    if (!deviceId || typeof deviceId !== 'string') {
      return new Response(
        JSON.stringify({ error: 'Missing deviceId.' }),
        { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } }
      )
    }
    if (!rewardEventId || typeof rewardEventId !== 'string') {
      return new Response(
        JSON.stringify({ error: 'Missing rewardEventId.' }),
        { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } }
      )
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const grant = await addPaidCreditsOnce(
      supabase,
      deviceId,
      REWARDED_AD_CREDITS,
      'reward_ad',
      rewardEventId,
      { rewardEventId }
    )
    const credits = grant.snapshot

    return new Response(
      JSON.stringify({
        reward_applied: grant.applied,
        awarded_credits: grant.applied ? REWARDED_AD_CREDITS : 0,
        free_credits_remaining: credits.freeCredits,
        paid_credits_remaining: credits.paidCredits,
        credits_remaining: credits.remaining,
      }),
      { headers: { ...cors, 'Content-Type': 'application/json' } }
    )
  } catch (e) {
    console.error('[reward_ad]', e)
    return new Response(
      JSON.stringify({ error: String(e) }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } }
    )
  }
})
