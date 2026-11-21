// Service health monitor (pg_cron every 5 minutes) → Telegram.
// 1) Slow spelling corrections (>10s, logged by `correct` into ai_slow_requests)
// 2) Guest wallet activation failures during signup spikes (pending wallets)
// 3) Database storage before the disk fills and the project turns read-only
// Each alert type fires at most once per 30-minute bucket (storage warnings: 6 hours).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { sendTelegram } from '../_shared/telegram.ts'

const WINDOW_MIN = 5
const SLOW_ALERT_MIN_COUNT = 3
const WALLET_WINDOW_START_MIN = 15 // wallets created 15..5 minutes ago
const WALLET_WINDOW_END_MIN = 5 // gives the app time to activate
const WALLET_ALERT_MIN_PENDING = 5
const WALLET_ALERT_MIN_RATE = 0.03
const DEDUP_BUCKET_MS = 30 * 60_000
const GB = 1024 ** 3
// Supabase disk size; change this if the disk is expanded. Read-only began near 92% (database size excludes WAL).
const DISK_BYTES = 8 * GB
const DB_WARN_BYTES = 5 * GB
const DB_CRITICAL_BYTES = 6.5 * GB
const HTTP_RESPONSE_WARN_BYTES = 300 * 1024 ** 2 // pg_net raw responses; normally a few rows
const STORAGE_WARN_BUCKET_MS = 6 * 60 * 60_000

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
          `- 최근 ${WINDOW_MIN}분 10초 초과: <b>${n}건</b>${totalStr}\n` +
          `- 최대 ${maxSec}초${failed ? ` · 그중 실패 ${failed}건` : ''}\n` +
          `- Gemini 응답 지연 가능성 · 30분간 같은 알림은 묶음`,
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
          `- 최근 10분 가입 ${t}건 중 활성화 안 됨 <b>${p}건</b> (${Math.round((p / t) * 100)}%)\n` +
          `- 가입 폭주 시 기기 확인 대기 가능성 · 30분간 같은 알림은 묶음`,
        { supabase, alertType: 'service_monitor_wallet_pending', idempotencyKey: `b${bucket}` },
      )
    }
  } catch (e) {
    console.error('[service_monitor] wallet check failed', String(e).slice(0, 120))
  }

  // 3) Database storage.
  try {
    const { data, error } = await supabase.rpc('service_monitor_storage')
    if (error) throw error
    const row = (Array.isArray(data) ? data[0] : data) ?? {}
    const dbBytes = Number(row.database_bytes)
    const httpBytes = Number(row.http_response_bytes)
    if (!Number.isFinite(dbBytes) || !Number.isFinite(httpBytes)) throw new Error('storage_unavailable')
    report.storage = { dbBytes, httpBytes }
    const critical = dbBytes >= DB_CRITICAL_BYTES
    if (critical || dbBytes >= DB_WARN_BYTES || httpBytes >= HTTP_RESPONSE_WARN_BYTES) {
      const gb = (n: number) => (n / GB).toFixed(2)
      const level = critical ? 'critical' : 'warn'
      const storageBucket = critical ? bucket : Math.floor(now / STORAGE_WARN_BUCKET_MS)
      await sendTelegram(
        `${critical ? '🚨' : '💾'} <b>DB 저장공간 ${critical ? '위험' : '경고'}</b>\n` +
          `- DB <b>${gb(dbBytes)}GB</b> / 디스크 ${gb(DISK_BYTES)}GB (${Math.round((dbBytes / DISK_BYTES) * 100)}%)\n` +
          `- 외부 호출 응답 보관함 ${gb(httpBytes)}GB\n` +
          `- 디스크가 차면 DB가 읽기 전용이 돼요 · ${critical ? '30분' : '6시간'}간 같은 알림은 묶음`,
        { supabase, alertType: 'service_monitor_storage', idempotencyKey: `${level}:b${storageBucket}` },
      )
    }
  } catch (e) {
    console.error('[service_monitor] storage check failed', String(e).slice(0, 120))
  }

  // Keep the slow log small.
  await supabase.from('ai_slow_requests').delete().lt('created_at', iso(7 * 24 * 60))

  return new Response(JSON.stringify({ ok: true, ...report }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
