import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { fetchCurrentAppleTransaction, verifyAppleTransactionJws } from './_shared/apple_subscription_status.ts'
import { resolveCreditWallet, WalletAccessError } from './_shared/wallet_auth.ts'
import { CreditPackClaimError, validateCreditPackClaim } from './_shared/credit_pack_validation.ts'
import { sendTelegram } from './_shared/telegram.ts'

// Credit packs (one-time AI credits that never expire).
//   POST { action: 'account_token', wallet_id }               -> { account_token }
//   POST { action: 'claim', wallet_id, signed_transaction }    -> { result, credits, paid_credits }
// The app buys with StoreKit using account_token as appAccountToken, sends the signed transaction
// here, and finishes the StoreKit transaction only after a final result (granted / already_granted /
// refunded / sandbox_limit). Anything else is retried by the app on the next launch.
// Requires an Apple-linked wallet session (owner decision 2026-11-04: packs need Apple sign-in).

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const FINAL_RESULTS = new Set(['granted', 'already_granted', 'refunded', 'sandbox_limit'])

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

function rpcErrorCode(error: unknown): string {
  const message = typeof (error as { message?: unknown })?.message === 'string' ? (error as { message: string }).message : ''
  const known = ['account_binding_mismatch', 'transaction_wallet_or_product_mismatch', 'wallet_not_found',
    'unknown_product', 'invalid_environment', 'invalid_transaction_id', 'invalid_wallet', 'credit_overflow',
    'wallet_alias_chain_too_long']
  return known.find((code) => message.includes(code)) ?? 'grant_failed'
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)
  const diagnosticId = crypto.randomUUID()
  let stage = 'request_validation'
  try {
    const body = await req.json().catch(() => null) as Record<string, unknown> | null
    const action = body?.action
    if (action !== 'account_token' && action !== 'claim') return json({ error: 'invalid_action' }, 400)

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    stage = 'wallet_auth'
    const wallet = await resolveCreditWallet(req, supabase, body?.wallet_id as string | undefined, true)
    const { data: owner, error: ownerError } = await supabase
      .from('device_credits').select('apple_user_id').eq('device_id', wallet.walletId).maybeSingle()
    if (ownerError) throw ownerError
    if (!wallet.authenticated || !owner?.apple_user_id) {
      return json({ error: 'apple_sign_in_required', message: 'Apple로 로그인한 뒤 구매할 수 있어요.' }, 403)
    }

    stage = 'account_token'
    const { data: token, error: tokenError } = await supabase.rpc('credit_pack_account_token', { p_wallet_id: wallet.walletId })
    if (tokenError || typeof token !== 'string') throw tokenError ?? new Error('account_token_unavailable')
    if (action === 'account_token') return json({ account_token: token })

    const signed = body?.signed_transaction
    if (typeof signed !== 'string' || signed.length === 0 || signed.length > 64_000) {
      return json({ error: 'invalid_signed_transaction' }, 400)
    }
    const bundleId = Deno.env.get('APPLE_APP_BUNDLE_ID') ?? 'com.kingboard.app'

    stage = 'apple_signature_verification'
    const submitted = await verifyAppleTransactionJws(signed, bundleId) as unknown as Record<string, unknown>
    stage = 'apple_current_transaction'
    const current = await fetchCurrentAppleTransaction(
      String(submitted.transactionId ?? ''), bundleId, String(submitted.environment ?? ''))

    stage = 'claim_validation'
    let claim
    try {
      claim = validateCreditPackClaim({ submitted, current, expectedBundleId: bundleId, expectedAccountToken: token })
    } catch (error) {
      if (error instanceof CreditPackClaimError && error.code === 'transaction_revoked') {
        // Already refunded at Apple: record it so the purchase can never be granted later.
        const refundProduct = String(current.productId ?? '')
        await supabase.rpc('refund_credit_pack_once', {
          p_transaction_id: String(current.transactionId ?? ''), p_product_id: refundProduct,
          p_environment: String(current.environment ?? ''), p_notification_id: `claim:${diagnosticId}`,
        })
        return json({ result: 'refunded', credits: 0 })
      }
      if (error instanceof CreditPackClaimError) {
        console.warn(JSON.stringify({ category: 'credit_pack_claim', result: 'rejected', code: error.code, diagnosticId }))
        return json({ error: error.code, diagnostic_id: diagnosticId }, 409)
      }
      throw error
    }

    stage = 'grant'
    const { data, error } = await supabase.rpc('grant_credit_pack_once', {
      p_wallet_id: wallet.walletId,
      p_account_token: token,
      p_transaction_id: claim.transactionId,
      p_original_transaction_id: claim.originalTransactionId,
      p_product_id: claim.productId,
      p_environment: claim.environment,
    })
    if (error) {
      const code = rpcErrorCode(error)
      console.error(JSON.stringify({ category: 'credit_pack_claim', result: 'failed', code, diagnosticId }))
      return json({ error: code, diagnostic_id: diagnosticId }, code === 'grant_failed' ? 500 : 409)
    }
    const row = (Array.isArray(data) ? data[0] : data) as { result: string; credits: number; paid_credits: number | null }
    if (!row || !FINAL_RESULTS.has(row.result)) throw new Error('grant_result_unknown')
    console.log(JSON.stringify({ category: 'credit_pack_claim', result: row.result, product: claim.productId,
      environment: claim.environment, diagnosticId }))

    if (row.result === 'granted' || row.result === 'sandbox_limit') {
      const label = claim.credits.toLocaleString('ko-KR')
      const prefix = claim.environment === 'Sandbox' ? '🧪 시험 결제' : '💳 묶음 구매'
      await sendTelegram(row.result === 'granted'
        ? `${prefix} · ${label} 크레딧 지급`
        : `🧪 시험 결제 한도 초과 · ${label} 크레딧 미지급 (30일 3회)`, {
        supabase, alertType: 'credit_pack_purchase', idempotencyKey: `${claim.transactionId}:${row.result}`,
        metadata: { environment: claim.environment, product_id: claim.productId },
      }).catch(() => false)
    }
    return json({ result: row.result, credits: row.credits, paid_credits: row.paid_credits })
  } catch (error) {
    if (error instanceof WalletAccessError) return json({ error: 'wallet_access_rejected', message: error.message }, error.status)
    console.error(JSON.stringify({ category: 'credit_pack_claim', result: 'error', stage, diagnosticId,
      message: error instanceof Error ? error.message.slice(0, 200) : 'unknown' }))
    return json({ error: 'temporarily_unavailable', stage, diagnostic_id: diagnosticId }, 503)
  }
})
