import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'

const path = new URL('../wallet_link_v2/index.ts', import.meta.url)
const source = readFileSync(path, 'utf8')
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

async function activateSession({ autoMerge = true, mergeError = null, alias = null,
  aliasAfterConflict = null } = {}) {
  let handler
  const calls = []
  const auditEvents = []
  let aliasReads = 0
  globalThis.Deno = {
    env: { get: (key) => ({
      WALLET_SESSIONS_ENABLED: 'true',
      WALLET_GUEST_V2_ENABLED: 'true',
      WALLET_LINK_V2_ENABLED: 'true',
      WALLET_LINK_V2_ALL_USERS_ENABLED: 'true',
      WALLET_AUTO_MERGE_ALL_USERS_ENABLED: autoMerge ? 'true' : 'false',
      WALLET_LEGACY_MERGE_ENABLED: 'true',
      SUPABASE_URL: 'https://example.invalid',
      SUPABASE_SERVICE_ROLE_KEY: 'test-only',
    })[key] },
    serve: (fn) => { handler = fn },
  }
  globalThis.__verifyAppleIdentityToken = async () => ({ sub: 'apple-sub' })
  globalThis.__verifyAppleSubscriptionRecord = async () => false
  globalThis.__verifyAppleSubscriptionRecordDetailed = async () => ({ verified: false })
  globalThis.__walletTokenHash = async () => 'b'.repeat(64)
  globalThis.__enrollBonusCanaryDevice = async () => {}
  globalThis.__isBonusCanaryDevice = async () => false
  globalThis.__logSubscriptionAudit = () => {}
  globalThis.__subscriptionTransactionFingerprint = async () => 'f'.repeat(64)
  globalThis.__subscriptionWalletFingerprint = async () => 'e'.repeat(64)
  globalThis.__createClient = () => ({
    from: (table) => {
      const query = {
        eq: () => query,
        maybeSingle: async () => {
          if (table === 'credit_wallet_sessions') {
            return { data: { apple_sub: 'apple-sub', wallet_id: 'v2:canonical',
              expires_at: new Date(Date.now() + 60_000).toISOString(), revoked_at: null }, error: null }
          }
          aliasReads += 1
          return { data: aliasReads === 1 ? alias : aliasAfterConflict, error: null }
        },
      }
      return { select: () => query }
    },
    rpc: async (name, args) => {
      calls.push({ name, args })
      if (name === 'merge_linked_apple_subject_wallets_once' && mergeError) {
        return { data: null, error: mergeError }
      }
      if (name === 'activate_apple_wallet_session') return { data: 'v2:canonical', error: null }
      return { data: [{ decision: 'merged', canonical_wallet_id: 'v2:canonical',
        free_credits_remaining: 500, paid_credits_remaining: 0 }], error: null }
    },
  })

  const originalInfo = console.info
  console.info = (message) => {
    try { auditEvents.push(JSON.parse(message)) } catch {}
  }
  try {
    await import(`data:text/javascript,${encodeURIComponent(runnable)}#${crypto.randomUUID()}`)
    const response = await handler(new Request('https://example.invalid/wallet_link_v2', {
      method: 'POST',
      body: JSON.stringify({ action: 'activate_session', identityToken: 'verified-token',
        sessionToken: 'c'.repeat(64) }),
    }))
    return { status: response.status, body: await response.json(), calls, auditEvents }
  } finally {
    console.info = originalInfo
  }
}

test('activation merges the Apple-subject wallet through the existing idempotent RPC', async () => {
  const result = await activateSession()
  assert.equal(result.status, 200)
  assert.equal(result.body.state, 'active')
  assert.equal(result.body.linkedMerge.decision, 'merged')
  assert.deepEqual(result.calls.map((call) => call.name), [
    'activate_apple_wallet_session', 'merge_linked_apple_subject_wallets_once',
  ])
  assert.equal(result.calls[1].args.p_apple_sub, 'apple-sub')
  assert.equal(result.calls[1].args.p_token_hash, 'b'.repeat(64))
  assert.equal(result.calls[1].args.p_request_id,
    `linked-merge:auto-v1:${await crypto.subtle.digest('SHA-256', new TextEncoder().encode('apple-sub'))
      .then((digest) => Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(''))}`)
})

test('activation does not invoke the merge when the all-user auto-merge flag is off', async () => {
  const result = await activateSession({ autoMerge: false })
  assert.equal(result.status, 200)
  assert.equal('linkedMerge' in result.body, false)
  assert.deepEqual(result.calls.map((call) => call.name), ['activate_apple_wallet_session'])
})

test('an exact no-source result is reported without treating activation as a failure', async () => {
  const result = await activateSession({ mergeError: {
    code: 'P0001', message: 'Second wallet does not exist',
  } })
  assert.equal(result.status, 200)
  assert.equal(result.body.linkedMerge.decision, 'no_linked_source')
})

test('review-required merge outcomes stay explicit and do not bypass the DB review gate', async () => {
  const result = await activateSession({ mergeError: {
    code: 'P0001', message: 'Second wallet subscription requires transaction review',
  } })
  assert.equal(result.status, 200)
  assert.equal(result.body.linkedMerge.decision, 'review_required')
  assert.equal(result.calls.at(-1).name, 'merge_linked_apple_subject_wallets_once')
  const completed = result.auditEvents.find((event) => event.event === 'rpc_completed' &&
    event.stage === 'rpc_merge_linked_apple_subject_wallets_once')
  assert.equal(completed.errorCode, 'subscription_requires_review')
  assert.equal('message' in completed, false)
})

test('an already-merged retry is recognized from the exact authenticated alias', async () => {
  const result = await activateSession({ alias: {
    apple_sub: 'apple-sub', canonical_wallet_id: 'v2:canonical',
  } })
  assert.equal(result.status, 200)
  assert.equal(result.body.linkedMerge.decision, 'already_merged')
  assert.deepEqual(result.calls.map((call) => call.name), ['activate_apple_wallet_session'])
})

test('an alias to a different canonical wallet is left for review', async () => {
  const result = await activateSession({ alias: {
    apple_sub: 'apple-sub', canonical_wallet_id: 'v2:other',
  } })
  assert.equal(result.status, 200)
  assert.equal(result.body.linkedMerge.decision, 'review_required')
  assert.deepEqual(result.calls.map((call) => call.name), ['activate_apple_wallet_session'])
})

test('a concurrent successful merge is recognized after the idempotency conflict', async () => {
  const result = await activateSession({
    mergeError: { code: 'P0001', message: 'Apple subject was already merged with another request ID' },
    aliasAfterConflict: { apple_sub: 'apple-sub', canonical_wallet_id: 'v2:canonical' },
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.linkedMerge.decision, 'already_merged')
})
