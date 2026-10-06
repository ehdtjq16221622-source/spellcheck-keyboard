import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const read = (path) => readFile(new URL(path, root), 'utf8')

test('wallet link error responses expose a safe diagnostic id and failure stage', async () => {
  const source = await read('wallet_link_v2/wallet_link_v2/index.ts')
  assert.match(source, /diagnostic_id: auditId, failure_stage: stage/)
  assert.match(source, /X-Kingboard-Diagnostic-ID', auditId/)
  assert.match(source, /Access-Control-Expose-Headers/)
  assert.match(source, /event: 'wallet_link_v2_failure'[\s\S]*?stage,/)
  assert.match(source, /respond\(\{ error: 'Wallet linking unavailable\.' \}, 500\)/)
})

test('subscription error responses include diagnostics and never return raw backend errors', async () => {
  const source = await read('sync_subscription_ios/sync_subscription_ios/index.ts')
  assert.match(source, /diagnostic_id: diagnosticId,[\s\S]*?failure_stage: failureStage/)
  assert.match(source, /X-Kingboard-Diagnostic-ID': diagnosticId/)
  assert.match(source, /safeMessage[\s\S]*?'Subscription synchronization failed\.'/)
  assert.doesNotMatch(source, /error: conflictStatus \? failureCode : message/)
  assert.match(source, /subscriptionFailureResponse\([\s\S]*?auditStage/)
})

test('linked merge verifies the active Apple session before resolving source wallets', async () => {
  const source = await read('wallet_link_v2/wallet_link_v2/index.ts')
  const merge = source.slice(source.indexOf("if (body.action === 'merge_linked')"), source.indexOf("if (body.action === 'merge_legacy')"))
  assert.match(merge, /credit_wallet_sessions'[\s\S]*?wallet_id, apple_sub, expires_at, revoked_at/)
  assert.match(merge, /session\.apple_sub !== identity\.sub/)
  assert.match(merge, /credit_wallet_aliases'[\s\S]*?source_wallet_id', identity\.sub/)
  assert.match(merge, /priorAlias\.canonical_wallet_id !== session\.wallet_id/)
})

test('linked merge retries and missing-source outcomes are safe, while review errors stay blocked', async () => {
  const source = await read('wallet_link_v2/wallet_link_v2/index.ts')
  const merge = source.slice(source.indexOf("if (body.action === 'merge_linked')"), source.indexOf("if (body.action === 'merge_legacy')"))
  assert.match(merge, /linked_merge_already_merged/)
  assert.match(merge, /decision: 'already_merged'/)
  assert.match(merge, /Apple subject already uses its only canonical wallet/)
  assert.match(merge, /Second wallet does not exist/)
  assert.match(merge, /decision: 'no_linked_source'/)
  assert.match(merge, /if \(error\?\.code === 'P0001'\) return respond\(\{ error: 'Wallet transfer requires review\.' \}, 409\)/)
})
