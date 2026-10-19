import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { api, projectRef, REPO } from './lib.mjs'

const phase = process.argv[2]
assert.ok(['before', 'after'].includes(phase))
const functions = await api('/functions')
const correct = functions.find((f) => f.slug === 'correct')
const probe = functions.find((f) => f.slug === 'tone_completion_probe')
assert.equal(correct.status, 'ACTIVE')
assert.equal(correct.verify_jwt, false)
assert.equal(probe.verify_jwt, true)
const ref = projectRef()
const checks = []
for (const [name, method, body, expected] of [
  ['cors', 'OPTIONS', undefined, 200],
  ['missing_request_id', 'POST', { text: 'synthetic', formalMode: true, formalLevel: 'smart' }, 409],
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
const closed = await fetch(`https://${ref}.supabase.co/functions/v1/tone_completion_probe`, {
  method: 'POST', signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${anon}`, apikey: anon, 'Content-Type': 'application/json' },
  body: JSON.stringify({ caseId: 0, variant: 'after', repeat: 0 }),
})
assert.equal(closed.status, 410)
await closed.body?.cancel()
checks.push({ name: 'probe_closed', status: 410 })
const end = new Date()
const start = new Date(end.getTime() - 15 * 60_000)
const sql = "SELECT log_attributes['version'] AS version, log_attributes['response.status_code'] AS status, log_attributes['request.method'] AS method, count() AS requests FROM logs WHERE source = 'function_edge_logs' AND log_attributes['request.pathname'] = '/functions/v1/correct' GROUP BY version, status, method LIMIT 50"
let logs
try {
  const params = new URLSearchParams({ sql, iso_timestamp_start: start.toISOString(), iso_timestamp_end: end.toISOString() })
  logs = { available: true, response: await api(`/analytics/endpoints/logs?${params}`) }
  if (logs.response.error) throw new Error('Logs backend returned a query error')
} catch (error) { logs = { available: false, error: String(error.message) } }
const report = { phase, observedAt: end.toISOString(), correct: { version: correct.version, status: correct.status, verify_jwt: correct.verify_jwt, updated_at: correct.updated_at }, probe: { version: probe.version, verify_jwt: probe.verify_jwt, closed: true }, checks, window: { start: start.toISOString(), end: end.toISOString() }, logs }
writeFileSync(path.join(REPO, `reports/tone-release-check-${phase}-20261019.json`), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
