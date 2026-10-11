import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'

const source = readFileSync(new URL('../wallet_link_v2/index.ts', import.meta.url), 'utf8')
const migration = readFileSync(new URL('../../../migrations/20261011164037_guard_guest_bonus_restore_and_record_outcome.sql', import.meta.url), 'utf8')
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

test('50 concurrent registrations remain recoverable; retries grant once and skip restored wallets', async () => {
  assert.equal(migration.match(/transaction_type in \('install_bonus', 'install_bonus_restore'\)/g)?.length, 3)
  let handler
  let lockOwner = null
  const bySecret = new Map()
  const byId = new Map()
  const marked = new Set()
  const ledger = new Map()
  const reasons = new Map()
  const auditEvents = []
  let recordFailure = null
  globalThis.Deno = {
    env: { get: key => ({
      WALLET_SESSIONS_ENABLED: 'true', WALLET_GUEST_V2_ENABLED: 'true',
      WALLET_DEVICECHECK_BONUS_ENABLED: 'true', SUPABASE_URL: 'https://example.invalid',
      SUPABASE_SERVICE_ROLE_KEY: 'test-only',
    })[key] },
    serve: fn => { handler = fn },
  }
  globalThis.__verifyAppleIdentityToken = async () => null
  globalThis.__verifyAppleSubscriptionRecord = async () => false
  globalThis.__verifyAppleSubscriptionRecordDetailed = async () => ({ verified: false })
  globalThis.__walletTokenHash = async () => 'b'.repeat(64)
  globalThis.__isBonusCanaryDevice = async token => {
    if (token === 'device-unavailable') throw Error('simulated DeviceCheck outage')
    return marked.has(token)
  }
  globalThis.__enrollBonusCanaryDevice = async token => { marked.add(token) }
  globalThis.__logSubscriptionAudit = () => {}
  globalThis.__subscriptionTransactionFingerprint = async () => 'f'.repeat(64)
  globalThis.__subscriptionWalletFingerprint = async () => 'e'.repeat(64)
  globalThis.__createClient = () => ({
    rpc: async (name, args) => {
      if (name === 'register_guest_wallet_v2') {
        let wallet = bySecret.get(args.p_secret_hash)
        if (!wallet) {
          wallet = { id: `v2:${String(bySecret.size + 1).padStart(36, '0')}`, balance: 0, state: 'pending', claim: null }
          bySecret.set(args.p_secret_hash, wallet)
          byId.set(wallet.id, wallet)
        }
        return { data: wallet.id, error: null }
      }
      if (name === 'acquire_guest_bonus_devicecheck_lock') {
        if (lockOwner) return { data: false, error: null }
        lockOwner = args.p_owner
        await new Promise(resolve => setTimeout(resolve, 2))
        return { data: true, error: null }
      }
      if (name === 'release_guest_bonus_devicecheck_lock') {
        assert.equal(lockOwner, args.p_owner)
        lockOwner = null
        return { data: null, error: null }
      }
      const wallet = byId.get(args.p_wallet_id)
      assert.ok(wallet, name)
      if (name === 'reserve_guest_install_bonus') {
        if (ledger.has(wallet.id)) return { data: 'granted', error: null }
        wallet.claim = 'pending'
        return { data: 'pending', error: null }
      }
      if (name === 'confirm_guest_install_bonus_devicecheck') {
        wallet.confirmed = true
        return { data: true, error: null }
      }
      if (name === 'complete_guest_install_bonus_guarded') {
        if (ledger.has(wallet.id)) return { data: false, error: null }
        if (!wallet.claim) return { data: false, error: null }
        assert.equal(wallet.confirmed, true)
        ledger.set(wallet.id, ['install_bonus'])
        wallet.balance += 500
        wallet.claim = 'granted'
        return { data: true, error: null }
      }
      if (name === 'record_guest_bonus_outcome') {
        if (recordFailure) {
          const failure = recordFailure
          recordFailure = null
          if (failure === 'throw') throw Error('private database detail')
          return { data: null, error: { code: 'P0001', message: 'private database detail' } }
        }
        const reason = ledger.has(wallet.id) ? null : args.p_reason
        reasons.set(wallet.id, reason)
        return { data: ledger.has(wallet.id) || reason === 'device_already_marked'
          ? 'complete' : reason === 'claim_needs_review' ? 'needs_review' : 'verification_pending', error: null }
      }
      throw Error(`Unexpected RPC: ${name}`)
    },
    from: table => {
      let id
      const query = {
        select: () => query,
        eq: (_column, value) => { id = value; return query },
        single: async () => {
          const wallet = byId.get(id)
          return { data: table === 'device_credits'
            ? { free_credits: wallet.balance, paid_credits: 0, apple_user_id: null }
            : { state: wallet.state }, error: null }
        },
        maybeSingle: async () => ({ data: byId.get(id)?.claim
          ? { state: byId.get(id).claim, verification_confirmed_at: byId.get(id).confirmed ? new Date().toISOString() : null }
          : null, error: null }),
      }
      return query
    },
  })
  const originalInfo = console.info
  console.info = message => {
    const event = JSON.parse(message)
    if (event.event === 'bonus_outcome_record_failed') auditEvents.push(event)
  }
  try {
    await import(`data:text/javascript,${encodeURIComponent(runnable)}#${crypto.randomUUID()}`)
    const register = async (n, token = `device-${n}`) => {
      const response = await handler(new Request('https://example.invalid/wallet_link_v2', {
        method: 'POST', body: JSON.stringify({ action: 'register', walletSecret: n.toString(16).padStart(64, '0'),
          ...(token ? { deviceToken: token } : {}) }),
      }))
      return { status: response.status, body: await response.json() }
    }
    const first = await Promise.all(Array.from({ length: 50 }, (_, n) => register(n + 1)))
    const first503 = first.filter(x => x.status === 503).length
    const orphaned = first.filter(x => x.status !== 201 || !x.body.walletId).length
    const initialPending = first.filter(x => x.body.bonusStatus === 'verification_pending').length
    assert.equal(first503, 0)
    assert.equal(orphaned, 0)
    assert.ok(first.some(x => x.body.bonusStatus === 'verification_pending'))
    const restored = byId.get(first[1].body.walletId)
    restored.balance = 500
    ledger.set(restored.id, ['install_bonus_restore'])
    let retryRounds = 0
    for (let attempt = 0; attempt < 50; attempt++) {
      const pending = first.map((_, n) => n + 1).filter(n => !ledger.has(first[n - 1].body.walletId))
      if (!pending.length) break
      await Promise.all(pending.map(n => register(n)))
      retryRounds += 1
    }
    const stillPending = [...byId.values()].filter(wallet => !ledger.has(wallet.id)).length
    const duplicateGrants = [...ledger.values()].filter(types => types.length > 1).length
    assert.equal(stillPending, 0)
    assert.equal(duplicateGrants, 0)
    assert.deepEqual(ledger.get(restored.id), ['install_bonus_restore'])
    assert.equal(byId.size, 50)
    assert.ok([...reasons.values()].every(reason => reason === null || reason === 'lock_busy'))
    const repeated = await register(1)
    assert.equal(repeated.status, 201)
    assert.equal(repeated.body.walletId, first[0].body.walletId)
    assert.equal(ledger.get(repeated.body.walletId).length, 1)
    marked.add('device-prior-install')
    const priorInstall = await register(51, 'device-prior-install')
    assert.equal(priorInstall.body.bonusStatus, 'complete')
    assert.equal(priorInstall.body.freeCredits, 0)
    assert.equal(reasons.get(priorInstall.body.walletId), 'device_already_marked')
    const missingToken = await register(52, null)
    assert.equal(missingToken.body.bonusStatus, 'verification_pending')
    assert.equal(reasons.get(missingToken.body.walletId), 'no_device_token')
    const unavailable = await register(53, 'device-unavailable')
    assert.equal(unavailable.body.bonusStatus, 'verification_pending')
    assert.equal(reasons.get(unavailable.body.walletId), 'devicecheck_unavailable')
    for (const failure of ['error', 'throw']) {
      const n = failure === 'error' ? 54 : 55
      recordFailure = failure
      const granted = await register(n)
      assert.equal(granted.status, 201)
      assert.equal(granted.body.freeCredits, 500)
      assert.equal(granted.body.bonusStatus, 'complete')
      assert.deepEqual(ledger.get(granted.body.walletId), ['install_bonus'])
      const retried = await register(n)
      assert.equal(retried.status, 201)
      assert.equal(retried.body.walletId, granted.body.walletId)
      assert.equal(retried.body.freeCredits, 500)
      assert.deepEqual(ledger.get(granted.body.walletId), ['install_bonus'])
    }
    assert.equal(auditEvents.length, 2)
    assert.ok(auditEvents.every(event => !JSON.stringify(event).includes('private database detail')))
    console.log(JSON.stringify({ simulatedConcurrentRegistrations: 50, emptyWalletResponses: orphaned,
      busy503: first503, duplicateGrants, initialPending, retryRounds,
      pendingAfterRetries: stillPending }))
  } finally {
    console.info = originalInfo
  }
})
