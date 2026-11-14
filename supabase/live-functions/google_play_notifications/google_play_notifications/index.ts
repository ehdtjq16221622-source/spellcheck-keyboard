// Google Play real-time developer notifications (Pub/Sub authenticated push). NOT DEPLOYED YET.
//
//   * One-time products (credit packs): PURCHASED grants a pending payment that completed while the
//     app was closed (the account token in obfuscatedAccountId names the wallet), then consumes it.
//   * Voided purchases: a refunded / charged-back pack takes its credits back (same rule as Apple).
//     A voided subscription is reported for review; it is never cleared automatically here.
//   * Subscriptions (current plans only): renewals, recoveries, plan changes and expiry re-read
//     Google's record and run the same sync as the app (sync_google_subscription_v2_once); a final
//     expiry clears subscription credits (owner policy 2026-11-06, same as Apple).
//
// Responses: 200 = handled or intentionally ignored; 401 = not Google; 500 = retry later (Pub/Sub
// redelivers). Required secrets: GOOGLE_RTDN_PUSH_AUDIENCE, GOOGLE_RTDN_PUSH_SERVICE_ACCOUNT,
// GOOGLE_PLAY_SERVICE_ACCOUNT_JSON, GOOGLE_PLAY_PACKAGE_NAME. Off unless GOOGLE_RTDN_ENABLED=true.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { verifyGooglePushToken } from './_shared/google_auth.ts'
import { acknowledgeSubscription, verifySubscription } from './_shared/google_play.ts'
import { consumeProductPurchase, getProductPurchase, purchaseTokenHash } from './_shared/google_play_products.ts'
import { CREDIT_PACK_PRODUCTS, CreditPackClaimError } from './_shared/credit_pack_validation.ts'
import { validateGooglePackClaim } from './_shared/google_pack_validation.ts'
import { googleV2SyncInput, isGoogleV2Product } from './_shared/google_subscription_v2.ts'
import { sendTelegram } from './_shared/telegram.ts'

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

// Subscription notification types that mean "re-read the subscription".
const SUBSCRIPTION_SYNC_TYPES = new Set([1, 2, 3, 4, 5, 6, 7, 9, 10, 12, 13])
const SUBSCRIPTION_EXPIRED = 13
const SUBSCRIPTION_REVOKED = 12
const ONE_TIME_PURCHASED = 1

