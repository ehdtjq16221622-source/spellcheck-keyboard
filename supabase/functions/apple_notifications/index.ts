import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { verifyAppleNotificationJws, verifyAppleRenewalInfoJws, verifyAppleTransactionJws } from '../_shared/apple_notification_verifier.ts'
import { sendTelegram } from '../_shared/telegram.ts'

// App Store Server Notifications V2 receiver.
// Apple POSTs { signedPayload: <JWS> } on subscription lifecycle events. We
// verify it, resolve the device via originalTransactionId (already stored in
// device_subscriptions.purchase_token by sync_subscription_ios), update the
// subscription state in real time, and ping Telegram on key events.
//
// v1 scope: state tracking + alerts only. Credit granting stays with the
// existing app-driven sync_subscription_ios flow.
//
const STATE_ACTIVE = 'SUBSCRIPTION_STATE_ACTIVE'
const STATE_EXPIRED = 'SUBSCRIPTION_STATE_EXPIRED'
const STATE_REFUNDED = 'SUBSCRIPTION_STATE_REFUNDED'
const STATE_GRACE = 'SUBSCRIPTION_STATE_GRACE'

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

    // Telegram alerts for meaningful events.
    const labels: Record<string, string> = {
      TEST: '✅ 테스트 알림 — 애플 웹훅 연결 정상!',
      SUBSCRIBED: '🎉 새 구독',
      DID_RENEW: '🔁 구독 갱신',
      EXPIRED: '😢 구독 만료',
      REFUND: '💸 환불',
      DID_FAIL_TO_RENEW: '⚠️ 결제 실패',
      DID_CHANGE_RENEWAL_STATUS:
        subtype === 'AUTO_RENEW_DISABLED' ? '🔕 자동갱신 해지' : '🔔 자동갱신 켬',
    }
    const label = labels[notificationType]
    if (label) {
      failureStage = 'telegram_delivery'
      const cancellationNote = notificationType === 'DID_CHANGE_RENEWAL_STATUS' &&
          subtype === 'AUTO_RENEW_DISABLED'
        ? '\n현재 구독은 만료일까지 이용 가능합니다.'
        : ''
      const delivered = await sendTelegram(
        `${label}${subtype ? ` (${subtype})` : ''}\n` +
          `상품: ${productId ?? '-'}\n` +
          `환경: ${environment || '-'}\n` +
          `연결 계정: ${deviceId ? '확인됨' : '미확인'}${cancellationNote}`,
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
