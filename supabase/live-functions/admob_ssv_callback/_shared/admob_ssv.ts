// AdMob Server-Side Verification (SSV) signature verifier.
// Google docs: https://developers.google.com/admob/ios/ssv

const GOOGLE_KEYS_URL = 'https://www.gstatic.com/admob/reward/verifier-keys.json'
const KEY_CACHE_TTL_MS = 24 * 60 * 60 * 1000

interface VerifierKeyResponse {
  keys: Array<{ keyId: number; pem: string; base64: string }>
}

let cachedKeys: Map<number, CryptoKey> | null = null
let cacheExpiry = 0

export interface SsvVerification {
  valid: boolean
  customData?: string
  userId?: string
  transactionId?: string
  rewardAmount?: number
  adUnit?: string
}

export async function verifyAdMobCallback(searchOrQuery: string): Promise<SsvVerification> {
  const q = searchOrQuery.startsWith('?') ? searchOrQuery.slice(1) : searchOrQuery
  const sigIndex = q.indexOf('&signature=')
  if (sigIndex < 0) return { valid: false }

  // Google signs the decoded query (URI.getQuery), preserving parameter order.
  // Decode only for verification; parse values from the original query below.
  let message: string
  try {
    message = decodeURIComponent(q.slice(0, sigIndex))
  } catch {
    return { valid: false }
  }
  const tail = new URLSearchParams(q.slice(sigIndex + 1))
  const signatureB64 = tail.get('signature')
  const keyIdRaw = tail.get('key_id')
  if (!signatureB64 || !keyIdRaw) return { valid: false }

  const keyId = parseInt(keyIdRaw, 10)
  if (!Number.isFinite(keyId)) return { valid: false }

  const keys = await loadKeys()
  const publicKey = keys.get(keyId)
  if (!publicKey) return { valid: false }

  let signatureRaw: Uint8Array
  try {
    const der = base64UrlDecode(signatureB64)
    signatureRaw = derSignatureToRaw(der, 32)
  } catch {
    return { valid: false }
  }

  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: { name: 'SHA-256' } },
    publicKey,
    new Uint8Array(signatureRaw),
    new TextEncoder().encode(message)
  )
  if (!valid) return { valid: false }

  const params = new URLSearchParams(q)
  return {
    valid: true,
    customData: params.get('custom_data') ?? undefined,
    userId: params.get('user_id') ?? undefined,
    transactionId: params.get('transaction_id') ?? undefined,
    rewardAmount: params.get('reward_amount')
      ? parseInt(params.get('reward_amount')!, 10)
      : undefined,
    adUnit: params.get('ad_unit') ?? undefined,
  }
}

async function loadKeys(): Promise<Map<number, CryptoKey>> {
  if (cachedKeys && Date.now() < cacheExpiry) return cachedKeys

  const res = await fetch(GOOGLE_KEYS_URL)
  if (!res.ok) throw new Error(`verifier-keys fetch failed: ${res.status}`)
  const data = (await res.json()) as VerifierKeyResponse

  const map = new Map<number, CryptoKey>()
  for (const k of data.keys) {
    try {
      const der = new Uint8Array(pemToDer(k.pem))
      const cryptoKey = await crypto.subtle.importKey(
        'spki',
        der,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify']
      )
      map.set(k.keyId, cryptoKey)
    } catch (e) {
      console.error('[admob_ssv] import key failed', k.keyId, e)
    }
  }

  cachedKeys = map
  cacheExpiry = Date.now() + KEY_CACHE_TTL_MS
  return map
}

function pemToDer(pem: string): Uint8Array {
  const b64 = pem
    .replace(/-----BEGIN [A-Z ]+-----/g, '')
    .replace(/-----END [A-Z ]+-----/g, '')
    .replace(/\s+/g, '')
  return base64Decode(b64)
}

function base64Decode(b64: string): Uint8Array {
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return arr
}

function base64UrlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
  return base64Decode(padded)
}

// DER ECDSA signature → raw IEEE P1363 (r||s) for Web Crypto API.
function derSignatureToRaw(der: Uint8Array, fieldSize: number): Uint8Array {
  if (der[0] !== 0x30) throw new Error('invalid DER')
  let offset = 2
  if (der[1] & 0x80) offset = 2 + (der[1] & 0x7f)

  if (der[offset] !== 0x02) throw new Error('expected INTEGER for r')
  const rLen = der[offset + 1]
  let r = der.slice(offset + 2, offset + 2 + rLen)
  if (r[0] === 0x00) r = r.slice(1)
  offset += 2 + rLen

  if (der[offset] !== 0x02) throw new Error('expected INTEGER for s')
  const sLen = der[offset + 1]
  let s = der.slice(offset + 2, offset + 2 + sLen)
  if (s[0] === 0x00) s = s.slice(1)

  const out = new Uint8Array(fieldSize * 2)
  out.set(r, fieldSize - r.length)
  out.set(s, fieldSize * 2 - s.length)
  return out
}
