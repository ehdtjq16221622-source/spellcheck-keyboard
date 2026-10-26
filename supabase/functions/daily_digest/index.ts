import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { sendTelegram } from '../_shared/telegram.ts'
import { readSubscriptionActivity, subscriptionActivityText } from '../_shared/subscription_audit.ts'
import { subscriptionStatusText } from '../_shared/subscription_reporting.ts'

// Daily usage digest, sent to Telegram at 12:00 KST for the *previous* full
// calendar day (Asia/Seoul). Reports only metrics Supabase measures accurately
// (installs, AI usage, AI cost estimate). Subscriber/revenue/ad-revenue truth
// lives in App Store Connect / AdMob, so those lines are marked "참고" only.

const KST_MS = 9 * 60 * 60 * 1000

// AI usage is logged as server_ai_usage (current) and client_usage_sync
// (legacy, being phased out). Count both so older app versions aren't dropped.
const AI_TYPES = ['server_ai_usage', 'client_usage_sync']

// Returns the UTC instant range for yesterday's full KST calendar day,
// plus a "M/D" label for that day.
function yesterdayKstRange(now = new Date()) {
  const kstNow = new Date(now.getTime() + KST_MS)
  const y = kstNow.getUTCFullYear()
  const m = kstNow.getUTCMonth()
  const d = kstNow.getUTCDate()
  const todayStartUtc = new Date(Date.UTC(y, m, d, 0, 0, 0) - KST_MS)
  const startUtc = new Date(todayStartUtc.getTime() - 24 * 60 * 60 * 1000)
  const yk = new Date(startUtc.getTime() + KST_MS)
  const yLabel = `${yk.getUTCMonth() + 1}/${yk.getUTCDate()}`
  return { startUtc, endUtc: todayStartUtc, yLabel }
}

// Today so far: KST midnight today -> now (for on-demand /요약).
function todayKstRange(now = new Date()) {
  const kstNow = new Date(now.getTime() + KST_MS)
  const y = kstNow.getUTCFullYear()
  const m = kstNow.getUTCMonth()
  const d = kstNow.getUTCDate()
  const startUtc = new Date(Date.UTC(y, m, d, 0, 0, 0) - KST_MS)
  const yLabel = `${m + 1}/${d} 오늘 ${kstNow.getUTCHours()}시까지`
  return { startUtc, endUtc: now, yLabel }
}

