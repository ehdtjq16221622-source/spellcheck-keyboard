const ANDROID_PUBLISHER_SCOPE = 'https://www.googleapis.com/auth/androidpublisher'
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token'

type ServiceAccount = {
  client_email: string
  private_key: string
  token_uri?: string
}

type SubscriptionLineItem = {
  productId?: string
  expiryTime?: string
  latestSuccessfulOrderId?: string
}

type SubscriptionResponse = {
  subscriptionState?: string
  acknowledgementState?: string
  lineItems?: SubscriptionLineItem[]
  externalAccountIdentifiers?: {
    obfuscatedExternalAccountId?: string
  }
}

export type VerifiedSubscription = {
  active: boolean
  state: string
  expiryTimeMillis: number | null
  cycleKey: string | null
  orderId: string | null
  obfuscatedAccountId: string | null
}

function base64UrlEncode(input: ArrayBuffer | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input)
  let binary = ''
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte)
  })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const body = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s+/g, '')
  const binary = atob(body)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}

async function signJwt(assertion: string, privateKey: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(privateKey),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(assertion)
  )
  return base64UrlEncode(signature)
}

async function getAccessToken(): Promise<string> {
  const raw = Deno.env.get('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON')
  if (!raw) {
    throw new Error('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON secret is missing.')
  }

  const account = JSON.parse(raw) as ServiceAccount
  const tokenUri = account.token_uri ?? DEFAULT_TOKEN_URI
  const now = Math.floor(Date.now() / 1000)
  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = base64UrlEncode(
    JSON.stringify({
      iss: account.client_email,
      scope: ANDROID_PUBLISHER_SCOPE,
      aud: tokenUri,
      iat: now,
      exp: now + 3600,
    })
  )
  const signingInput = `${header}.${claims}`
  const signature = await signJwt(signingInput, account.private_key)
  const assertion = `${signingInput}.${signature}`

  const response = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  })

  const json = await response.json()
  if (!response.ok || !json.access_token) {
    throw new Error(json.error_description ?? json.error ?? 'Failed to get Google access token.')
  }

  return json.access_token as string
}

function parseExpiry(lineItems: SubscriptionLineItem[] = [], productId: string): SubscriptionLineItem | null {
  const matched = lineItems.find((item) => item.productId === productId) ?? lineItems[0]
  return matched ?? null
}

function toMillis(value?: string): number | null {
  if (!value) return null
  const millis = Date.parse(value)
  return Number.isNaN(millis) ? null : millis
}

function isActiveState(state: string, expiryTimeMillis: number | null): boolean {
  if (state === 'SUBSCRIPTION_STATE_ACTIVE' || state === 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD') {
    return true
  }
  if (state === 'SUBSCRIPTION_STATE_CANCELED' && expiryTimeMillis != null) {
    return expiryTimeMillis > Date.now()
  }
  return false
}

export async function verifySubscription(
  packageName: string,
  productId: string,
  purchaseToken: string
): Promise<VerifiedSubscription> {
  const accessToken = await getAccessToken()
  const response = await fetch(
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}` +
      `/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  )

  const json = (await response.json()) as SubscriptionResponse & { error?: { message?: string } }
  if (!response.ok) {
    throw new Error(json.error?.message ?? 'Failed to verify subscription with Google Play.')
  }

  const lineItem = parseExpiry(json.lineItems, productId)
  const expiryTimeMillis = toMillis(lineItem?.expiryTime)
  const state = json.subscriptionState ?? 'SUBSCRIPTION_STATE_UNSPECIFIED'

  return {
    active: isActiveState(state, expiryTimeMillis),
    state,
    expiryTimeMillis,
    cycleKey: lineItem?.expiryTime ?? null,
    orderId: lineItem?.latestSuccessfulOrderId ?? null,
    obfuscatedAccountId: json.externalAccountIdentifiers?.obfuscatedExternalAccountId ?? null,
  }
}
