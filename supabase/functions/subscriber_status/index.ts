import { importPKCS8, SignJWT } from 'https://esm.sh/jose@5.6.3'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Real-time subscriber count: for every subscription we know about
// (device_subscriptions.purchase_token = originalTransactionId), ask Apple's
// App Store Server API for the CURRENT status. This reflects renewals/cancels
// even if the user never reopened the app — the accurate live number.
//
// Apple status codes: 1=Active, 2=Expired, 3=Billing Retry, 4=Grace, 5=Revoked.

const API = 'https://api.storekit.itunes.apple.com/inApps/v1/subscriptions'

async function makeJwt(): Promise<string> {
  const pem = atob(Deno.env.get('APPLE_IAP_KEY_B64')!)
  const key = await importPKCS8(pem, 'ES256')
  const now = Math.floor(Date.now() / 1000)
  return await new SignJWT({ bid: Deno.env.get('APPLE_APP_BUNDLE_ID') ?? 'com.kingboard.app' })
    .setProtectedHeader({ alg: 'ES256', kid: Deno.env.get('APPLE_IAP_KEY_ID')!, typ: 'JWT' })
    .setIssuer(Deno.env.get('APPLE_IAP_ISSUER_ID')!)
    .setIssuedAt(now)
    .setExpirationTime(now + 600)
    .setAudience('appstoreconnect-v1')
    .sign(key)
}

const STATUS_LABEL: Record<number, string> = {
  1: 'active', 2: 'expired', 3: 'billing_retry', 4: 'grace', 5: 'revoked',
}

// Monthly list price (KRW) per tier. Matched by product_id suffix so it works
// whatever bundle prefix Apple sends. These are the current App Store prices;
// the real charged amount + Apple's commission live in App Store Connect, so
// the revenue figures here are gross estimates only.
const TIER_PRICE_KRW: Record<string, number> = {
  monthly_basic: 1100,
  monthly_premium: 2200,
  monthly_pro: 6600,
}
const TIER_LABEL: Record<string, string> = {
  monthly_basic: '베이직',
  monthly_premium: '프리미엄',
  monthly_pro: '프로',
}

function tierKey(productId: string | null | undefined): string | null {
  if (!productId) return null
  for (const key of Object.keys(TIER_PRICE_KRW)) {
    if (productId.endsWith(key)) return key
  }
  return null
}

// Decode a JWS payload (middle segment) without verifying the signature. Safe
// for read-only telemetry: the JWS comes from Apple over an authenticated TLS
// call, and we only read autoRenewStatus. Not used for security decisions.
function decodeJwsPayload(jws: unknown): Record<string, unknown> | null {
  if (typeof jws !== 'string') return null
  const part = jws.split('.')[1]
  if (!part) return null
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/')
    const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : ''
    return JSON.parse(atob(b64 + pad)) as Record<string, unknown>
  } catch {
    return null
  }
}

