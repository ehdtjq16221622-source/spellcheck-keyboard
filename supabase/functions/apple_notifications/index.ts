import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { verifyAppleNotificationJws, verifyAppleRenewalInfoJws, verifyAppleTransactionJws } from './_shared/apple_notification_verifier.ts'
import { sendTelegram } from './_shared/telegram.ts'
import { subscriptionCreditsForProduct } from './_shared/credits.ts'

// App Store Server Notifications V2 receiver.
// Apple POSTs { signedPayload: <JWS> } on subscription lifecycle events. We
// verify it, resolve the device via originalTransactionId (already stored in
// device_subscriptions.purchase_token by sync_subscription_ios), update the
// subscription state in real time, and ping Telegram on key events.
//
// Credits: the app-driven sync_subscription_ios flow still owns the first purchase and any wallet
// it has to resolve. On top of that, a Production renewal grants the new cycle's credits right
// away and a refund takes back the refunded cycle's subscription credits. Both are idempotent
// database functions that skip wallets they cannot safely resolve; failures are logged only.
//
const STATE_ACTIVE = 'SUBSCRIPTION_STATE_ACTIVE'
const STATE_EXPIRED = 'SUBSCRIPTION_STATE_EXPIRED'
const STATE_REFUNDED = 'SUBSCRIPTION_STATE_REFUNDED'
const STATE_GRACE = 'SUBSCRIPTION_STATE_GRACE'
const KNOWN_SUBSCRIPTION_PRODUCTS = new Set([
  'com.kingboard.app.monthly_basic',
  'com.kingboard.app.monthly_premium',
  'com.kingboard.app.monthly_pro',
])

function safeErrorCode(error: unknown): string {
  let current = error
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const record = typeof current === 'object' ? current as { message?: unknown; cause?: unknown } : null
    const message = typeof record?.message === 'string' ? record.message.toLowerCase() : ''
    if (message.includes('x509certificate.prototype.tostring') || message.includes('x509certificate') && message.includes('not implemented')) {
      return 'x509_pem_compatibility_failure'
    }
    if (message.includes('certificate chain') || message.includes('certificate verification')) {
      return 'apple_certificate_chain_verification_failed'
    }
    if (/^[a-z0-9_]+$/.test(message)) return message
    if (message === 'subscription_lookup_failed' || message === 'subscription_state_update_failed' ||
        message === 'telegram_delivery_failed') return message
    current = record?.cause
  }
  return 'unclassified_error'
}