Deno.serve(async (req: Request) => {
  // Optional lock: if CRON_SECRET is set, require a matching header so the
  // endpoint can't be triggered by strangers.
  const cronSecret = Deno.env.get('CRON_SECRET')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const internal = serviceKey && req.headers.get('Authorization') === `Bearer ${serviceKey}`
  if (cronSecret && req.headers.get('x-cron-secret') !== cronSecret && !internal) {
    return new Response('unauthorized', { status: 401 })
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const params = new URL(req.url).searchParams
    const isToday = params.get('range') === 'today'
    const { startUtc, endUtc, yLabel } = isToday ? todayKstRange() : yesterdayKstRange()
    const title = isToday ? '실시간 요약' : '일일 요약'

    // /구독 (telegram_bot view=subscriptions): subscriber block only, no usage scan.
    if (params.get('view') === 'subscriptions') {
      const sub = await buildSubscriptionBlock(supabase)
      const kn = new Date(Date.now() + KST_MS)
      const msg =
        `💳 <b>킹보드 구독 현황</b> (${kn.getUTCMonth() + 1}/${kn.getUTCDate()} ${kn.getUTCHours()}:${String(kn.getUTCMinutes()).padStart(2, '0')})\n` +
        `━━━━━━━━━━━━━━\n` +
        sub.text +
        `━━━━━━━━━━━━━━\n` +
        `※ 애플 실시간 조회 기준`
      const deliveryKey = req.headers.get('x-report-idempotency-key')
      const sent = await sendTelegram(msg, deliveryKey ? {
        supabase, alertType: 'subscription_status_report', idempotencyKey: deliveryKey.slice(0, 128),
      } : undefined)
      return new Response(
        JSON.stringify({ ok: true, sent, view: 'subscriptions', activeSubs: sub.active, subDelta: sub.delta }),
        { headers: { 'Content-Type': 'application/json' } }
      )
    }
    const startIso = startUtc.toISOString()
    const endIso = endUtc.toISOString()

    // Row counts via head+exact (not capped by the 1000-row page limit).
    const countInRange = async (
      table: string,
      txTypes?: string[]
    ): Promise<number> => {
      let q = supabase
        .from(table)
        .select('*', { count: 'exact', head: true })
        .gte('created_at', startIso)
        .lt('created_at', endIso)
      if (txTypes) q = q.in('transaction_type', txTypes)
      const { count, error } = await q
      if (error) throw error
      return count ?? 0
    }

    const [newInstalls, aiCalls, ssvCount, newSubs, referralJoins] = await Promise.all([
      countInRange('device_credits'),
      countInRange('credit_transactions', AI_TYPES),
      countInRange('credit_transactions', ['admob_ssv']),
      countInRange('credit_transactions', ['subscription_monthly_grant']),
      countInRange('credit_transactions', ['referral_invitee_reward']),
    ])

    // Distinct AI users: page through device_ids so days with >1000 AI calls
    // aren't truncated by PostgREST's default row cap.
    const seen = new Set<string>()
    let creditsConsumed = 0
    const PAGE = 1000
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('credit_transactions')
        .select('device_id, free_delta, paid_delta')
        .in('transaction_type', AI_TYPES)
        .gte('created_at', startIso)
        .lt('created_at', endIso)
        .range(from, from + PAGE - 1)
      if (error) throw error
      if (!data || data.length === 0) break
      for (const r of data) {
        seen.add(r.device_id as string)
        creditsConsumed += Math.abs((r.free_delta ?? 0) + (r.paid_delta ?? 0))
      }
      if (data.length < PAGE) break
    }
    const aiUsers = seen.size

    // Cost = credits consumed × cost-per-credit. Calibrated against real billing:
    // 9/1–16 API bill ₩6,849 ÷ 118,820 credits consumed ≈ ₩0.058 per credit.
    // Tracks the actual usage mix (교정 10 / 번역 20 / 말투 30 credits per use).
    const krwPerCredit = Number(Deno.env.get('AI_COST_PER_CREDIT_KRW') ?? '0.058')
    const estCostKrw = Math.round(creditsConsumed * krwPerCredit)

    // Real-time active subscribers (Apple App Store Server API). A failed lookup
    // is shown as a visible line instead of silently dropping the section.
    const sub = await buildSubscriptionBlock(supabase)
    const subLine = sub.text
    const activeSubs = sub.active
    const subDelta = sub.delta
    let subscriptionActivity = null
    let subscriptionActivityLine = '구독 처리 집계 실패 · 실패 0건으로 해석하지 마세요.\n'
    try {
      subscriptionActivity = await readSubscriptionActivity(supabase, startIso, endIso)
      subscriptionActivityLine = subscriptionActivityText(subscriptionActivity)
    } catch {
      console.error('[daily_digest] subscription activity counts unavailable')
    }

    const msg =
      `📊 <b>킹보드 ${title}</b> (${yLabel})\n` +
      `━━━━━━━━━━━━━━\n` +
      `🆕 신규 설치: <b>${newInstalls}</b>\n` +
      `🎁 초대 유입: <b>${referralJoins}</b>명\n` +
      `🤖 AI 사용자: <b>${aiUsers}</b>명\n` +
      `✍️ AI 호출: <b>${aiCalls}</b>회\n` +
      `💰 예상 AI 비용: <b>₩${estCostKrw.toLocaleString('ko-KR')}</b> <i>(추정)</i>\n` +
      `📺 광고 시청: ${ssvCount}회 <i>(서버 기준·참고)</i>\n` +
      subLine +
      subscriptionActivityLine +
      `━━━━━━━━━━━━━━\n` +
      `※ 구독자는 애플 실시간 조회 · 광고 수익은 AdMob 확인`

    const sent = await sendTelegram(msg)

    return new Response(
      JSON.stringify({
        ok: true,
        sent,
        day: yLabel,
        newInstalls,
        referralJoins,
        aiUsers,
        aiCalls,
        creditsConsumed,
        estCostKrw,
        ssvCount,
        newSubs,
        activeSubs,
        subDelta,
        subscriptionActivity,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    )
  } catch (e) {
    console.error('[daily_digest]', e)
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})

// Builds the subscriber section from subscriber_status (Apple live lookup) with
// an up/down delta vs the previous day's snapshot. Never throws: a failed
// lookup returns a visible failure line so a missing section is never silent.
// deno-lint-ignore no-explicit-any
async function buildSubscriptionBlock(supabase: any): Promise<{
  text: string
  active: number | null
  delta: number | null
}> {
  const failed = (reason: string) => ({
    text: `💳 구독자 조회 실패 <i>(${reason}) · /구독 으로 재시도</i>\n`,
    active: null,
    delta: null,
  })
  try {
    const r = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/subscriber_status?include_history=1`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}` },
      signal: AbortSignal.timeout(90_000),
    })
    if (!r.ok) {
      await r.body?.cancel()
      return failed(`HTTP ${r.status}`)
    }
    const j = await r.json()
    const active = j.active_subscribers_now
    if (typeof active !== 'number') return failed('응답 형식 오류')

    const kn = new Date(Date.now() + KST_MS)
    const todayStr = `${kn.getUTCFullYear()}-${String(kn.getUTCMonth() + 1).padStart(2, '0')}-${String(kn.getUTCDate()).padStart(2, '0')}`
    const { data: prev } = await supabase
      .from('admin_daily_snapshot')
      .select('active_subscribers')
      .lt('day', todayStr)
      .order('day', { ascending: false })
      .limit(1)
      .maybeSingle()
    const delta = prev ? active - (prev.active_subscribers ?? 0) : null
    const dStr =
      delta == null ? '' : delta > 0 ? ` (🔺+${delta})` : delta < 0 ? ` (🔻${delta})` : ' (±0)'
    let text = `💳 현재 구독자: <b>${active}</b>명${dStr}\n`

    // Tier breakdown (from Apple-live active count).
    const TIER_ORDER = ['monthly_pro', 'monthly_premium', 'monthly_basic']
    const TIER_NAME: Record<string, string> = {
      monthly_pro: '프로', monthly_premium: '프리미엄', monthly_basic: '베이직',
    }
    const byTier = (j.active_by_tier ?? {}) as Record<string, number>
    const tierParts = TIER_ORDER
      .filter((k) => (byTier[k] ?? 0) > 0)
      .map((k) => `${TIER_NAME[k]} ${byTier[k]}`)
    if (byTier.unknown) tierParts.push(`기타 ${byTier.unknown}`)
    if (tierParts.length) text += `　┗ ${tierParts.join(' · ')}\n`

    text += subscriptionStatusText(j, true)

    const gross = j.monthly_revenue_krw
    const net15 = j.net_revenue_krw_15
    if (typeof gross === 'number' && gross > 0) {
      const netStr = typeof net15 === 'number' ? ` (실수령 ~₩${net15.toLocaleString('ko-KR')})` : ''
      text += `💰 월 구독 매출: <b>₩${gross.toLocaleString('ko-KR')}</b>${netStr} <i>(정가 추정)</i>\n`
    }
    const nextGross = j.next_month_revenue_krw
    const nextNet15 = j.next_month_net_krw_15
    if (typeof nextGross === 'number') {
      const nStr = typeof nextNet15 === 'number' ? ` (실수령 ~₩${nextNet15.toLocaleString('ko-KR')})` : ''
      text += `📉 다음달 예상 매출: <b>₩${nextGross.toLocaleString('ko-KR')}</b>${nStr} <i>(자동갱신 ON만)</i>\n`
    }
    if (j.revenue_is_partial) text += '※ 상품·갱신 상태 미확인분이 있어 매출 추정은 일부만 반영됐습니다.\n'

    if (!j.failed_lookups) await supabase
      .from('admin_daily_snapshot')
      .upsert({ day: todayStr, active_subscribers: active }, { onConflict: 'day' })

    return { text, active, delta }
  } catch (e) {
    console.error('[daily_digest] subscriber lookup failed', e)
    return failed(e instanceof DOMException && e.name === 'TimeoutError' ? '시간 초과' : '오류')
  }
}
