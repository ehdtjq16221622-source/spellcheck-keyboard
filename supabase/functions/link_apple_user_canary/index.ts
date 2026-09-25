// Owner-only Apple wallet confirmation. Optionally prepares a separate
// zero-credit guest wallet for logout without moving or granting credits.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { verifyAppleIdentityToken } from '../_shared/apple_auth.ts'

const BUNDLE_ID = 'com.kingboard.app'
const TEST_APPLE_USER_ID = '000746.03654e929ba94917a878e09aec00402c.1144'

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return respond({ error: 'Not found.' }, 404)

  try {
    const body = await req.json()
    if (typeof body?.identityToken !== 'string' || body.identityToken.length > 16_384) {
      return respond({ error: 'Invalid identity token.' }, 401)
    }

    const identity = await verifyAppleIdentityToken(body.identityToken, BUNDLE_ID)
    if (!identity || identity.sub !== TEST_APPLE_USER_ID || body.appleUserId !== identity.sub) {
      return respond({ error: 'Not found.' }, 404)
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )
    const { data: rows, error } = await supabase
      .from('device_credits')
      .select('device_id, free_credits, paid_credits, subscription_credits')
      .eq('apple_user_id', identity.sub)
      .limit(2)
    if (error) throw error
    if (!rows || rows.length !== 1) {
      return respond({ error: 'Apple wallet requires review.' }, 409)
    }

    let guestWalletId: string | null = null
    let guestFreeCredits = 0
    let guestPaidCredits = 0
    if (body.guestWalletId !== undefined) {
      if (typeof body.guestWalletId !== 'string' ||
          !/^canary-guest:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(body.guestWalletId)) {
        return respond({ error: 'Invalid guest wallet ID.' }, 400)
      }
      guestWalletId = body.guestWalletId
      const { error: createError } = await supabase.from('device_credits').upsert({
        device_id: guestWalletId,
        credits: 0,
        free_credits: 0,
        paid_credits: 0,
        subscription_credits: 0,
      }, { onConflict: 'device_id', ignoreDuplicates: true })
      if (createError) throw createError
      const { data: guest, error: guestError } = await supabase.from('device_credits')
        .select('device_id, apple_user_id, free_credits, paid_credits, subscription_credits')
        .eq('device_id', guestWalletId).single()
      if (guestError) throw guestError
      if (guest.apple_user_id !== null) return respond({ error: 'Guest wallet requires review.' }, 409)
      guestFreeCredits = guest.free_credits
      guestPaidCredits = guest.paid_credits + guest.subscription_credits
    }

    const wallet = rows[0]
    const paid = wallet.paid_credits + wallet.subscription_credits
    return respond({
      free_credits_remaining: wallet.free_credits,
      paid_credits_remaining: paid,
      credits_remaining: wallet.free_credits + paid,
      canonical_device_id: wallet.device_id,
      logout_guest_wallet_id: guestWalletId,
      logout_guest_free_credits: guestFreeCredits,
      logout_guest_paid_credits: guestPaidCredits,
      migrated: false,
      granted_install_bonus: false,
    })
  } catch (error) {
    console.error('[link_apple_user_canary]', error)
    return respond({ error: 'Unable to confirm Apple wallet.' }, 500)
  }
})
