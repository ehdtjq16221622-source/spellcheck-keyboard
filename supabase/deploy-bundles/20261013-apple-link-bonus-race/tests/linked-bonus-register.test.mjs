import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'

const source = readFileSync(new URL('../wallet_link_v2/index.ts', import.meta.url), 'utf8')
const runnable = stripTypeScriptTypes(source
  .replace(/^import \{ createClient \} from .*$/m, 'const createClient = globalThis.__createClient;')
  .replace(/^import \{ verifyAppleIdentityToken \} from .*$/m,
    'const verifyAppleIdentityToken = globalThis.__verifyAppleIdentityToken;')
  .replace(/^import \{[\s\S]*?\} from .*apple_subscription_status\.ts'$/m,
    'const verifyAppleSubscriptionRecord = globalThis.__verifyAppleSubscriptionRecord; const verifyAppleSubscriptionRecordDetailed = globalThis.__verifyAppleSubscriptionRecordDetailed;')
  .replace(/^import \{ walletTokenHash \} from .*$/m, 'const walletTokenHash = globalThis.__walletTokenHash;')
  .replace(/^import \{ enrollBonusCanaryDevice, isBonusCanaryDevice \} from .*$/m,
    'const enrollBonusCanaryDevice = globalThis.__enrollBonusCanaryDevice; const isBonusCanaryDevice = globalThis.__isBonusCanaryDevice;')
  .replace(/^import \{[\s\S]*?\} from .*subscription_audit\.ts'$/m,
    'const logSubscriptionAudit = globalThis.__logSubscriptionAudit; const subscriptionTransactionFingerprint = globalThis.__subscriptionTransactionFingerprint; const subscriptionWalletFingerprint = globalThis.__subscriptionWalletFingerprint;'))

async function registerLinkedWallet(otherAppleBonus, lateAppleBonus = false) {
  let handler
  let grants = 0
  let deviceEnrollments = 0
  const walletId = 'v2:00000000-0000-0000-0000-000000000001'
  globalThis.Deno = {
    env: { get: (key) => ({
      WALLET_SESSIONS_ENABLED: 'true', WALLET_GUEST_V2_ENABLED: 'true',
      WALLET_DEVICECHECK_BONUS_ENABLED: 'true', SUPABASE_URL: 'https://example.invalid',
      SUPABASE_SERVICE_ROLE_KEY: 'test-only',
    })[key] },
    serve: (fn) => { handler = fn },
  }
  globalThis.__verifyAppleIdentityToken = async () => null
  globalThis.__verifyAppleSubscriptionRecord = async () => false
  globalThis.__verifyAppleSubscriptionRecordDetailed = async () => ({ verified: false })
  globalThis.__walletTokenHash = async (value) => value
  globalThis.__enrollBonusCanaryDevice = async () => { deviceEnrollments++ }
  globalThis.__isBonusCanaryDevice = async () => false
  globalThis.__logSubscriptionAudit = () => {}
  globalThis.__subscriptionTransactionFingerprint = async () => ''
  globalThis.__subscriptionWalletFingerprint = async () => ''
  globalThis.__createClient = () => ({
    rpc: async (name) => ({
      data: name === 'register_guest_wallet_v2' ? walletId
        : name === 'reserve_guest_install_bonus' ? (otherAppleBonus ? 'account_bonus_exists' : 'pending')
          : name === 'complete_guest_install_bonus_guarded' ? (lateAppleBonus ? false : (++grants, true)) : true,
      error: null,
    }),
    from: (table) => {
      const query = {
        eq: () => query,
        in: () => query,
        limit: async () => ({ data: [], error: null }),
        single: async () => ({ data: table === 'device_credits'
          ? { free_credits: grants * 500, paid_credits: 0, apple_user_id: 'apple-owner' }
          : { state: 'linked' }, error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
      }
      return { select: () => query }
    },
  })
  await import(`data:text/javascript,${encodeURIComponent(runnable)}#${crypto.randomUUID()}`)
  const info = console.info
  console.info = () => {}
  try {
    const response = await handler(new Request('https://example.invalid/wallet_link_v2', {
      method: 'POST', body: JSON.stringify({ action: 'register', walletSecret: 'a'.repeat(64), deviceToken: 'test-device' }),
    }))
    return { status: response.status, body: await response.json(), grants, deviceEnrollments }
  } finally { console.info = info }
}

test('Apple link overtakes registration without a 500 or exposed Apple balance', async () => {
  const result = await registerLinkedWallet(false)
  assert.equal(result.status, 201)
  assert.equal(result.body.state, 'linked')
  assert.equal(result.body.bonusStatus, 'complete')
  assert.equal(result.body.freeCredits, 0)
  assert.equal(result.grants, 1)
  assert.equal(result.deviceEnrollments, 1)
})

test('other Apple bonus is review-only, without DeviceCheck enrollment or grant', async () => {
  const result = await registerLinkedWallet(true)
  assert.equal(result.status, 201)
  assert.equal(result.body.bonusStatus, 'needs_review')
  assert.equal(result.grants, 0)
  assert.equal(result.deviceEnrollments, 0)
})

test('another grant arriving after reservation is reported for review, not as paid', async () => {
  const result = await registerLinkedWallet(false, true)
  assert.equal(result.status, 201)
  assert.equal(result.body.bonusStatus, 'needs_review')
  assert.equal(result.grants, 0)
})
