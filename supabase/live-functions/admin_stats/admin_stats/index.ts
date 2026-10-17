import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Read-only aggregate stats + single-device lookup / balance history.
// POST {} -> global stats.
// POST {deviceId} -> that device's recent activity.
// POST {deviceId, history:true, priorGrant?} -> 14-day daily balance (reconstructed
//   backward from current balance; priorGrant subtracts a manual top-up that is
//   not recorded as a transaction so the historical trend stays accurate).
// verify_jwt is false; keep it read-only.

const KST_MS = 9 * 60 * 60 * 1000
function kstDay(iso: string): string {
  const d = new Date(new Date(iso).getTime() + KST_MS)
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`
}

// Admin only: callers send the ADMIN_API_TOKEN secret in the x-admin-token header.
async function isAdmin(req: Request): Promise<boolean> {
  const expected = Deno.env.get('ADMIN_API_TOKEN') ?? ''
  const provided = req.headers.get('x-admin-token') ?? ''
  if (expected.length < 32 || provided.length === 0) return false
  const digest = async (value: string) =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  const [a, b] = await Promise.all([digest(expected), digest(provided)])
  let difference = 0
  for (let i = 0; i < a.length; i += 1) difference |= a[i] ^ b[i]
  return difference === 0
}

Deno.serve(async (req) => {
  if (!(await isAdmin(req))) {
    return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    let body: any = {}
    try { body = await req.json() } catch (_) { /* no body */ }
    const deviceId: string | undefined = body?.deviceId

    if (deviceId) {
      const { data: cred } = await supabase
        .from('device_credits')
        .select('free_credits, paid_credits, subscription_credits, updated_at, created_at')
        .eq('device_id', deviceId)
        .maybeSingle()

      const currentTotal =
        (cred?.free_credits ?? 0) + (cred?.paid_credits ?? 0) + (cred?.subscription_credits ?? 0)

      // Last 21 days of transactions, newest first.
      const since = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString()
      const { data: txns } = await supabase
        .from('credit_transactions')
        .select('transaction_type, created_at, free_delta, paid_delta')
        .eq('device_id', deviceId)
        .gte('created_at', since)
        .order('created_at', { ascending: false })

      if (body?.history) {
        // Reconstruct balance-after-each-transaction, backward from the anchor.
        const priorGrant = Number(body?.priorGrant ?? 0)
        let bal = currentTotal - priorGrant // balance right after the newest real transaction
        const endOfDay: Record<string, number> = {}
        const usedPerDay: Record<string, number> = {}
        for (const t of txns ?? []) {
          const day = kstDay(t.created_at)
          // first time we see a day (newest tx of that day) = end-of-day balance
          if (!(day in endOfDay)) endOfDay[day] = bal
          const delta = (t.free_delta ?? 0) + (t.paid_delta ?? 0)
          if (delta < 0) usedPerDay[day] = (usedPerDay[day] ?? 0) + (-delta)
          bal = bal - delta // step to balance before this transaction
        }
        // Build a 14-day ordered table (oldest -> newest).
        const rows: { day: string; end_balance: number | null; used: number }[] = []
        let carry: number | null = null
        for (let i = 13; i >= 0; i--) {
          const d = new Date(Date.now() + KST_MS - i * 24 * 60 * 60 * 1000)
          const label = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`
          if (label in endOfDay) carry = endOfDay[label]
          rows.push({ day: label, end_balance: carry, used: usedPerDay[label] ?? 0 })
        }
        return new Response(
          JSON.stringify({ deviceId, current_total: currentTotal, priorGrant, daily: rows }, null, 2),
          { headers: { 'Content-Type': 'application/json' } }
        )
      }

      const aiTxns = (txns ?? []).filter((t) =>
        ['server_ai_usage', 'client_usage_sync'].includes(t.transaction_type)
      )
      return new Response(
        JSON.stringify({
          deviceId,
          credits: cred ?? null,
          last_activity: txns?.[0]?.created_at ?? null,
          last_ai_use: aiTxns[0]?.created_at ?? null,
          recent_transactions: (txns ?? []).slice(0, 15),
        }, null, 2),
        { headers: { 'Content-Type': 'application/json' } }
      )
    }

    // Reconciliation: free_credits is only ever changed by transaction free_deltas
    // (AI usage debits / refunds), so for a healthy ledger:
    //   sum(free_credits) == deviceCount * 1000 + sum(free_delta)
    // Any gap = credits that changed without a logged transaction (leak) or vice versa.
    if (body?.subscribers) {
      const PAGE = 1000
      const now = Date.now()
      const byState: Record<string, number> = {}
      let total = 0
      let activeNow = 0
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from('device_subscriptions')
          .select('subscription_state, expiry_time_millis, product_id')
          .range(from, from + PAGE - 1)
        if (error) throw error
        if (!data || data.length === 0) break
        for (const r of data) {
          total++
          const st = r.subscription_state ?? 'unknown'
          byState[st] = (byState[st] ?? 0) + 1
          const notExpired = (r.expiry_time_millis ?? 0) > now
          if (st === 'SUBSCRIPTION_STATE_ACTIVE' && notExpired) activeNow++
        }
        if (data.length < PAGE) break
      }
      return new Response(
        JSON.stringify(
          {
            total_subscription_records: total,
            active_now: activeNow,
            by_state: byState,
            note: 'active_now = state ACTIVE and expiry in the future (서버 기준; App Store Connect가 최종 정답)',
          },
          null,
          2
        ),
        { headers: { 'Content-Type': 'application/json' } }
      )
    }

    if (body?.reconcile) {
      const PAGE = 1000
      const cutoff = String(body?.cutoff ?? '2026-09-06') // migration to server_ai_usage model
      // Sum free_delta per device across ALL transactions.
      const deltaByDevice = new Map<string, number>()
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from('credit_transactions')
          .select('device_id, free_delta')
          .range(from, from + PAGE - 1)
        if (error) throw error
        if (!data || data.length === 0) break
        for (const r of data) {
          deltaByDevice.set(r.device_id, (deltaByDevice.get(r.device_id) ?? 0) + (r.free_delta ?? 0))
        }
        if (data.length < PAGE) break
      }
      // Compare each device: actual free_credits vs 1000 + its logged free_delta.
      const grp = (label: string) => ({ label, devices: 0, clean: 0, mismatch: 0, net_discrepancy: 0 })
      const oldG = grp('created_before_' + cutoff)
      const newG = grp('created_on_or_after_' + cutoff)
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from('device_credits')
          .select('device_id, free_credits, created_at')
          .range(from, from + PAGE - 1)
        if (error) throw error
        if (!data || data.length === 0) break
        for (const d of data) {
          const expected = 1000 + (deltaByDevice.get(d.device_id) ?? 0)
          const disc = (d.free_credits ?? 0) - expected
          const g = (d.created_at ?? '') < cutoff ? oldG : newG
          g.devices++
          if (disc === 0) g.clean++
          else { g.mismatch++; g.net_discrepancy += disc }
        }
        if (data.length < PAGE) break
      }
      return new Response(
        JSON.stringify(
          {
            cutoff,
            legacy: oldG,
            current: newG,
            note: 'current 그룹(신규 기기)의 mismatch/discrepancy가 0에 가까우면 현재 로직은 정확. legacy는 옛 방식 잔재.',
          },
          null,
          2
        ),
        { headers: { 'Content-Type': 'application/json' } }
      )
    }

    // Global stats
    const countQ = async (build: (q: any) => any): Promise<number> => {
      const { count, error } = await build(
        supabase.from('device_credits').select('*', { count: 'exact', head: true })
      )
      if (error) throw error
      return count ?? 0
    }
    const total = await countQ((q) => q)
    const untouched = await countQ((q) =>
      q.eq('free_credits', 1000).eq('paid_credits', 0).eq('subscription_credits', 0)
    )
    return new Response(
      JSON.stringify({ total_devices: total, untouched_never_used: untouched }, null, 2),
      { headers: { 'Content-Type': 'application/json' } }
    )
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
