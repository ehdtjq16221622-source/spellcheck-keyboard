import assert from 'node:assert/strict'
import { randomBytes, createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { accessToken, api, projectRef, REPO } from './lib.mjs'
import path from 'node:path'

// One sequential run, 16 fixed slots, no request retries and no customer wallet.
const token = randomBytes(32).toString('hex')
const name = 'TONE_COMPLETION_PROBE_CONTROL'
const ref = projectRef()
assert.equal(ref, 'ltjhlaprtjgmmijfnmri')
const slug = 'tone_completion_probe'
const reportPath = path.join(REPO, 'reports/tone-probe-results-20261019.json')
const hashes = Object.fromEntries(['before', 'after'].map((variant) => {
  const source = readFileSync(path.join(REPO, `supabase/functions/${slug}/generated-${variant}.ts`), 'utf8')
  const match = source.match(/export const sourceSha256 = '([a-f0-9]{64})'/)
  assert.ok(match)
  return [variant, match[1]]
}))
const currentHash = createHash('sha256').update(readFileSync(path.join(REPO, 'supabase/functions/correct/index.ts'), 'utf8').replace(/\r\n/g, '\n')).digest('hex')
assert.equal(hashes.after, currentHash)
const keys = await api('/api-keys')
const anon = keys.find((key) => key.name === 'anon')?.api_key
assert.ok(typeof anon === 'string' && anon.split('.').length === 3, 'A legacy anon JWT is required by the probe gateway')
const setControl = async (value) => {
  const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/secrets`, {
    method: 'POST', signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Bearer ${accessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([{ name, value: JSON.stringify(value) }]),
  })
  if (!response.ok) throw new Error(`Probe control update failed: HTTP ${response.status}`)
  await response.body?.cancel()
}
const call = async (body, supplied = token) => {
  const response = await fetch(`https://${ref}.supabase.co/functions/v1/${slug}`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(40_000),
    headers: { Authorization: `Bearer ${anon}`, apikey: anon, 'Content-Type': 'application/json', 'x-tone-probe-token': supplied },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}
const report = { startedAt: new Date().toISOString(), hashes, plan: { correctionJobs: 16, maxProviderCalls: 16, retries: 0 }, rows: [], closed: false }
let failure
try {
  await setControl({ enabled: false })
  assert.equal((await call({ caseId: 0, variant: 'before', repeat: 0 })).status, 410, 'Probe must be closed before opening')
  const starts = Date.now()
  await setControl({ enabled: true, starts, expires: starts + 10 * 60_000, token })
  assert.equal((await call({ caseId: 0, variant: 'before', repeat: 0 }, '0'.repeat(64))).status, 401, 'Wrong extra token must be rejected')
  for (let repeat = 0; repeat < 2; repeat++) {
    for (let caseId = 0; caseId < 4; caseId++) {
      for (const variant of (caseId + repeat) % 2 ? ['after', 'before'] : ['before', 'after']) {
        const result = await call({ caseId, variant, repeat })
        assert.equal(result.status, 200, `Probe HTTP failure: ${result.status}`)
        const row = result.body
        assert.equal(row.sourceSha256, hashes[variant])
        assert.equal(row.realDatabaseCalls, 0)
        assert.equal(row.realCreditOperations, 0)
        assert.ok(row.providerCalls <= 1)
        assert.ok(!JSON.stringify(row).includes(token))
        report.rows.push(row)
        console.log(JSON.stringify({ caseId, repeat, variant, correctionStatus: row.correctionStatus, finishReason: row.traces[0]?.finishReason, sourceChars: row.sourceChars, resultChars: row.result == null ? null : Array.from(row.result).length, durationMs: row.durationMs }))
        if (row.traces.some((trace) => trace.status === 401 || trace.status === 403 || trace.status === 429)) throw new Error('Provider authorization/quota failure; stop without retry')
      }
    }
  }
} catch (error) {
  failure = error
  report.error = String(error.message).replace(/sbp_[A-Za-z0-9]+/g, '[REDACTED]').split(token).join('[REDACTED]')
} finally {
  // Explicit closure is required even after a failed or timed-out run.
  await setControl({ enabled: false })
  for (let attempt = 0; attempt < 10; attempt++) {
    const result = await call({ caseId: 0, variant: 'after', repeat: 0 })
    if (result.status === 410) { report.closed = true; break }
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }
  report.finishedAt = new Date().toISOString()
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ completedJobs: report.rows.length, actualProviderCalls: report.rows.reduce((sum, row) => sum + row.providerCalls, 0), closed: report.closed }))
}
assert.equal(report.closed, true, 'Probe closure was not confirmed')
if (failure) throw new Error(report.error)
assert.equal(report.rows.length, 16)