Deno.serve(async (req: Request) => {
  const diagnosticId = crypto.randomUUID()
  let failureStage = 'request_validation'
  try {
    const body = await req.json().catch(() => ({}))
    const signedPayload = body?.signedPayload
    if (!signedPayload || typeof signedPayload !== 'string') {
      return new Response(JSON.stringify({ error: 'missing signedPayload' }), { status: 400 })
    }

    const expectedBundle = Deno.env.get('APPLE_APP_BUNDLE_ID') ?? 'com.kingboard.app'
    failureStage = 'apple_signature_verification'
    const { notification: notif, environment: verifiedEnvironment } =
      await verifyAppleNotificationJws(signedPayload, expectedBundle)
    const notificationType = String(notif.notificationType ?? '')
    const subtype = String(notif.subtype ?? '')
    const data = (notif.data ?? {}) as Record<string, unknown>

    if (data.bundleId && data.bundleId !== expectedBundle) {
      return new Response(JSON.stringify({ error: 'bundle mismatch' }), { status: 400 })
    }

    failureStage = 'signed_data_verification'
    const tx: Record<string, unknown> = data.signedTransactionInfo
      ? await verifyAppleTransactionJws(
        data.signedTransactionInfo as string,
        expectedBundle,
        verifiedEnvironment,
      )
      : {}
    const renewal: Record<string, unknown> = data.signedRenewalInfo
      ? await verifyAppleRenewalInfoJws(
        data.signedRenewalInfo as string,
        verifiedEnvironment,
      )
      : {}

    if (tx.originalTransactionId && renewal.originalTransactionId &&
        tx.originalTransactionId !== renewal.originalTransactionId) {
      throw new Error('Apple transaction and renewal identifiers do not match.')
    }

    const originalTransactionId =
      (tx.originalTransactionId as string) ?? (renewal.originalTransactionId as string) ?? null
    const productId = (tx.productId as string) ?? (renewal.autoRenewProductId as string) ?? null
    const expiresMs = typeof tx.expiresDate === 'number' ? (tx.expiresDate as number) : null
    const environment = String(verifiedEnvironment)
    const notificationUUID = String(notif.notificationUUID ?? '')

    // Map notification type -> subscription state (null = leave state unchanged).
    let state: string | null = null
    switch (notificationType) {
      case 'SUBSCRIBED':
      case 'DID_RENEW':
      case 'OFFER_REDEEMED':
        state = STATE_ACTIVE
        break
      case 'EXPIRED':
      case 'GRACE_PERIOD_EXPIRED':
        state = STATE_EXPIRED
        break
      case 'REFUND':
        state = STATE_REFUNDED
        break
      case 'DID_FAIL_TO_RENEW':
        state = subtype === 'GRACE_PERIOD' ? STATE_GRACE : STATE_EXPIRED
        break
      // DID_CHANGE_RENEWAL_STATUS: auto-renew toggled; stays active until expiry.
      default:
        state = null
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    failureStage = 'subscription_lookup'
    let deviceId: string | null = null
    if (originalTransactionId) {
      const { data: sub, error } = await supabase
        .from('device_subscriptions')
        .select('device_id')
        .eq('purchase_token', originalTransactionId)
        .maybeSingle()
      if (error) {
        console.error('[apple_notifications] subscription lookup failed', {
          diagnosticId,
          code: error.code ?? 'unknown',
        })
        throw new Error('subscription_lookup_failed')
      }
      deviceId = sub?.device_id ?? null
    }

    if (deviceId && state) {
      failureStage = 'subscription_state_update'
      const { error } = await supabase
        .from('device_subscriptions')
        .update({
          subscription_state: state,
          expiry_time_millis: expiresMs,
          last_verified_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('device_id', deviceId)
        .eq('purchase_token', originalTransactionId)
      if (error) {
        console.error('[apple_notifications] subscription update failed', {
          diagnosticId,
          code: error.code ?? 'unknown',
        })
        throw new Error('subscription_state_update_failed')
      }
    }

    // Credit follow-up. The state update above is what this webhook must get right, so a failure
    // here is logged and left to the app-driven sync instead of failing (and re-delivering) it.
    if (deviceId && environment === 'Production' && originalTransactionId) {
      try {
        if (notificationType === 'DID_RENEW' && productId && expiresMs &&
            KNOWN_SUBSCRIPTION_PRODUCTS.has(productId)) {
          const { data, error } = await supabase.rpc('grant_subscription_credits_on_renewal', {
            p_original_txn: originalTransactionId,
            p_product_id: productId,
            p_expires_ms: expiresMs,
            p_amount: subscriptionCreditsForProduct(productId),
            p_notification_id: notificationUUID,
          })
          if (error) throw error
          console.log(JSON.stringify({
            category: 'subscription_credit_followup', type: 'renewal_grant',
            result: (Array.isArray(data) ? data[0] : data)?.result ?? 'unknown', diagnosticId,
          }))
        } else if (notificationType === 'REFUND') {
          const { data, error } = await supabase.rpc('revoke_subscription_credits_on_refund', {
            p_original_txn: originalTransactionId,
            p_refunded_expires_ms: expiresMs,
            p_notification_id: notificationUUID,
          })
          if (error) throw error
          console.log(JSON.stringify({
            category: 'subscription_credit_followup', type: 'refund_revoke',
            result: (Array.isArray(data) ? data[0] : data)?.result ?? 'unknown', diagnosticId,
          }))
        }
      } catch (followupError) {
        console.error(JSON.stringify({
          category: 'subscription_credit_followup', result: 'failed',
          code: safeErrorCode(followupError), diagnosticId,
        }))
      }
    }

    // Telegram alerts for meaningful events. Kept short: the first line says what
    // happened and to which plan; extra lines appear only when something is off.
    const plan = planName(productId)
    const nextPlan = planName(renewal.autoRenewProductId)
    const planChange = nextPlan !== plan ? `${plan} → ${nextPlan}` : nextPlan
    const labels: Record<string, string> = {
      TEST: '✅ 애플 알림 연결 정상',
      SUBSCRIBED: `🎉 새 구독 · ${plan}`,
      DID_RENEW: `🔁 구독 갱신 · ${plan}`,
      EXPIRED: `👋 구독 만료 · ${plan}`,
      REFUND: `💸 환불 · ${plan}`,
      DID_FAIL_TO_RENEW: `⚠️ 결제 실패 · ${plan}${subtype === 'GRACE_PERIOD' ? ' (유예 기간 중)' : ''}`,
      DID_CHANGE_RENEWAL_STATUS:
        subtype === 'AUTO_RENEW_DISABLED' ? `😢 해지 예약 · ${plan}` : `🙌 해지 취소 · ${plan}`,
      DID_CHANGE_RENEWAL_PREF: subtype === 'UPGRADE' ? `⬆️ 플랜 올림 · ${planChange}` :
        subtype === 'DOWNGRADE' ? `⬇️ 플랜 내림 예약 · ${planChange}` : `↩️ 플랜 변경 취소 · ${plan}`,
    }
    const label = labels[notificationType]
    if (label) {
      failureStage = 'telegram_delivery'
      // Apple re-sends failed notifications for up to ~3 days with the original
      // signedDate, so flag late arrivals and show when it actually happened.
      const eventMs = typeof notif.signedDate === 'number' ? notif.signedDate as number : null
      const purchaseMs = typeof tx.purchaseDate === 'number' ? tx.purchaseDate as number : null
      const delayedMinutes = eventMs != null ? Math.max(0, Math.round((Date.now() - eventMs) / 60_000)) : null
      const isDelayed = delayedMinutes != null && delayedMinutes >= 10
      const isPurchase = notificationType === 'SUBSCRIBED' || notificationType === 'DID_RENEW'
      const whenMs = isPurchase ? (purchaseMs ?? eventMs) : eventMs
      const details: string[] = []
      if (whenMs != null) {
        details.push(formatKst(whenMs) + (isDelayed ? ` (${formatAgo(Date.now() - whenMs)} 전 · 늦게 도착)` : ''))
      }
      if (notificationType === 'DID_CHANGE_RENEWAL_STATUS' && subtype === 'AUTO_RENEW_DISABLED') {
        details.push('만료일까지 이용 가능')
      }
      const lines = [`${environment === 'Production' ? '' : '🧪 [테스트] '}${label}`]
      if (details.length) lines.push(details.join(' · '))
      if (!deviceId && notificationType !== 'TEST') lines.push('⚠️ 연결된 지갑 없음')
      // Cancellations and refunds are rare, so they carry the current subscriber
      // count in the same message. SUBSCRIBED/DID_RENEW skip it (noisy in spikes).
      const wantsSummary = (notificationType === 'DID_CHANGE_RENEWAL_STATUS' &&
          subtype === 'AUTO_RENEW_DISABLED') || notificationType === 'REFUND'
      if (wantsSummary) lines.push(await subscriberSummaryLine())
      const delivered = await sendTelegram(
        lines.join('\n'),
        {
          supabase,
          alertType: 'apple_notification',
          idempotencyKey: notificationUUID,
          metadata: {
            notificationType,
            subtype: subtype || null,
            productId,
            environment,
            deviceLinked: Boolean(deviceId),
            delayedMinutes,
            subscriptionFingerprint: originalTransactionId
              ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(originalTransactionId))),
                byte => byte.toString(16).padStart(2, '0')).join('') : null,
            currentProductId: tx.productId ?? null,
            renewalProductId: renewal.autoRenewProductId ?? null,
            autoRenewStatus: renewal.autoRenewStatus === 0 || renewal.autoRenewStatus === 1 ? renewal.autoRenewStatus : null,
            eventTimeMs: eventMs,
            expiresTimeMs: expiresMs,
          },
        },
      )
      if (!delivered) throw new Error('telegram_delivery_failed')
    }

    console.log('[apple_notifications] processed', {
      notificationType,
      subtype,
      state,
      environment,
      deviceLinked: Boolean(deviceId),
      diagnosticId,
    })
    return new Response(
      JSON.stringify({ ok: true, notificationType, subtype, state, diagnosticId }),
      { headers: { 'Content-Type': 'application/json' } }
    )
  } catch (e) {
    console.error('[apple_notifications] request failed', {
      failureStage,
      diagnosticId,
      errorCode: safeErrorCode(e),
    })
    return new Response(JSON.stringify({
      error: 'notification_processing_failed',
      failure_stage: failureStage,
      diagnostic_id: diagnosticId,
    }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
})

// "베이직" for com.kingboard.app.monthly_basic; unknown products keep their raw ID.
function planName(productId: unknown): string {
  const names: Record<string, string> = {
    'com.kingboard.app.monthly_basic': '베이직',
    'com.kingboard.app.monthly_premium': '프리미엄',
    'com.kingboard.app.monthly_pro': '프로',
  }
  return typeof productId === 'string' ? names[productId] ?? productId : '상품 미확인'
}

// "👥 구독자 60명 (유지 45 · 해지 예약 15)". Best-effort: never throws, and a
// failed lookup says so instead of dropping the line.
async function subscriberSummaryLine(): Promise<string> {
  try {
    const r = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/subscriber_status`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}` },
      signal: AbortSignal.timeout(20_000),
    })
    if (!r.ok) {
      await r.body?.cancel()
      throw new Error(`subscriber_status_http_${r.status}`)
    }
    const j = await r.json()
    const active = j.active_subscribers_now
    if (typeof active !== 'number') throw new Error('subscriber_status_bad_response')
    const parts: string[] = []
    if (typeof j.auto_renew_on_now === 'number') parts.push(`유지 ${j.auto_renew_on_now}`)
    if (typeof j.auto_renew_off_now === 'number') parts.push(`해지 예약 ${j.auto_renew_off_now}`)
    if (j.auto_renew_unknown_now > 0) parts.push(`확인 불가 ${j.auto_renew_unknown_now}`)
    return `👥 구독자 <b>${active}</b>명${parts.length ? ` (${parts.join(' · ')})` : ''}` +
      (j.failed_lookups > 0 ? ' · 일부 조회 실패' : '')
  } catch (e) {
    console.error('[apple_notifications] subscriber status lookup failed', {
      errorCode: safeErrorCode(e),
    })
    return '👥 구독자 수 조회 실패 · /구독 으로 확인'
  }
}

// "10/4 03:56" in KST.
function formatKst(ms: number): string {
  const k = new Date(ms + 9 * 60 * 60 * 1000)
  return `${k.getUTCMonth() + 1}/${k.getUTCDate()} ${String(k.getUTCHours()).padStart(2, '0')}:${String(k.getUTCMinutes()).padStart(2, '0')}`
}

// "37시간" / "45분" / "2일".
function formatAgo(diffMs: number): string {
  const minutes = Math.max(0, Math.round(diffMs / 60_000))
  if (minutes < 60) return `${minutes}분`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}시간`
  return `${Math.round(hours / 24)}일`
}
