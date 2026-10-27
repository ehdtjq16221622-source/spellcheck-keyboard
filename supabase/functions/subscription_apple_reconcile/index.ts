import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { importPKCS8, SignJWT } from 'https://esm.sh/jose@5.6.3'
import { fingerprint, sendIncident } from './_shared/subscription_alerts.ts'

// Comparison never changes subscriptions or wallets. Alerts are disabled until separately approved.
// summary_only never sends or writes, including on errors. No self-test send endpoint.
// Payloads come directly from Apple's authenticated TLS API and are decoded only for monitoring,
// never to authorize purchases or grant/revoke credits. Purchase paths retain their JWS verifiers.
const BUNDLE_ID = 'com.kingboard.app'
const PAGE = 1000
const BUDGET_MS = 110_000

type AppleState = {
  environment: 'Production' | 'Sandbox'
  status: number
  product: string
  expiresMs: number
  revoked: boolean
}
type Lookup = AppleState | { error: string }

function decodePayload(jws: string): Record<string, unknown> | null {
  try {
    const parts = jws.split('.')
    if (parts.length !== 3) return null
    const part = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const bytes = Uint8Array.from(atob(part.padEnd(Math.ceil(part.length / 4) * 4, '=')), c => c.charCodeAt(0))
    const value = JSON.parse(new TextDecoder().decode(bytes))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch { return null }
}

async function appleJwt(): Promise<string> {
  const encoded = Deno.env.get('APPLE_IAP_KEY_B64')
  const kid = Deno.env.get('APPLE_IAP_KEY_ID')
  const issuer = Deno.env.get('APPLE_IAP_ISSUER_ID')
  if (!encoded || !kid || !issuer) throw new Error('apple_credentials_missing')
  const key = await importPKCS8(atob(encoded), 'ES256')
  const now = Math.floor(Date.now() / 1000)
  return await new SignJWT({ bid: BUNDLE_ID })
    .setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' }).setIssuer(issuer)
    .setIssuedAt(now).setExpirationTime(now + 600).setAudience('appstoreconnect-v1').sign(key)
}

async function lookup(jwt: string, originalTransactionId: string, deadline: number): Promise<Lookup> {
  if (!/^\d{1,40}$/.test(originalTransactionId)) return { error: 'invalid_transaction_id' }
  for (const base of ['https://api.storekit.apple.com', 'https://api.storekit-sandbox.apple.com']) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return { error: 'timeout' }
    const response = await fetch(`${base}/inApps/v1/subscriptions/${originalTransactionId}`, {
      headers: { Authorization: `Bearer ${jwt}` }, signal: AbortSignal.timeout(Math.min(20_000, remaining)),
    })
    if (response.status === 404 && !base.includes('sandbox')) {
      const error = await response.json().catch(() => null)
      if (error?.errorCode === 4040010) continue
      return { error: 'not_found' }
    }
    if (!response.ok) { await response.body?.cancel(); return { error: `http_${response.status}` } }
    const body = await response.json()
    if (body.bundleId !== BUNDLE_ID || !Array.isArray(body.data)) return { error: 'invalid_response' }
    const environment = base.includes('sandbox') ? 'Sandbox' : 'Production'
    const candidates: Array<{ state: AppleState; signedDate: number }> = []
    for (const group of body.data) {
      if (!Array.isArray(group.lastTransactions)) return { error: 'invalid_response' }
      for (const item of group.lastTransactions) {
        if (item.originalTransactionId !== originalTransactionId) continue
        const payload = decodePayload(String(item.signedTransactionInfo ?? ''))
        if (!payload || payload.bundleId !== BUNDLE_ID || payload.originalTransactionId !== originalTransactionId ||
            payload.environment !== environment || typeof payload.productId !== 'string' || !payload.productId ||
            typeof payload.expiresDate !== 'number' || !Number.isFinite(payload.expiresDate) ||
            typeof payload.signedDate !== 'number' || !Number.isFinite(payload.signedDate) ||
            ![1, 2, 3, 4, 5].includes(item.status)) return { error: 'invalid_transaction' }
        candidates.push({ signedDate: payload.signedDate, state: {
          environment, status: item.status, product: payload.productId,
          expiresMs: payload.expiresDate, revoked: payload.revocationDate != null,
        } })
      }
    }
    if (!candidates.length) return { error: 'transaction_not_in_response' }
    candidates.sort((a, b) => b.signedDate - a.signedDate)
    if (candidates.length > 1 && candidates[0].signedDate === candidates[1].signedDate &&
        JSON.stringify(candidates[0].state) !== JSON.stringify(candidates[1].state)) return { error: 'ambiguous_transaction' }
    return candidates[0].state
  }
  return { error: 'not_found' }
}

