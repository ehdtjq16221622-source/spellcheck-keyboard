import { importPKCS8, SignJWT } from 'https://esm.sh/jose@5.6.3'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { buildRenewalOutcomes, decodeApplePayload, groupSubscriptionPeople, latestPersonSubscription,
  renewalState, selectAppleSubscription, subscriptionTier, type SubscriptionObservation } from '../_shared/subscription_reporting.ts'

const API = 'https://api.storekit.apple.com/inApps'
const PRICES: Record<string, number> = { monthly_basic: 1100, monthly_premium: 2200, monthly_pro: 6600 }

async function makeJwt(): Promise<string> {
  const key = await importPKCS8(atob(Deno.env.get('APPLE_IAP_KEY_B64')!), 'ES256')
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ bid: Deno.env.get('APPLE_APP_BUNDLE_ID') ?? 'com.kingboard.app' })
    .setProtectedHeader({ alg: 'ES256', kid: Deno.env.get('APPLE_IAP_KEY_ID')!, typ: 'JWT' })
    .setIssuer(Deno.env.get('APPLE_IAP_ISSUER_ID')!).setIssuedAt(now).setExpirationTime(now + 600)
    .setAudience('appstoreconnect-v1').sign(key)
}

async function readAll(db: any, table: string, columns: string, transactionType?: string) {
  const rows: any[] = []
  for (let from = 0; ; from += 1000) {
    let query = db.from(table).select(columns)
    if (transactionType) query = query.eq('transaction_type', transactionType)
    const { data, error } = await query.order(columns.split(',')[0]).range(from, from + 999)
    if (error || !Array.isArray(data)) throw new Error('reporting_database_read_failed')
    rows.push(...data)
    if (data.length < 1000) return rows
  }
}

