import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { applyUsageEventOnce, getCredits } from './_shared/credits.ts'
import { resolveCreditWallet, WalletAccessError } from './_shared/wallet_auth.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

type UsageEvent = {
  id?: string
  freeDeducted?: number
  paidDeducted?: number
  kind?: string
  createdAt?: number
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const { deviceId, events } = await req.json()
    if (!deviceId) {
      return json({ error: 'deviceId is required.' }, 400)
    }

    const usageEvents = Array.isArray(events) ? (events as UsageEvent[]) : []

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )
    const wallet = await resolveCreditWallet(req, supabase, deviceId)

    for (const event of usageEvents) {
      const id = typeof event.id === 'string' ? event.id.trim() : ''
      if (!id) continue

      await applyUsageEventOnce(
        supabase,
        wallet.walletId,
        id,
        Number(event.freeDeducted ?? 0),
        Number(event.paidDeducted ?? 0),
        {
          kind: event.kind ?? 'unknown',
          createdAt: event.createdAt ?? null,
        }
      )
    }

    const credits = await getCredits(supabase, wallet.walletId)
    return json({
      free_credits_remaining: credits.freeCredits,
      paid_credits_remaining: credits.paidCredits,
      credits_remaining: credits.remaining,
    })
  } catch (e) {
    console.error('[sync_credit_usage]', e)
    return json({ error: e instanceof WalletAccessError ? e.message : 'Failed to sync pending credit usage.' },
      e instanceof WalletAccessError ? e.status : 500)
  }
})

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      'Content-Type': 'application/json',
    },
  })
}

