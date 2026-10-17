// Service health monitor (pg_cron every 5 minutes) → Telegram.
// 1) Slow spelling corrections (>10s, logged by `correct` into ai_slow_requests)
// 2) Guest wallet activation failures during signup spikes (pending wallets)
// Each alert type fires at most once per 30-minute bucket.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { sendTelegram } from '../_shared/telegram.ts'

const WINDOW_MIN = 5
const SLOW_ALERT_MIN_COUNT = 3
const WALLET_WINDOW_START_MIN = 15 // wallets created 15..5 minutes ago
const WALLET_WINDOW_END_MIN = 5 // gives the app time to activate
const WALLET_ALERT_MIN_PENDING = 5
const WALLET_ALERT_MIN_RATE = 0.03
const DEDUP_BUCKET_MS = 30 * 60_000

Deno.serve(async (req) => {
  const secret = Deno.env.get('SERVICE_MONITOR_SECRET')
  if (!secret || req.headers.get('x-monitor-secret') !== secret) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
  }
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )
  const now = Date.now()
  const bucket = Math.floor(now / DEDUP_BUCKET_MS)
  const iso = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString()
  const report: Record<string, unknown> = {}

  // 1) Slow spelling corrections.
  try {
    const { data: slow, error } = await supabase
      .from('ai_slow_requests')
      .select('duration_ms, outcome')
      .eq('kind', 'correct')
      .gte('created_at', iso(WINDOW_MIN))
    if (error) throw error
    const { count: total } = await supabase
      .from('credit_transactions')
      .select('*', { count: 'exact', head: true })
      .eq('transaction_type', 'server_ai_usage')
      .eq('metadata->>kind', 'correct')
      .gte('created_at', iso(WINDOW_MIN))
    const n = slow?.length ?? 0
    report.slow = n
    if (n >= SLOW_ALERT_MIN_COUNT) {
      const maxSec = Math.round(Math.max(...slow!.map((r) => r.duration_ms)) / 1000)
      const failed = slow!.filter((r) => r.outcome === 'error').length
      const totalStr = typeof total === 'number' && total > 0
        ? ` / 전체 ${total}건 (${Math.round((n / total) * 100)}%)` : ''
      await sendTelegram(
        `🐢 <b>맞춤법 교정 지연</b>\n` +
          `최근 ${WINDOW_MIN}분 10초 초과: <b>${n}건</b>${totalStr}\n` +
          `최대 ${maxSec}초${failed ? ` · 그중 실패 ${failed}건` : ''}\n` +
          `<i>Gemini 응답 지연 가능성 · 30분 동안 같은 알림은 묶습니다</i>`,
        { supabase, alertType: 'service_monitor_slow_correct', idempotencyKey: `b${bucket}` },
      )
    }
  } catch (e) {
    console.error('[service_monitor] slow check failed', String(e).slice(0, 120))
  }

  // 2) Guest wallets stuck in pending (signup spike / DeviceCheck lock).
  try {
    const base = () => supabase
      .from('wallet_v2_credentials')
      .select('wallet_id', { count: 'exact', head: true })
      .gte('created_at', iso(WALLET_WINDOW_START_MIN))
      .lt('created_at', iso(WALLET_WINDOW_END_MIN))
    const [{ count: total, error: e1 }, { count: pending, error: e2 }] = await Promise.all([
      base(),
      base().eq('state', 'pending'),
    ])
    if (e1 || e2) throw e1 ?? e2
    const t = total ?? 0
    const p = pending ?? 0
    report.wallets = { total: t, pending: p }
    if (p >= WALLET_ALERT_MIN_PENDING && t > 0 && p / t >= WALLET_ALERT_MIN_RATE) {
      await sendTelegram(
        `🚨 <b>신규 가입 지갑 활성화 실패 증가</b>\n` +
          `최근 10분 가입 ${t}건 중 활성화 안 됨 <b>${p}건</b> (${Math.round((p / t) * 100)}%)\n` +
          `<i>가입 폭주 시 기기 확인 대기 가능성 · 30분 동안 같은 알림은 묶습니다</i>`,
        { supabase, alertType: 'service_monitor_wallet_pending', idempotencyKey: `b${bucket}` },
      )
    }
  } catch (e) {
    console.error('[service_monitor] wallet check failed', String(e).slice(0, 120))
  }

  // Keep the slow log small.
  await supabase.from('ai_slow_requests').delete().lt('created_at', iso(7 * 24 * 60))

  return new Response(JSON.stringify({ ok: true, ...report }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
