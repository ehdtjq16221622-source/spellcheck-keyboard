import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { ALERT_TYPE, fingerprint, grantKey, sendIncident } from '../_shared/subscription_alerts.ts'

Deno.serve(async (req: Request) => {
  const secret = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const monitorSecret = Deno.env.get('SUBSCRIPTION_MONITOR_SECRET')
  const authorized = secret && req.headers.get('Authorization') === `Bearer ${secret}`
  const scheduled = monitorSecret && req.headers.get('x-monitor-secret') === monitorSecret
  if (!secret || (!authorized && !scheduled)) {
    return new Response('Unauthorized', { status: 401 })
  }
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  const db = createClient(Deno.env.get('SUPABASE_URL')!, secret)
  try {
    const body = await req.json()
    if (body.self_test === true) {
      const delivered = await sendIncident(db, 'subscription-monitor-setup-20261011',
        '[킹보드 구독 감시 테스트]\n관리자 알림 연결 확인용입니다. 실제 결제 오류나 크레딧 변경은 발생시키지 않았습니다.')
      return Response.json({ self_test: true, delivered })
    }
    const retry = await db.from('telegram_alert_logs').select('idempotency_key,metadata')
      .eq('alert_type', ALERT_TYPE).eq('delivery_status', 'unknown')
      .lt('sent_at', new Date(Date.now() - 300_000).toISOString()).order('sent_at').limit(10)
    if (retry.error) throw new Error('retry_query_failed')
    for (const row of retry.data ?? []) {
      if (typeof row.metadata?.message === 'string') await sendIncident(db, row.idempotency_key, row.metadata.message)
    }
    // Scan the recorded, unexpired iOS subscriptions, not balances or Apple charges.
    const subscriptions = await db.from('device_subscriptions')
      .select('device_id,product_id,purchase_token,last_cycle_key', { count: 'exact' })
      .like('product_id', 'com.kingboard.%').eq('subscription_state', 'SUBSCRIPTION_STATE_ACTIVE')
      .gt('expiry_time_millis', Date.now())
      .lt('updated_at', new Date(Date.now() - 900_000).toISOString()).limit(500)
    if (subscriptions.error || subscriptions.count === null || subscriptions.count !== subscriptions.data?.length) {
      throw new Error('incomplete_subscription_scan')
    }
    let matched = 0
    let missing = 0
    let insufficient = 0
    const missingKeys: string[] = []
    for (const row of subscriptions.data) {
      const key = grantKey(row)
      if (!key) { insufficient++; continue }
      const grants = await db.from('credit_transactions').select('id')
        .eq('transaction_type', 'subscription_monthly_grant').eq('idempotency_key', key).limit(1)
      if (grants.error) throw new Error('grant_query_failed')
      if (grants.data?.length) { matched++; continue }
      missing++
      missingKeys.push(await fingerprint(key))
    }
    if (missingKeys.length) {
      const incident = await fingerprint(`missing-ios-grants:${missingKeys.sort().join(':')}`)
      await sendIncident(db, incident,
        `[킹보드 구독 지급 확인 필요]\n${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} KST\n활성 구독 ${missing}건의 현재 주기와 일치하는 지급 원장이 조회되지 않았습니다.\n관리 번호: ${incident.slice(0, 12)}\n실제 손실 여부와 원인은 미확인입니다. Apple 결제 및 지갑 이력을 대조하세요. 자동 재지급하지 않았습니다.`)
    }
    if (insufficient) {
      await sendIncident(db, `insufficient:${insufficient}:${new Date().toISOString().slice(0, 10)}`,
        `[킹보드 구독 감시 확인 불가]\n현재 주기 식별 정보가 부족한 활성 구독 ${insufficient}건은 지급 여부를 판정하지 못했습니다. 원본 구독 기록을 확인하세요.`)
    }
    const result = { checked: subscriptions.data.length, matched, missing, insufficient,
      scope: 'recorded_unexpired_ios_cycle_ledger_only' }
    console.log(JSON.stringify({ category: 'subscription_monitor', ...result }))
    return Response.json(result)
  } catch {
    console.error(JSON.stringify({ category: 'subscription_monitor', event: 'monitor_failed' }))
    try {
      await sendIncident(db, `monitor-failed:${new Date().toISOString().slice(0, 10)}`,
        '[킹보드 구독 감시 실패]\n구독/원장 조회 또는 알림 전송이 완료되지 않았습니다. 정상으로 판정할 수 없습니다. 관리자 점검이 필요합니다.')
    } catch { /* Delivery failure is recorded without exposing credentials. */ }
    return Response.json({ error: 'monitor_failed' }, { status: 500 })
  }
})