type Notification = {
  packageName?: string
  testNotification?: unknown
  oneTimeProductNotification?: { notificationType?: number; purchaseToken?: string; sku?: string }
  subscriptionNotification?: { notificationType?: number; purchaseToken?: string; subscriptionId?: string }
  voidedPurchaseNotification?: { purchaseToken?: string; orderId?: string; productType?: number; refundType?: number }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)
  if (Deno.env.get('GOOGLE_RTDN_ENABLED') !== 'true') return json({ error: 'not_found' }, 404)
  const diagnosticId = crypto.randomUUID()
  let stage = 'auth'
  try {
    const authorized = await verifyGooglePushToken(req.headers.get('Authorization'),
      Deno.env.get('GOOGLE_RTDN_PUSH_AUDIENCE') ?? '', Deno.env.get('GOOGLE_RTDN_PUSH_SERVICE_ACCOUNT') ?? '')
    if (!authorized) return json({ error: 'unauthorized' }, 401)

    stage = 'parse'
    const envelope = await req.json().catch(() => null) as { message?: { data?: string; messageId?: string } } | null
    const data = envelope?.message?.data
    if (typeof data !== 'string' || data.length > 64_000) return json({ ignored: 'no_data' })
    let note: Notification
    try {
      note = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(data), (c) => c.charCodeAt(0))))
    } catch {
      return json({ ignored: 'unreadable' })
    }
    const notificationId = `rtdn:${envelope?.message?.messageId ?? diagnosticId}`
    const packageName = Deno.env.get('GOOGLE_PLAY_PACKAGE_NAME') ?? 'com.spellcheck.keyboard'
    if (note.packageName !== packageName) return json({ ignored: 'other_package' })
    if (note.testNotification) return json({ ok: 'test' })

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const log = (result: string, extra: Record<string, unknown> = {}) =>
      console.log(JSON.stringify({ category: 'google_rtdn', result, stage, diagnosticId, ...extra }))

    // ---- voided purchase (refund, chargeback, canceled order) ----
    const voided = note.voidedPurchaseNotification
    if (voided) {
      stage = 'voided'
      if (typeof voided.orderId !== 'string' || typeof voided.purchaseToken !== 'string') return json({ ignored: 'voided_incomplete' })
      if (voided.productType === 1) {
        // Subscription refunds need a person: credits may be spent, and Apple's equivalent is reviewed too.
        await sendTelegram('⚠️ 안드로이드 구독 환불/취소 접수 · 확인 필요', {
          supabase, alertType: 'google_subscription_voided', idempotencyKey: `gpv:${voided.orderId}`,
          metadata: { refund_type: voided.refundType ?? null },
        }).catch(() => false)
        log('subscription_voided_reported')
        return json({ ok: 'reported' })
      }
      const tokenHash = await purchaseTokenHash(voided.purchaseToken)
      // The void does not name the product: find it from our record, else ask Google per pack.
      const { data: known, error: knownError } = await supabase.from('credit_pack_google_purchases')
        .select('product_id, environment').eq('order_id', voided.orderId).maybeSingle()
      if (knownError) throw knownError
      let productId = known?.product_id as string | undefined
      let environment = (known?.environment as string | undefined) ?? 'Production'
      if (!productId) {
        for (const candidate of Object.keys(CREDIT_PACK_PRODUCTS)) {
          try {
            const purchase = await getProductPurchase(packageName, candidate, voided.purchaseToken)
            if (purchase.orderId === voided.orderId) {
              productId = candidate
              environment = purchase.purchaseType === 0 ? 'Sandbox' : 'Production'
              break
            }
          } catch {
            // Not this product.
          }
        }
      }
      if (!productId) {
        log('voided_unknown_product')
        return json({ ignored: 'not_a_pack' })
      }
      const { data: refund, error } = await supabase.rpc('refund_google_credit_pack_once', {
        p_order_id: voided.orderId, p_purchase_token_hash: tokenHash, p_product_id: productId,
        p_environment: environment, p_notification_id: notificationId,
      })
      if (error) throw error
      const row = Array.isArray(refund) ? refund[0] : refund
      log('pack_voided', { refund: row?.result })
      if (row?.result === 'recovered' && row.shortfall > 0) {
        await sendTelegram(`↩️ 안드로이드 묶음 환불 · ${row.recovered.toLocaleString('ko-KR')} 회수, 부족 ${row.shortfall.toLocaleString('ko-KR')}`, {
          supabase, alertType: 'credit_pack_refund', idempotencyKey: `gpr:${voided.orderId}`,
          metadata: { product_id: productId, environment },
        }).catch(() => false)
      }
      return json({ ok: row?.result ?? 'done' })
    }

    // ---- one-time product (credit pack) completed outside the app ----
    const oneTime = note.oneTimeProductNotification
    if (oneTime) {
      stage = 'one_time'
      if (oneTime.notificationType !== ONE_TIME_PURCHASED || typeof oneTime.purchaseToken !== 'string' ||
          typeof oneTime.sku !== 'string' || !Object.hasOwn(CREDIT_PACK_PRODUCTS, oneTime.sku)) {
        return json({ ignored: 'one_time_other' })
      }
      const purchase = await getProductPurchase(packageName, oneTime.sku, oneTime.purchaseToken) as unknown as Record<string, unknown>
      const accountToken = purchase.obfuscatedExternalAccountId
      if (typeof accountToken !== 'string') return json({ ignored: 'no_account_binding' })
      const { data: walletId, error: walletError } = await supabase.rpc('credit_pack_wallet_for_account_token', { p_account_token: accountToken })
      if (walletError) throw walletError
      if (typeof walletId !== 'string') {
        log('unknown_account_token')
        return json({ ignored: 'unknown_account' })
      }
      let claim
      try {
        claim = validateGooglePackClaim({ productId: oneTime.sku, purchase, expectedAccountToken: accountToken })
      } catch (error) {
        if (error instanceof CreditPackClaimError) {
          log('pack_not_granted', { code: error.code })
          return json({ ignored: error.code })
        }
        throw error
      }
      const { data: granted, error } = await supabase.rpc('grant_google_credit_pack_once', {
        p_wallet_id: walletId, p_account_token: accountToken, p_order_id: claim.orderId,
        p_purchase_token_hash: await purchaseTokenHash(oneTime.purchaseToken), p_product_id: claim.productId,
        p_environment: claim.environment,
      })
      if (error) throw error
      const row = Array.isArray(granted) ? granted[0] : granted
      if (purchase.consumptionState !== 1 && ['granted', 'already_granted', 'sandbox_limit'].includes(row?.result)) {
        await consumeProductPurchase(packageName, oneTime.sku, oneTime.purchaseToken).catch(() => {
          // The app also claims unconsumed purchases on launch; consumption is retried there.
        })
      }
      log('pack_purchased', { grant: row?.result, environment: claim.environment })
      return json({ ok: row?.result ?? 'done' })
    }

    // ---- subscriptions (current plans) ----
    const sub = note.subscriptionNotification
    if (sub) {
      stage = 'subscription'
      if (!SUBSCRIPTION_SYNC_TYPES.has(sub.notificationType ?? -1) || typeof sub.purchaseToken !== 'string' ||
          !isGoogleV2Product(sub.subscriptionId)) {
        return json({ ignored: 'subscription_other' })
      }
      const verified = await verifySubscription(packageName, sub.subscriptionId, sub.purchaseToken)
      // Wallet: the row that already holds this token, else the one holding the linked (previous)
      // token, else the account token Google carries (first purchase completed outside the app).
      let walletId: string | null = null
      for (const token of [sub.purchaseToken, verified.linkedPurchaseToken]) {
        if (!token) continue
        const { data, error } = await supabase.from('device_subscriptions').select('device_id').eq('purchase_token', token).maybeSingle()
        if (error) throw error
        if (data?.device_id) { walletId = data.device_id; break }
      }
      if (!walletId && verified.obfuscatedAccountId) {
        const { data, error } = await supabase.rpc('credit_pack_wallet_for_account_token', { p_account_token: verified.obfuscatedAccountId })
        if (error) throw error
        if (typeof data === 'string') walletId = data
      }
      if (!walletId) {
        log('subscription_wallet_unknown')
        return json({ ignored: 'unknown_wallet' })
      }
      const input = googleV2SyncInput(verified, sub.subscriptionId, sub.purchaseToken)
      const { data, error } = await supabase.rpc('sync_google_subscription_v2_once', {
        p_device_id: walletId, p_product_id: sub.subscriptionId, p_purchase_token: sub.purchaseToken,
        p_linked_purchase_token: input.linkedPurchaseToken, p_state: input.state,
        p_expiry_time_millis: input.expiryTimeMillis, p_order_id: verified.orderId, p_cycle_key: input.cycleKey,
        p_amount: input.amount,
        p_metadata: { notification_id: notificationId, google_purchase_verified: true, test_purchase: verified.testPurchase },
      })
      if (error) {
        // Review-type rejections (owner change, unlinked token) will not succeed on retry.
        if (/requires review|belongs to another wallet|stale Google subscription/.test(error.message ?? '')) {
          log('subscription_review_required', { reason: error.message })
          await sendTelegram('⚠️ 안드로이드 구독 동기화 확인 필요', {
            supabase, alertType: 'google_subscription_review', idempotencyKey: `gps:${notificationId}`,
            metadata: { reason: String(error.message).slice(0, 120) },
          }).catch(() => false)
          return json({ ok: 'review_required' })
        }
        throw error
      }
      if (!verified.acknowledged && input.state === 'SUBSCRIPTION_STATE_ACTIVE') {
        await acknowledgeSubscription(packageName, sub.subscriptionId, sub.purchaseToken).catch(() => {})
      }
      let expiry: string | undefined
      if ((sub.notificationType === SUBSCRIPTION_EXPIRED || sub.notificationType === SUBSCRIPTION_REVOKED) &&
          input.state === 'SUBSCRIPTION_STATE_EXPIRED' && input.expiryTimeMillis != null) {
        const { data: cleared, error: clearError } = await supabase.rpc('expire_google_subscription_credits', {
          p_purchase_token: sub.purchaseToken, p_expired_ms: input.expiryTimeMillis, p_notification_id: notificationId,
        })
        if (clearError) throw clearError
        expiry = (Array.isArray(cleared) ? cleared[0] : cleared)?.result
      }
      const row = Array.isArray(data) ? data[0] : data
      log('subscription_synced', { type: sub.notificationType, state: input.state, granted: row?.applied === true, expiry })
      return json({ ok: 'synced' })
    }

    return json({ ignored: 'unknown_type' })
  } catch (error) {
    console.error(JSON.stringify({ category: 'google_rtdn', result: 'error', stage, diagnosticId,
      message: error instanceof Error ? error.message.slice(0, 200) : 'unknown' }))
    return json({ error: 'retry', diagnostic_id: diagnosticId }, 500)
  }
})
