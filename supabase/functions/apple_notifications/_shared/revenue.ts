// Revenue lines for Telegram alerts. Each purchase, renewal or refund is recorded once in
// public.revenue_events with the price the store reported; the alert shows that amount and this
// KST month's Production total per currency. Recording is best-effort and never throws.

export type RevenueEvent = {
  store: 'app_store' | 'google_play'
  environment: string
  category: 'subscription' | 'credit_pack' | 'lifetime'
  kind: 'purchase' | 'refund' | 'refund_reversal'
  productId: string
  transactionId: string
  amountMilli: number // always positive; the database stores refunds as negative
  currency: string
  occurredAtMs: number
  source: string
}

export type RevenueResult = { inserted: boolean; monthTotals: Record<string, number>; since: string | null }

// Apple reports `price` in milliunits of `currency` (₩7,000 = 7000000).
export function appleRevenueAmount(tx: Record<string, unknown>): { amountMilli: number; currency: string } | null {
  const price = tx.price
  const currency = tx.currency
  if (typeof price !== 'number' || !Number.isSafeInteger(price) || price < 0) return null
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return null
  return { amountMilli: price, currency }
}

// deno-lint-ignore no-explicit-any
export async function recordRevenue(supabase: any, event: RevenueEvent): Promise<RevenueResult | null> {
  try {
    const { data, error } = await supabase.rpc('record_revenue_event', {
      p_store: event.store,
      p_environment: event.environment,
      p_category: event.category,
      p_kind: event.kind,
      p_product_id: event.productId,
      p_transaction_id: event.transactionId,
      p_amount_milli: event.amountMilli,
      p_currency: event.currency,
      p_occurred_at: new Date(event.occurredAtMs).toISOString(),
      p_source: event.source,
    })
    if (error) throw error
    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null
    if (!row || typeof row.inserted !== 'boolean') throw new Error('revenue_result_unknown')
    const totals: Record<string, number> = {}
    for (const [currency, value] of Object.entries((row.month_totals ?? {}) as Record<string, unknown>)) {
      if (Number.isFinite(Number(value))) totals[currency] = Number(value)
    }
    return { inserted: row.inserted, monthTotals: totals, since: typeof row.since === 'string' ? row.since : null }
  } catch (error) {
    console.error(JSON.stringify({ category: 'revenue_record', result: 'failed', kind: event.kind,
      source: event.source, message: String((error as { message?: unknown })?.message ?? error).slice(0, 120) }))
    return null
  }
}

export function formatMoney(amountMilli: number, currency: string): string {
  const value = amountMilli / 1000
  try {
    return new Intl.NumberFormat('ko-KR', { style: 'currency', currency }).format(value)
  } catch {
    return `${currency} ${value.toLocaleString('ko-KR')}`
  }
}

// "- 매출 -₩7,000 · 이번 달 총 매출 ₩1,234,000 + US$9.98 (11/21부터 집계)"
export function revenueLine(
  kind: RevenueEvent['kind'], amountMilli: number, currency: string, environment: string,
  result: RevenueResult | null, nowMs = Date.now(),
): string {
  const amount = `${kind === 'refund' ? '-' : ''}${formatMoney(amountMilli, currency)}`
  if (environment !== 'Production') return `- 매출 ${amount} (시험 결제 · 합계 제외)`
  if (!result) return `- 매출 ${amount}`
  const entries = Object.entries(result.monthTotals)
    .sort(([a], [b]) => (a === 'KRW' ? -1 : b === 'KRW' ? 1 : a.localeCompare(b)))
  const total = entries.length ? entries.map(([c, v]) => formatMoney(v, c)).join(' + ') : formatMoney(0, 'KRW')
  const kst = new Date(nowMs + 9 * 3600_000)
  const monthStartMs = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), 1) - 9 * 3600_000
  let since = ''
  const sinceMs = result.since ? Date.parse(result.since) : NaN
  if (Number.isFinite(sinceMs) && sinceMs > monthStartMs) {
    const s = new Date(sinceMs + 9 * 3600_000)
    since = ` (${s.getUTCMonth() + 1}/${s.getUTCDate()}부터 집계)`
  }
  return `- 매출 ${amount} · 이번 달 총 매출 ${total}${since}`
}
