// Receives Server-Side Verification callbacks directly from Google AdMob.
// Configured at AdMob Console → Apps → [App] → Ad units → [Unit] → SSV URL.
// Google calls this with the original query string + signature + key_id.
// We verify the ECDSA signature against Google's published keys, then grant credits.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Reward split by install date: legacy users (installed before 2026-09-20 KST)
// keep 200 credits per ad; new users get 100. Keep this cutoff in sync with
// get_credits (which drives the in-app button label).
const REWARD_CUTOFF = Date.parse('2026-09-19T15:00:00.000Z') // 2026-09-20 00:00 KST
const LEGACY_REWARD = 200
const NEW_REWARD = 100
import { verifyAdMobCallback } from '../_shared/admob_ssv.ts'

Deno.serve(async (req: Request) => {
  if (req.method !== 'GET') {
    return new Response('method not allowed', { status: 405 })
  }

  try {
    const url = new URL(req.url)
    const verification = await verifyAdMobCallback(url.search)

    if (!verification.valid) {
      console.warn('[admob_ssv_callback] invalid signature', url.search)
      return new Response('invalid signature', { status: 403 })
    }

    const deviceId = verification.customData ?? verification.userId
    const transactionId = verification.transactionId

    // AdMob sends a verification ping (no custom_data/user_id) when saving
    // the SSV URL in the console. Signature is valid but there's no account
    // to credit — return 200 so the console accepts the URL.
    if (!deviceId || !transactionId) {
      console.log('[admob_ssv_callback] verification ping — no credits granted')
      return new Response('ok', { status: 200 })
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // Decide the reward by the device's install date. Unknown / first-ever
    // device (no row yet) defaults to the new-user amount (100).
    const { data: devRow, error: walletError } = await supabase
      .from('device_credits')
      .select('created_at')
      .eq('device_id', deviceId)
      .maybeSingle()
    if (walletError) throw walletError
    // Retries must keep the first verified transaction's wallet and amount,
    // even when the source wallet has since been linked or removed.
    const { data: priorGrant, error: priorGrantError } = await supabase
      .from('credit_transactions')
      .select('device_id, paid_delta')
      .eq('transaction_type', 'admob_ssv')
      .eq('idempotency_key', transactionId)
      .maybeSingle()
    if (priorGrantError) throw priorGrantError
    let grantWalletId = priorGrant?.device_id ?? deviceId
    if (Deno.env.get('WALLET_SESSIONS_ENABLED') === 'true') {
      const { data: alias, error: aliasError } = await supabase
        .from('credit_wallet_aliases')
        .select('canonical_wallet_id')
        .eq('source_wallet_id', deviceId)
        .maybeSingle()
      if (aliasError) throw aliasError
      grantWalletId = priorGrant?.device_id ?? alias?.canonical_wallet_id ?? deviceId
    }
    const installedAt = Date.parse(devRow?.created_at ?? '')
    const rewardCredits = priorGrant?.paid_delta ??
      (Number.isFinite(installedAt) && installedAt < REWARD_CUTOFF ? LEGACY_REWARD : NEW_REWARD)

    const { error: grantError } = await supabase.rpc('grant_ad_credits_once', {
      p_device_id: grantWalletId,
      p_amount: rewardCredits,
      p_transaction_id: transactionId,
      p_metadata: {
        transactionId,
        adUnit: verification.adUnit,
        rewardAmount: verification.rewardAmount,
        originalWalletId: deviceId,
      },
    })
    if (grantError) throw grantError

    return new Response('ok', { status: 200 })
  } catch (e) {
    console.error('[admob_ssv_callback]', e)
    return new Response('error', { status: 500 })
  }
})
