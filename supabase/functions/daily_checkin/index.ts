import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { DAILY_FREE } from '../_shared/credits.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function todayInKst(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const { deviceId, statusOnly } = await req.json()
    if (!deviceId || typeof deviceId !== 'string') {
      return new Response(JSON.stringify({ error: '기기 정보를 확인할 수 없습니다.' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } })
    }
    const isStatusOnly = statusOnly === true

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const today = todayInKst()

    // 기존 크레딧 행 조회
    const { data, error } = await supabase
      .from('device_credits')
      .select('device_id, free_credits, paid_credits, last_reset_date')
      .eq('device_id', deviceId)
      .maybeSingle()

    if (error) throw error

    if (isStatusOnly) {
      const freeCredits = data?.free_credits ?? 0
      const paidCredits = data?.paid_credits ?? 0
      return new Response(JSON.stringify({
        already_checked_in: data?.last_reset_date === today,
        free_credits_remaining: freeCredits,
        paid_credits_remaining: paidCredits,
        credits_remaining: freeCredits + paidCredits,
      }), { headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    // 이미 오늘 출석했는지 확인
    if (data && data.last_reset_date === today) {
      return new Response(JSON.stringify({
        already_checked_in: true,
        free_credits_remaining: data.free_credits,
        paid_credits_remaining: data.paid_credits,
        credits_remaining: data.free_credits + data.paid_credits,
      }), { headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    // 출석 처리 — free_credits 지급 및 날짜 갱신
    if (!data) {
      await supabase.from('device_credits').insert({
        device_id: deviceId,
        free_credits: DAILY_FREE,
        paid_credits: 0,
        last_reset_date: today,
      })
    } else {
      await supabase.from('device_credits').update({
        free_credits: data.free_credits + DAILY_FREE,
        last_reset_date: today,
        updated_at: new Date().toISOString(),
      }).eq('device_id', deviceId)
    }

    const newFree = (data?.free_credits ?? 0) + DAILY_FREE
    const newPaid = data?.paid_credits ?? 0

    return new Response(JSON.stringify({
      already_checked_in: false,
      awarded_credits: DAILY_FREE,
      free_credits_remaining: newFree,
      paid_credits_remaining: newPaid,
      credits_remaining: newFree + newPaid,
    }), { headers: { ...cors, 'Content-Type': 'application/json' } })

  } catch (e) {
    console.error('[daily_checkin]', e)
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
})
