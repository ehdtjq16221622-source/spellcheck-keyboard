// Apple payloads decoded here are only for reporting, never access or credit grants.
export type AppleTransaction = Record<string, any>
export type SubscriptionObservation = {
  chain: string
  owner: string
  current: ReturnType<typeof selectAppleSubscription>
  history: AppleTransaction[]
  historyComplete: boolean
  lookupFailed: boolean
}

export function decodeApplePayload(jws: unknown): AppleTransaction | null {
  if (typeof jws !== 'string') return null
  try {
    const part = jws.split('.')[1]?.replace(/-/g, '+').replace(/_/g, '/')
    if (!part) return null
    const value = JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, '=')))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch { return null }
}

export function subscriptionTier(product: unknown): string | null {
  return typeof product === 'string' && /^com\.kingboard\.app\.monthly_(basic|premium|pro)$/.test(product)
    ? product.slice('com.kingboard.app.'.length) : null
}

export function selectAppleSubscription(body: any, chain: string) {
  if (body?.environment === 'Sandbox') return null
  const items = (Array.isArray(body?.data) ? body.data : []).flatMap((group: any) =>
    Array.isArray(group.lastTransactions) ? group.lastTransactions : [])
    .map((item: any) => ({ status: item.status as number,
      chain: item.originalTransactionId as string,
      transaction: decodeApplePayload(item.signedTransactionInfo),
      renewal: decodeApplePayload(item.signedRenewalInfo) }))
    .filter((item: any) => item.transaction?.environment === 'Production' &&
      subscriptionTier(item.transaction.productId) && typeof item.transaction.transactionId === 'string' &&
      typeof item.transaction.originalTransactionId === 'string' &&
      typeof item.transaction.purchaseDate === 'number' && typeof item.transaction.expiresDate === 'number' &&
      item.transaction?.isUpgraded !== true)
  items.sort((a: any, b: any) => {
    const entitled = (x: any) => Number(x.status === 1 || x.status === 4)
    return entitled(b) - entitled(a) ||
      Number(b.transaction?.purchaseDate ?? 0) - Number(a.transaction?.purchaseDate ?? 0) ||
      Number(b.transaction?.expiresDate ?? 0) - Number(a.transaction?.expiresDate ?? 0) ||
      Math.max(Number(b.renewal?.signedDate ?? 0), Number(b.transaction?.signedDate ?? 0)) -
        Math.max(Number(a.renewal?.signedDate ?? 0), Number(a.transaction?.signedDate ?? 0)) ||
      Number(b.chain === chain) - Number(a.chain === chain)
  })
  return items[0] ?? null
}

export function renewalState(renewal: AppleTransaction | null): 'on' | 'off' | 'unknown' {
  return renewal?.autoRenewStatus === 1 ? 'on' : renewal?.autoRenewStatus === 0 ? 'off' : 'unknown'
}

export function groupSubscriptionPeople(observations: SubscriptionObservation[]) {
  const parent = observations.map((_, i) => i)
  const find = (i: number): number => parent[i] === i ? i : (parent[i] = find(parent[i]))
  const keys = new Map<string, number>()
  observations.forEach((row, i) => {
    const links = [`owner:${row.owner}`, `chain:${row.chain}`]
    if (row.current?.chain) links.push(`chain:${row.current.chain}`)
    for (const tx of row.history) if (tx.originalTransactionId) links.push(`chain:${tx.originalTransactionId}`)
    for (const key of links) {
      if (keys.has(key)) parent[find(i)] = find(keys.get(key)!)
      else keys.set(key, i)
    }
  })
  const groups = new Map<number, SubscriptionObservation[]>()
  observations.forEach((row, i) => {
    const root = find(i)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root)!.push(row)
  })
  return [...groups.values()]
}

export function latestPersonSubscription(person: SubscriptionObservation[]) {
  return person.map(row => row.current).filter(Boolean).sort((a, b) =>
    Number(b!.status === 1 || b!.status === 4) - Number(a!.status === 1 || a!.status === 4) ||
    Number(b!.transaction?.purchaseDate ?? 0) - Number(a!.transaction?.purchaseDate ?? 0) ||
    Math.max(Number(b!.renewal?.signedDate ?? 0), Number(b!.transaction?.signedDate ?? 0)) -
      Math.max(Number(a!.renewal?.signedDate ?? 0), Number(a!.transaction?.signedDate ?? 0)))[0] ?? null
}