Deno.serve(async (req: Request) => {
  const matches = (name: string, value: string | null) => {
    const secret = Deno.env.get(name)
    return Boolean(secret && value === secret)
  }
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const serviceAuth = Boolean(serviceKey && req.headers.get('Authorization') === `Bearer ${serviceKey}`)
  if (!serviceAuth && !matches('ADMIN_API_TOKEN', req.headers.get('x-admin-token')) &&
      !matches('SUBSCRIPTION_RECONCILE_SECRET', req.headers.get('x-monitor-secret'))) {
    return new Response('Unauthorized', { status: 401 })
  }
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  let body: { summary_only?: boolean }
  try {
    body = await req.json()
    if (!body || Array.isArray(body) || typeof body !== 'object' ||
        Object.keys(body).some(key => key !== 'summary_only') ||
        (body.summary_only !== undefined && typeof body.summary_only !== 'boolean')) throw new Error('invalid_request')
  } catch { return Response.json({ error: 'invalid_request' }, { status: 400 }) }
  if (!serviceKey || !Deno.env.get('SUPABASE_URL')) return Response.json({ error: 'server_configuration_missing', counts: null }, { status: 503 })
  const db = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey)
  const day = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10)
  const alertsEnabled = body.summary_only !== true && Deno.env.get('SUBSCRIPTION_RECONCILE_ALERTS_ENABLED') === 'true'
  const summary = { active: 0, checked: 0, sandbox: 0, notChecked: 0, lookupFailures: 0,
    planMismatch: 0, refundedButActive: 0, inactiveButActive: 0, gracePeriod: 0, expiryMismatch: 0 }
  const failureReasons: Record<string, number> = {}
  let stage = 'subscription_query'
  try {
    const deadline = Date.now() + BUDGET_MS
    let jwt: string | null = null
    let cursor: string | null = null
    for (;;) {
      stage = 'subscription_query'
      let query = db.from('device_subscriptions')
        .select('device_id,product_id,purchase_token,expiry_time_millis', { count: 'exact' })
        .eq('subscription_state', 'SUBSCRIPTION_STATE_ACTIVE')
        .like('product_id', 'com.kingboard.app.monthly\\_%').order('device_id').limit(PAGE)
      // Stale active rows, including locally expired/null-expiry rows, must be checked.
      if (cursor !== null) query = query.gt('device_id', cursor)
      const { data: rows, count, error } = await query.abortSignal(AbortSignal.timeout(Math.max(1, Math.min(10_000, deadline - Date.now()))))
      if (error || !Array.isArray(rows) || typeof count !== 'number') throw new Error('subscription_query_failed')
      const pageRows = rows
      if (cursor === null) summary.active = count
      if (!rows.length) break
      if (!jwt) { stage = 'apple_credentials'; jwt = await appleJwt() }
      stage = 'apple_lookup'
      let index = 0
      async function worker() {
        while (index < pageRows.length && Date.now() < deadline) {
          const row = pageRows[index++]
          const result = await lookup(jwt!, String(row.purchase_token ?? ''), deadline).catch(() => ({ error: 'lookup_exception' }))
          summary.checked += 1
          if ('error' in result) {
            summary.lookupFailures += 1
            failureReasons[result.error] = (failureReasons[result.error] ?? 0) + 1
            continue
          }
          if (result.environment === 'Sandbox') { summary.sandbox += 1; continue }
          if (result.revoked || result.status === 5) summary.refundedButActive += 1
          else if (result.status === 2 || result.status === 3 || (result.status === 1 && result.expiresMs <= Date.now())) summary.inactiveButActive += 1
          else if (result.status === 4) summary.gracePeriod += 1
          if (result.status === 1 && !result.revoked && result.expiresMs > Date.now() && result.product !== row.product_id) summary.planMismatch += 1
          if (Number(row.expiry_time_millis) !== result.expiresMs) summary.expiryMismatch += 1
        }
      }
      await Promise.all(Array.from({ length: 8 }, worker))
      if (index < rows.length || Date.now() >= deadline) break
      cursor = rows[rows.length - 1].device_id
      if (rows.length < PAGE) break
    }
    summary.notChecked = Math.max(0, summary.active - summary.checked)
    const complete = summary.notChecked === 0 && summary.lookupFailures === 0
    const problems = summary.planMismatch + summary.refundedButActive + summary.inactiveButActive + summary.expiryMismatch
    const needsAlert = problems > 0 || !complete
    let delivered = false
    if (alertsEnabled && needsAlert) {
      stage = 'alert_delivery'
      // Only the counts that are not zero; the reason codes stay for diagnosis.
      const reasons = Object.entries(failureReasons).map(([reason, count]) => `${reason} ${count}`).join(', ')
      const issues: Array<[number, string]> = [
        [summary.planMismatch, '플랜 불일치'],
        [summary.refundedButActive, '환불됐는데 서버는 구독 중'],
        [summary.inactiveButActive, '만료됐는데 서버는 구독 중'],
        [summary.expiryMismatch, '만료일 불일치'],
        [summary.lookupFailures, `애플 조회 실패${reasons ? ` (${reasons})` : ''}`],
        [summary.notChecked, '시간 부족으로 확인 못 함'],
      ]
      const message = [
        '⚠️ 애플 구독 대조 · 확인 필요', `- ${day} · 확인 ${summary.checked}/${summary.active}건`,
        ...issues.filter(([count]) => count > 0).map(([count, label]) => `- ${label} ${count}건`),
        '- 자동으로 바꾼 건 없음 · Codex에 확인 요청',
      ].join('\n')
      const sortedReasons = Object.fromEntries(Object.entries(failureReasons).sort(([a], [b]) => a.localeCompare(b)))
      const key = await fingerprint(`reconcile:${day}:${JSON.stringify(summary)}:${JSON.stringify(sortedReasons)}`)
      delivered = await sendIncident(db, key, message)
    }
    return Response.json({ ...summary, failureReasons, complete, problems, needsAlert,
      summary_only: body.summary_only === true, alertsEnabled, delivered }, { status: complete ? 200 : 503 })
  } catch {
    // Never echo exceptions: network/library errors can contain credentials or transaction IDs.
    if (alertsEnabled) {
      try { await sendIncident(db, `reconcile-failed:${day}`, '⚠️ 애플 구독 대조 실패\n- 오늘 대조 결과 없음 · Codex에 확인 요청') }
      catch { /* The HTTP failure remains visible even if delivery fails. */ }
    }
    return Response.json({ error: { code: 'reconciliation_failed', stage }, counts: null, complete: false, alertsEnabled }, { status: 503 })
  }
})
