import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../wallet_link_v2/index.ts', import.meta.url), 'utf8')

test('wallet link errors expose a diagnostic ID and safe failure stage', () => {
  assert.match(source, /diagnostic_id: auditId, failure_stage: stage/)
  assert.match(source, /X-Kingboard-Diagnostic-ID', auditId/)
  assert.match(source, /Access-Control-Expose-Headers/)
  assert.match(source, /event: 'wallet_link_v2_failure'[\s\S]*?stage,/)
  assert.match(source, /respond\(\{ error: 'Wallet linking unavailable\.' \}, 500\)/)
})

test('linked merge rejects session mismatches and routes through the shared merge guard', () => {
  const merge = source.slice(source.indexOf("if (body.action === 'merge_linked')"), source.indexOf("if (body.action === 'merge_legacy')"))
  assert.match(merge, /session\.apple_sub !== identity\.sub/)
  assert.match(merge, /mergeLinkedAppleSubject\([\s\S]*?identity\.sub,[\s\S]*?session\.wallet_id/)
  assert.match(merge, /result\.decision === 'review_required'/)
})

test('Apple activation only triggers the existing merge under the all-user merge flag', () => {
  const activation = source.slice(source.indexOf("if (body.action === 'activate_session')"), source.indexOf("if (body.action === 'merge_linked')"))
  assert.match(activation, /walletAutoMergeAllUsersEnabled/)
  assert.match(activation, /mergeLinkedAppleSubject\([\s\S]*?identity\.sub,[\s\S]*?walletId,[\s\S]*?tokenHash/)
  assert.match(activation, /linked-merge:auto-v1:\$\{await sha256\(identity\.sub\)\}/)
  assert.match(source, /linked_merge_review_required/)
  assert.match(source, /decision: 'review_required'/)
})
