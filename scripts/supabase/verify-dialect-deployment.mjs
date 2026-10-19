import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { api, projectRef, REPO } from './lib.mjs'

const phase = process.argv[2]
assert.ok(['before', 'after', 'initial'].includes(phase))
const functions = await api('/functions')
const correct = functions.find((fn) => fn.slug === 'correct')
assert.equal(correct.status, 'ACTIVE')
assert.equal(correct.verify_jwt, false)
const ref = projectRef()
assert.equal(ref, 'ltjhlaprtjgmmijfnmri')
const checks = []
// These rejection paths terminate before wallet lookup, DB writes or provider calls.
for (const [name, method, body, expected] of [
  ['cors', 'OPTIONS', undefined, 200],
  ['missing_request_id', 'POST', { text: 'synthetic', formalMode: false, includeDialect: true }, 409],
  ['invalid_preview', 'POST', { text: '', formalMode: true, formalLevel: 'custom', preview: true }, 400],
]) {
  const response = await fetch(`https://${ref}.supabase.co/functions/v1/correct`, {
    method, signal: AbortSignal.timeout(15_000), headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const data = await response.text()
  assert.equal(response.status, expected, name)
  if (name === 'missing_request_id') assert.equal(JSON.parse(data).code, 'APP_UPDATE_REQUIRED')
  checks.push({ name, status: response.status, cors: response.headers.get('Access-Control-Allow-Origin') })
}
const keys = await api('/api-keys')
const anon = keys.find((key) => key.name === 'anon')?.api_key
assert.ok(anon)
for (const slug of ['dialect_standardization_experiment', 'tone_completion_probe']) {
  assert.equal(functions.find((fn) => fn.slug === slug)?.verify_jwt, true)
  const response = await fetch(`https://${ref}.supabase.co/functions/v1/${slug}`, {
    method: 'POST', signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${anon}`, 'Content-Type': 'application/json' },
    body: '{}',
  })
  assert.equal(response.status, 410)
  await response.body?.cancel()
  checks.push({ name: `${slug}_closed`, status: 410 })
}
const end = new Date()
const start = new Date(phase === 'before' ? end.getTime() - 15 * 60_000 : correct.updated_at)
assert.match(correct.id, /^[a-f0-9-]{36}$/i)
const queries = {
  requests: "SELECT log_attributes['version'] AS version, log_attributes['response.status_code'] AS status, log_attributes['request.method'] AS method, count() AS requests FROM logs WHERE source = 'function_edge_logs' AND log_attributes['request.pathname'] = '/functions/v1/correct' GROUP BY version, status, method LIMIT 50",
  diagnostics: `SELECT countIf(event_message LIKE '%AI_REQUEST_FAILED%') AS ai_failed, countIf(event_message LIKE '%AI_INCOMPLETE_RESPONSE%') AS incomplete, countIf(event_message LIKE '%AI_CREDIT_REFUND_FAILED%') AS refund_failed FROM logs WHERE source = 'function_logs' AND log_attributes['function_id'] = '${correct.id}' LIMIT 1`,
}
const logs = {}
for (const [name, sql] of Object.entries(queries)) {
  try {
    const params = new URLSearchParams({ sql, iso_timestamp_start: start.toISOString(), iso_timestamp_end: end.toISOString() })
    const response = await api(`/analytics/endpoints/logs?${params}`)
    assert.ok(!response.error)
    logs[name] = { available: true, response }
  } catch { logs[name] = { available: false, error: 'AGGREGATE_QUERY_FAILED_NOT_ZERO' } }
}
const report = { phase, observedAt: end.toISOString(), correct: { version: correct.version, status: correct.status, verify_jwt: correct.verify_jwt, updated_at: correct.updated_at }, checks, window: { start: start.toISOString(), end: end.toISOString() }, logs }
writeFileSync(path.join(REPO, `reports/dialect-release-check-${phase}-20261019.json`), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
