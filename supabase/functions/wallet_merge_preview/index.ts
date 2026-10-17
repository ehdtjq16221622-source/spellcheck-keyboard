// Read-only account audit for the future wallet merge. This endpoint is inert
// unless a specific Apple subject is allowlisted in server-side secrets.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { verifyAppleIdentityToken } from '../_shared/apple_auth.ts'

const BUNDLE_ID = 'com.kingboard.app'

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return response({ error: 'Not found.' }, 404)

  const allowed = new Set(
    (Deno.env.get('WALLET_MERGE_PREVIEW_APPLE_IDS') ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  )
  if (allowed.size === 0) return response({ error: 'Not found.' }, 404)

  try {
    const body = await req.json()
    const token = body?.identityToken
    if (typeof token !== 'string' || token.length > 16_384) {
      return response({ error: 'Invalid identity token.' }, 401)
    }

    const identity = await verifyAppleIdentityToken(token, BUNDLE_ID)
    if (!identity || !allowed.has(identity.sub)) {
      return response({ error: 'Not found.' }, 404)
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )
    const { data: linked, error: linkedError } = await supabase
      .from('device_credits')
      .select('device_id, free_credits, paid_credits, subscription_credits')
      .eq('apple_user_id', identity.sub)
    if (linkedError) throw linkedError

    const localRows = (linked ?? []).filter((row) => row.device_id !== identity.sub)
    let recordedFreeUse = false
    let otherBalanceNeedsReview = false
    for (const row of localRows) {
      const { data: use, error: useError } = await supabase
        .from('credit_transactions')
        .select('id')
        .eq('device_id', row.device_id)
        .lt('free_delta', 0)
        .limit(1)
      if (useError) throw useError
      recordedFreeUse ||= (use?.length ?? 0) > 0
      otherBalanceNeedsReview ||= row.paid_credits > 0 || row.subscription_credits > 0
    }

    const { data: appleUse, error: appleUseError } = await supabase
      .from('credit_transactions')
      .select('id')
      .eq('device_id', identity.sub)
      .lt('free_delta', 0)
      .limit(1)
    if (appleUseError) throw appleUseError
    recordedFreeUse ||= (appleUse?.length ?? 0) > 0

    // Missing historical transactions cannot prove that the bonus was unused.
    // This function never grants, deducts, links, deletes, or moves credits.
    return response({
      linkedDeviceWallets: localRows.length,
      recordedFreeUse,
      historicalFreeUseUncertain: !recordedFreeUse,
      automaticFreeTransferAllowed: false,
      otherBalanceNeedsReview,
      mergeEnabled: false,
    })
  } catch (error) {
    console.error('[wallet_merge_preview]', error)
    return response({ error: 'Unable to inspect wallet.' }, 500)
  }
})