export function buildRenewalOutcomes(people: SubscriptionObservation[][], now: number) {
  const start = now - 30 * 86400_000
  const outcomes = { same_plan: 0, changed_plan: 0, expired: 0,
    resubscribed_same_plan: 0, resubscribed_changed_plan: 0,
    not_due: 0, pending_billing: 0, refunded: 0, unknown: 0 }
  for (const person of people) {
    const completeChains = new Set(person.filter(row => row.historyComplete)
      .flatMap(row => row.history.map(tx => tx.originalTransactionId)))
    if (!person.every(row => row.historyComplete || completeChains.has(row.chain))) {
      outcomes.unknown++; continue
    }
    const transactions = new Map<string, AppleTransaction>()
    for (const row of person) for (const tx of row.history) {
      if (!subscriptionTier(tx.productId) || tx.environment !== 'Production' ||
          typeof tx.transactionId !== 'string' || typeof tx.purchaseDate !== 'number' ||
          typeof tx.expiresDate !== 'number' || tx.expiresDate <= tx.purchaseDate || tx.purchaseDate > now) continue
      const previous = transactions.get(tx.transactionId)
      if (!previous || Number(tx.signedDate ?? 0) >= Number(previous.signedDate ?? 0)) transactions.set(tx.transactionId, tx)
    }
    const sorted = [...transactions.values()].sort((a, b) => a.purchaseDate - b.purchaseDate)
    const current = latestPersonSubscription(person)
    if (current?.status === 5) {
      const revoked = current.transaction?.revocationDate
      if (typeof revoked !== 'number' || revoked > now) outcomes.unknown++
      else if (revoked >= start) outcomes.refunded++
      else outcomes.not_due++
      continue
    }
    if (!sorted.length || person.some(row => row.lookupFailed && !completeChains.has(row.chain))) {
      outcomes.unknown++; continue
    }
    // One person's latest completed billing decision in the rolling 30-day window.
    // An upgrade ends the old plan early; a later PURCHASE is a resubscription.
    let decision: keyof typeof outcomes | null = null
    for (let i = 0; i < sorted.length; i++) {
      const tx = sorted[i], next = sorted[i + 1]
      if (tx.revocationDate != null) continue
      const end = tx.isUpgraded && next ? Math.min(tx.expiresDate, next.purchaseDate) : tx.expiresDate
      const decisionAt = next?.purchaseDate ?? end
      if (decisionAt > now || decisionAt < start) continue
      if (tx.isUpgraded && !next) { decision = 'unknown'; continue }
      if (next) {
        if (next.revocationDate != null) { decision = 'unknown'; continue }
        const changed = next.productId !== tx.productId
        if (next.purchaseDate <= end || next.transactionReason === 'RENEWAL') {
          decision = changed ? 'changed_plan' : 'same_plan'
        } else if (next.transactionReason === 'PURCHASE') {
          decision = changed ? 'resubscribed_changed_plan' : 'resubscribed_same_plan'
        } else decision = 'unknown'
      } else if (current?.status === 2) decision = 'expired'
      else if (current?.status === 3 || current?.status === 4) decision = 'pending_billing'
      else decision = 'unknown'
    }
    outcomes[decision ?? 'not_due']++
  }
  const denominator = outcomes.same_plan + outcomes.changed_plan + outcomes.expired +
    outcomes.resubscribed_same_plan + outcomes.resubscribed_changed_plan
  return { window_start: new Date(start).toISOString(), window_end: new Date(now).toISOString(),
    basis: 'apple_transaction_history_latest_decision_per_person', ...outcomes, denominator,
    renewal_rate: denominator ? (outcomes.same_plan + outcomes.changed_plan) / denominator * 100 : null,
    expired_without_return_rate: denominator ? outcomes.expired / denominator * 100 : null }
}

export function subscriptionStatusText(j: any, includeOutcomes = false): string {
  const on = j.auto_renew_on_now, off = j.auto_renew_off_now, unknown = j.auto_renew_unknown_now
  let text = ''
  if (typeof on === 'number' && typeof off === 'number') {
    const known = on + off
    text += `자동갱신 유지 ${on}명 · 중단 예정 ${off}명 · 확인 불가 ${unknown ?? '미집계'}명\n`
    text += `자동갱신 중단 비율 ${known ? (off / known * 100).toFixed(1) + '%' : '집계 불가'} (상태 확인 ${known}명 기준 · 실제 만료율 아님)\n`
  }
  if (typeof j.pending_plan_changes_now === 'number') text += `다음 갱신 때 플랜 변경 예정 ${j.pending_plan_changes_now}명\n`
  if (includeOutcomes) {
    const o = j.renewal_outcomes
    if (o) {
      text += `\n최근 30일 갱신 결과 (1인당 최근 1회 · 확인 ${o.denominator}명)\n` +
        `같은 플랜 갱신 ${o.same_plan}명 · 플랜 변경 갱신 ${o.changed_plan}명\n` +
        `미갱신 만료 ${o.expired}명\n` +
        `만료 후 재구독: 같은 플랜 ${o.resubscribed_same_plan}명 · 다른 플랜 ${o.resubscribed_changed_plan}명\n` +
        `갱신 유지율 ${o.renewal_rate == null ? '집계 불가' : o.renewal_rate.toFixed(1) + '%'} · 미갱신 만료율 ${o.expired_without_return_rate == null ? '집계 불가' : o.expired_without_return_rate.toFixed(1) + '%'}\n` +
        `집계 제외: 기간 내 갱신 시점 없음 ${o.not_due}명 · 결제 확인 중 ${o.pending_billing}명 · 환불 ${o.refunded}명 · 이력 확인 불가 ${o.unknown}명\n` +
        '※ 만료 후 재구독은 갱신에 합치지 않습니다. 결제 재시도 후 자동 갱신은 재가입과 구분합니다.\n'
    } else text += '\n갱신·재구독 이력 집계 불가 · 0명이라는 뜻이 아닙니다.\n'
  }
  if (j.failed_lookups > 0) text += `Apple 상태 조회 실패 ${j.failed_lookups}건 · 현재 구독자 수가 실제보다 적을 수 있습니다.\n`
  return text
}
