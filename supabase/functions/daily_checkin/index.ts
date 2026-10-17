import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { resolveCreditWallet, WalletAccessError } from './_shared/wallet_auth.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const { deviceId, statusOnly } = await req.json()
    if (!deviceId || typeof deviceId !== 'string') {
      return new Response(JSON.stringify({ error: '기기 정보를 확인할 수 없습니다.' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )
    const wallet = await resolveCreditWallet(req, supabase, deviceId)
    const walletId = wallet.walletId

    const { data, error } = await supabase
      .from('device_credits')
      .select('device_id, free_credits, paid_credits, subscription_credits, last_reset_date')
      .eq('device_id', walletId)
      .maybeSingle()

    if (error) throw error

    // 기존 디바이스 — 현재 크레딧만 반환
    if (data) {
      return new Response(JSON.stringify({
        already_checked_in: true,
        awarded_credits: 0,
        free_credits_remaining: data.free_credits,
        paid_credits_remaining: data.paid_credits + data.subscription_credits,
        credits_remaining: data.free_credits + data.paid_credits + data.subscription_credits,
      }), { headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    // This endpoint is a balance/status lookup for existing wallets only.
    // A caller-supplied ID is not proof of a first install, so only the
    // DeviceCheck-backed V2 registration flow may create a bonus wallet.
    return new Response(JSON.stringify({
      error: '새 지갑은 앱을 최신 버전으로 업데이트한 뒤 등록해 주세요.',
      code: 'WALLET_REGISTRATION_REQUIRED',
    }), { status: 409, headers: { ...cors, 'Content-Type': 'application/json' } })

  } catch (e) {
    console.error('[daily_checkin]', e)
    return new Response(JSON.stringify({ error: String(e) }), { status: e instanceof WalletAccessError ? e.status : 500, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
})