Deno.serve(async (req: Request) => {
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const adminToken = Deno.env.get('SUBSCRIBER_STATUS_ADMIN_TOKEN')
  const auth = req.headers.get('Authorization')
  if (!(serviceKey && auth === `Bearer ${serviceKey}`) && !(adminToken && auth === `Bearer ${adminToken}`)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const includeHistory = new URL(req.url).searchParams.get('include_history') === '1'
    const now = Date.now(), deadline = now + 75_000
    const db = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey!)
    const subs = await readAll(db, 'device_subscriptions', 'device_id,purchase_token,product_id')
    const grants = await readAll(db, 'credit_transactions', 'id,metadata', 'subscription_monthly_grant')
    const environments = new Map<string, Set<string>>()
    for (const grant of grants) {
      const meta = grant.metadata
      if (typeof meta?.originalTransactionId !== 'string') continue
      if (!environments.has(meta.originalTransactionId)) environments.set(meta.originalTransactionId, new Set())
      environments.get(meta.originalTransactionId)!.add(meta.environment)
    }
    const seen = new Set<string>()
    const ids = subs.filter(s => s.purchase_token && !s.purchase_token.startsWith('ios:') &&
      !(environments.get(s.purchase_token)?.has('Sandbox') && !environments.get(s.purchase_token)?.has('Production')) &&
      !seen.has(s.purchase_token) && seen.add(s.purchase_token))
    const observations: SubscriptionObservation[] = ids.map(s => ({ chain: s.purchase_token,
      owner: `wallet:${s.device_id}`, current: null, history: [], historyComplete: false, lookupFailed: false }))
    let identityComplete = true
    if (includeHistory) {
      try {
        const aliases = await readAll(db, 'credit_wallet_aliases', 'source_wallet_id,canonical_wallet_id')
        const aliasMap = new Map(aliases.map(a => [a.source_wallet_id, a.canonical_wallet_id]))
        const wallets = [...new Set([...ids.map(s => s.device_id), ...aliases.map(a => a.canonical_wallet_id)])] as string[]
        const accounts = new Map<string, string>()
        for (let from = 0; from < wallets.length; from += 100) {
          const { data, error } = await db.from('device_credits').select('device_id,apple_user_id')
            .in('device_id', wallets.slice(from, from + 100))
          if (error || !Array.isArray(data)) throw new Error('identity_read_failed')
          for (const row of data) if (row.apple_user_id) accounts.set(row.device_id, row.apple_user_id)
        }
        ids.forEach((s, i) => {
          let wallet = s.device_id
          const visited = new Set<string>()
          while (aliasMap.has(wallet) && !visited.has(wallet)) { visited.add(wallet); wallet = aliasMap.get(wallet) as string }
          observations[i].owner = accounts.has(wallet) ? `account:${accounts.get(wallet)}` : `wallet:${wallet}`
        })
      } catch { identityComplete = false }
    }
    const jwt = await makeJwt()
    const counts: Record<string, number> = {}
    const apple = async (url: string) => {
      if (Date.now() >= deadline) throw new Error('report_deadline')
      return fetch(url, { headers: { Authorization: `Bearer ${jwt}` },
        signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, deadline - Date.now()))) })
    }
    const batch = async (fn: (row: SubscriptionObservation) => Promise<void>) => {
      for (let i = 0; i < observations.length; i += 8) await Promise.all(observations.slice(i, i + 8).map(fn))
    }
    await batch(async row => {
      try {
        const res = await apple(`${API}/v1/subscriptions/${encodeURIComponent(row.chain)}`)
        if (!res.ok) { await res.body?.cancel(); throw new Error(`http_${res.status}`) }
        const body = await res.json()
        if (body.environment === 'Sandbox') { counts.sandbox = (counts.sandbox ?? 0) + 1; return }
        row.current = selectAppleSubscription(body, row.chain)
        if (!row.current || ![1, 2, 3, 4, 5].includes(row.current.status)) throw new Error('unknown_status')
      } catch { row.lookupFailed = true }
    })
    if (includeHistory) await batch(async row => {
      if (row.lookupFailed || !row.current) return
      try {
        const revisions = new Set<string>()
        let revision: string | null = null
        for (let page = 0; page < 25; page++) {
          const url = new URL(`${API}/v2/history/${encodeURIComponent(row.chain)}`)
          url.searchParams.set('productType', 'AUTO_RENEWABLE')
          url.searchParams.set('sort', 'ASCENDING')
          if (revision) url.searchParams.set('revision', revision)
          const res = await apple(url.href)
          if (!res.ok) { await res.body?.cancel(); throw new Error('history_http_error') }
          const body = await res.json()
          if (body.environment !== 'Production' || !Array.isArray(body.signedTransactions) || typeof body.hasMore !== 'boolean') {
            throw new Error('history_bad_response')
          }
          for (const signed of body.signedTransactions) {
            const tx = decodeApplePayload(signed)
            if (!tx) throw new Error('history_decode_failed')
            if (subscriptionTier(tx.productId) && tx.environment === 'Production') {
              if (typeof tx.transactionId !== 'string' || typeof tx.originalTransactionId !== 'string' ||
                  typeof tx.purchaseDate !== 'number' || typeof tx.expiresDate !== 'number') throw new Error('history_missing_fields')
              row.history.push(tx)
            }
          }
          if (!body.hasMore) { row.historyComplete = true; break }
          if (typeof body.revision !== 'string' || revisions.has(body.revision)) throw new Error('history_bad_revision')
          const nextRevision: string = body.revision
          revision = nextRevision; revisions.add(nextRevision)
        }
      } catch { row.historyComplete = false }
    })
    const people = groupSubscriptionPeople(observations)
    let active = 0, on = 0, off = 0, unknown = 0, pendingChanges = 0
    const byTier: Record<string, number> = {}, renewing: Record<string, number> = {}
    for (const person of people) {
      const current = latestPersonSubscription(person)
      if (!current) continue
      const label = ({ 1: 'active', 2: 'expired', 3: 'billing_retry', 4: 'grace', 5: 'revoked' } as Record<number, string>)[current.status]
      counts[label] = (counts[label] ?? 0) + 1
      if (current.status !== 1 && current.status !== 4) continue
      active++
      const key = subscriptionTier(current.transaction?.productId) ?? 'unknown'
      byTier[key] = (byTier[key] ?? 0) + 1
      const state = renewalState(current.renewal)
      if (state === 'on') {
        on++
        const nextKey = subscriptionTier(current.renewal?.autoRenewProductId) ?? 'unknown'
        renewing[nextKey] = (renewing[nextKey] ?? 0) + 1
        if (nextKey !== 'unknown' && key !== 'unknown' && nextKey !== key) pendingChanges++
      } else if (state === 'off') off++
      else unknown++
    }
    const failed = observations.filter(row => row.lookupFailed).length
    const revenue = Object.fromEntries(Object.entries(byTier).map(([k, n]) => [k, (PRICES[k] ?? 0) * n]))
    const gross = Object.values(revenue).reduce((a, b) => a + b, 0)
    const nextGross = Object.entries(renewing).reduce((s, [k, n]) => s + (PRICES[k] ?? 0) * n, 0)
    return Response.json({ checked: ids.length, checked_people: people.length, active_subscribers_now: active,
      auto_renew_on_now: on, auto_renew_off_now: off, auto_renew_unknown_now: unknown,
      pending_plan_changes_now: pendingChanges, failed_lookups: failed,
      active_by_tier: byTier, renewing_by_tier: renewing, revenue_by_tier_krw: revenue,
      monthly_revenue_krw: gross, net_revenue_krw_30: Math.round(gross * .7), net_revenue_krw_15: Math.round(gross * .85),
      next_month_revenue_krw: nextGross, next_month_net_krw_30: Math.round(nextGross * .7), next_month_net_krw_15: Math.round(nextGross * .85),
      revenue_is_partial: Boolean(byTier.unknown || renewing.unknown || unknown || failed),
      by_status: counts, identity_linking_complete: identityComplete,
      renewal_outcomes: includeHistory && identityComplete ? buildRenewalOutcomes(people, now) : null,
      note: '자동갱신 중단 예정과 실제 만료·재구독은 별도 집계합니다. 금액은 정가 추정이며 실제 결제액은 App Store Connect 기준입니다.',
    })
  } catch { return Response.json({ error: 'subscriber_status_failed' }, { status: 500 }) }
})
