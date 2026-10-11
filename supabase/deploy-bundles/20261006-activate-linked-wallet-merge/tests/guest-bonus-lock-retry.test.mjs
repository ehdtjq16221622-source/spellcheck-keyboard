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

async function simulateRegistrations(count, deviceCheckMs, sharedSecret = false) {
  let handler
  let lockOwner = null
  let attempts = 0
  const wallets = new Map()
  const grants = new Map()
  const marked = new Set()
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
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
  globalThis.__enrollBonusCanaryDevice = async (token) => { marked.add(token) }
  globalThis.__isBonusCanaryDevice = async (token) => {
    await delay(deviceCheckMs)
    return marked.has(token)
  }
  globalThis.__logSubscriptionAudit = () => {}
  globalThis.__subscriptionTransactionFingerprint = async () => ''
  globalThis.__subscriptionWalletFingerprint = async () => ''
  globalThis.__createClient = () => ({
    rpc: async (name, args) => {
      if (name === 'register_guest_wallet_v2') {
        if (!wallets.has(args.p_secret_hash)) wallets.set(args.p_secret_hash, `v2:${crypto.randomUUID()}`)
        return { data: wallets.get(args.p_secret_hash), error: null }
      }
      if (name === 'acquire_guest_bonus_devicecheck_lock') {
        attempts++
        if (lockOwner !== null) return { data: false, error: null }
        lockOwner = args.p_owner
        return { data: true, error: null }
      }
      if (name === 'release_guest_bonus_devicecheck_lock') {
        assert.equal(lockOwner, args.p_owner)
        lockOwner = null
        return { data: null, error: null }
      }
      if (name === 'complete_guest_install_bonus_guarded') {
        if (grants.has(args.p_wallet_id)) return { data: false, error: null }
        grants.set(args.p_wallet_id, 1)
        return { data: true, error: null }
      }
      return { data: name === 'reserve_guest_install_bonus' ? 'pending' : true, error: null }
    },
    from: (table) => {
      let walletId
      const query = {
        eq: (_field, value) => { walletId = value; return query },
        single: async () => ({ data: table === 'device_credits'
          ? { free_credits: (grants.get(walletId) ?? 0) * 500, paid_credits: 0, apple_user_id: null }
          : { state: 'active' }, error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
      }
      return { select: () => query }
    },
  })
  await import(`data:text/javascript,${encodeURIComponent(runnable)}#${crypto.randomUUID()}`)
  const originalInfo = console.info
  console.info = () => {}
  try {
    const statuses = await Promise.all(Array.from({ length: count }, async (_, i) => {
      const secret = sharedSecret ? 'a'.repeat(64) : i.toString(16).padStart(64, '0')
      const response = await handler(new Request('https://example.invalid/wallet_link_v2', {
        method: 'POST', body: JSON.stringify({ action: 'register', walletSecret: secret,
          deviceToken: sharedSecret ? 'same-device' : `device-${i}` }),
      }))
      return response.status
    }))
    return { statuses, wallets: wallets.size, grants: grants.size,
      duplicateGrants: [...grants.values()].filter((n) => n > 1).length,
      emptyWallets: wallets.size - grants.size, attempts }
  } finally {
    console.info = originalInfo
  }
}

test('50 concurrent registrations wait for the same lock without duplicate grants', async (t) => {
  const result = await simulateRegistrations(50, 25)
  assert.equal(result.statuses.filter((status) => status === 201).length, 50)
  assert.equal(result.statuses.filter((status) => status === 503).length, 0)
  assert.equal(result.wallets, 50)
  assert.equal(result.emptyWallets, 0)
  assert.equal(result.duplicateGrants, 0)
  assert.ok(result.attempts > 50)
  t.diagnostic(JSON.stringify({ success: 50, busy503: 0, emptyWallets: result.emptyWallets,
    duplicateGrants: result.duplicateGrants, attempts: result.attempts }))
})

test('50 registrations under sustained contention stop waiting after eight seconds', async (t) => {
  const result = await simulateRegistrations(50, 300)
  assert.ok(result.statuses.filter((status) => status === 503).length > 0)
  assert.equal(result.statuses.filter((status) => status === 201).length +
    result.statuses.filter((status) => status === 503).length, 50)
  assert.equal(result.duplicateGrants, 0)
  assert.equal(result.emptyWallets, result.statuses.filter((status) => status === 503).length)
  t.diagnostic(JSON.stringify({ success: result.statuses.filter((status) => status === 201).length,
    busy503: result.statuses.filter((status) => status === 503).length,
    emptyWallets: result.emptyWallets, duplicateGrants: result.duplicateGrants,
    attempts: result.attempts }))
})

test('50 retries with the same wallet secret do not create or grant another wallet', async (t) => {
  const result = await simulateRegistrations(50, 25, true)
  assert.equal(result.statuses.filter((status) => status === 201).length, 50)
  assert.equal(result.wallets, 1)
  assert.equal(result.grants, 1)
  assert.equal(result.duplicateGrants, 0)
  t.diagnostic(JSON.stringify({ success: 50, wallets: result.wallets,
    grants: result.grants, duplicateGrants: result.duplicateGrants }))
})