Deno.serve(async (req) => {
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const adminToken = Deno.env.get('SUBSCRIBER_STATUS_ADMIN_TOKEN')
  const authorization = req.headers.get('Authorization')
  const authorized = (serviceKey && authorization === `Bearer ${serviceKey}`) ||
    (adminToken && authorization === `Bearer ${adminToken}`)
  if (!authorized) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )
    const { data: subs, error } = await supabase
      .from('device_subscriptions')
      .select('device_id, purchase_token, product_id')
    if (error) throw error

    // Unique originalTransactionIds (skip synthetic non-Apple tokens).
    const seen = new Set<string>()
    const ids: { otid: string; device_id: string; product_id: string | null }[] = []
    for (const s of subs ?? []) {
      const t = s.purchase_token as string | null
      if (!t || t.startsWith('ios:') || seen.has(t)) continue
      seen.add(t)
      ids.push({ otid: t, device_id: s.device_id, product_id: (s.product_id as string | null) ?? null })
    }

    const jwt = await makeJwt()
    const counts: Record<string, number> = {}
    let activeNow = 0
    let autoRenewOffNow = 0 // active now but auto-renew turned off = will churn at expiry
    let autoRenewOnNow = 0 // active now and auto-renew on = expected to renew
    let failedLookups = 0 // Apple lookups that errored or timed out (counts may be low)
    // Active subscribers grouped by tier (only status 1/4 counted).
    const activeByTier: Record<string, number> = {}
    // Subset that will actually renew (auto-renew ON) = next month's recurring base.
    const renewingByTier: Record<string, number> = {}

    // Look up subscriptions in small parallel batches with a per-call timeout so
    // the digest and alert callers get an answer quickly even as the list grows.
    const LOOKUP_CONCURRENCY = 8
    const LOOKUP_TIMEOUT_MS = 10_000
    const lookup = async ({ otid, product_id }: { otid: string; product_id: string | null }) => {
      let res: Response
      try {
        res = await fetch(`${API}/${otid}`, {
          headers: { Authorization: `Bearer ${jwt}` },
          signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
        })
      } catch {
        failedLookups++
        counts.lookup_error = (counts.lookup_error ?? 0) + 1
        return
      }
      if (res.status === 200) {
        const body = await res.json()
        const lt = body?.data?.[0]?.lastTransactions?.[0]
        const status: number | undefined = lt?.status
        const label = status != null ? (STATUS_LABEL[status] ?? `code_${status}`) : 'unknown'
        counts[label] = (counts[label] ?? 0) + 1
        if (status === 1 || status === 4) {
          activeNow++ // active or grace = has access
          // Prefer the product_id Apple reports; fall back to our stored one.
          const apiProduct = lt?.productId as string | undefined
          const key = tierKey(apiProduct ?? product_id) ?? 'unknown'
          activeByTier[key] = (activeByTier[key] ?? 0) + 1
          // autoRenewStatus: 1 = on (will renew), 0 = off (cancelled, ends at expiry).
          const renewal = decodeJwsPayload(lt?.signedRenewalInfo)
          const autoOn = renewal?.autoRenewStatus === 1
          if (autoOn) {
            autoRenewOnNow++
            renewingByTier[key] = (renewingByTier[key] ?? 0) + 1
          } else {
            autoRenewOffNow++
          }
        }
      } else {
        await res.body?.cancel()
        if (res.status >= 500 || res.status === 429) failedLookups++
        counts[`http_${res.status}`] = (counts[`http_${res.status}`] ?? 0) + 1
      }
    }
    for (let i = 0; i < ids.length; i += LOOKUP_CONCURRENCY) {
      await Promise.all(ids.slice(i, i + LOOKUP_CONCURRENCY).map(lookup))
    }

    // Current gross monthly revenue = Σ (active in tier × list price). Includes
    // auto-renew-off subscribers because they still have access this period.
    let monthlyRevenueKrw = 0
    const revenueByTier: Record<string, number> = {}
    for (const [key, n] of Object.entries(activeByTier)) {
      const price = TIER_PRICE_KRW[key] ?? 0
      const rev = price * n
      revenueByTier[key] = rev
      monthlyRevenueKrw += rev
    }
    // Next-month projected revenue = only auto-renew-ON subscribers (the ones who
    // will actually be charged again). Auto-renew-off subs drop out at expiry.
    let nextMonthRevenueKrw = 0
    for (const [key, n] of Object.entries(renewingByTier)) {
      nextMonthRevenueKrw += (TIER_PRICE_KRW[key] ?? 0) * n
    }
    // Net after Apple commission: 30% standard, 15% Small Business Program.
    const netRevenueKrw30 = Math.round(monthlyRevenueKrw * 0.7)
    const netRevenueKrw15 = Math.round(monthlyRevenueKrw * 0.85)
    const nextMonthNetKrw30 = Math.round(nextMonthRevenueKrw * 0.7)
    const nextMonthNetKrw15 = Math.round(nextMonthRevenueKrw * 0.85)

    return new Response(
      JSON.stringify(
        {
          checked: ids.length,
          active_subscribers_now: activeNow,
          auto_renew_off_now: autoRenewOffNow,
          auto_renew_on_now: autoRenewOnNow,
          failed_lookups: failedLookups,
          active_by_tier: activeByTier,
          renewing_by_tier: renewingByTier,
          revenue_by_tier_krw: revenueByTier,
          monthly_revenue_krw: monthlyRevenueKrw,
          net_revenue_krw_30: netRevenueKrw30,
          net_revenue_krw_15: netRevenueKrw15,
          next_month_revenue_krw: nextMonthRevenueKrw,
          next_month_net_krw_30: nextMonthNetKrw30,
          next_month_net_krw_15: nextMonthNetKrw15,
          by_status: counts,
          note: '애플 App Store Server API 실시간 조회 (active = status 1 or grace 4). auto_renew_off_now=현재 활성이나 자동갱신 해지(만료 시 이탈). 다음달 예상=자동갱신 ON만. 매출은 정가×인원 gross 추정, 실결제액·수수료는 ASC가 진실.',
        },
        null,
        2
      ),
      { headers: { 'Content-Type': 'application/json' } }
    )
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 })
  }
})

