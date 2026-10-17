import { importPKCS8, SignJWT } from 'https://esm.sh/jose@5.6.3'

// Admin helper: calls the App Store Server API "Request a Test Notification"
// endpoint. Apple then delivers a TEST notification to our registered webhook
// (apple_notifications), which pings Telegram. Confirms the whole chain.
//
// Requires secrets: APPLE_IAP_KEY_B64 (base64 of the .p8), APPLE_IAP_KEY_ID,
// APPLE_IAP_ISSUER_ID.

const PROD = 'https://api.storekit.itunes.apple.com/inApps/v1/notifications/test'
const SANDBOX = 'https://api.storekit-sandbox.itunes.apple.com/inApps/v1/notifications/test'

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
    const keyB64 = Deno.env.get('APPLE_IAP_KEY_B64')
    const keyId = Deno.env.get('APPLE_IAP_KEY_ID')
    const issuerId = Deno.env.get('APPLE_IAP_ISSUER_ID')
    const bundleId = Deno.env.get('APPLE_APP_BUNDLE_ID') ?? 'com.kingboard.app'
    if (!keyB64 || !keyId || !issuerId) {
      return new Response(JSON.stringify({ error: 'missing APPLE_IAP secrets' }), { status: 400 })
    }

    const pem = atob(keyB64) // .p8 is PEM text; base64 decode restores it
    const key = await importPKCS8(pem, 'ES256')
    const now = Math.floor(Date.now() / 1000)
    const jwt = await new SignJWT({ bid: bundleId })
      .setProtectedHeader({ alg: 'ES256', kid: keyId, typ: 'JWT' })
      .setIssuer(issuerId)
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .setAudience('appstoreconnect-v1')
      .sign(key)

    // Which environment: ?env=sandbox uses the sandbox endpoint.
    const url = new URL(req.url)
    const endpoint = url.searchParams.get('env') === 'sandbox' ? SANDBOX : PROD

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}` },
    })
    const text = await res.text()

    return new Response(
      JSON.stringify({ endpoint, status: res.status, response: text }, null, 2),
      { headers: { 'Content-Type': 'application/json' } }
    )
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 })
  }
})
