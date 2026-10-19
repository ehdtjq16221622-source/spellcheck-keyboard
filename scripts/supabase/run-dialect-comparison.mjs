import assert from 'node:assert/strict'
import { randomBytes, createHash } from 'node:crypto'
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { accessToken, api, projectRef, REPO } from './lib.mjs'
import path from 'node:path'

const ref = projectRef()
assert.equal(ref, 'ltjhlaprtjgmmijfnmri')
const slug = 'dialect_standardization_experiment'
const dir = path.join(REPO, 'supabase/experiments/20261019-dialect-standardization')
const prepared = JSON.parse(readFileSync(path.join(dir, 'prepared.json'), 'utf8'))
const hash = (s) => createHash('sha256').update(s.replace(/\r\n/g, '\n')).digest('hex')
const current = (await api('/functions')).find((fn) => fn.slug === 'correct')
assert.equal(current.version, prepared.snapshotVersion, 'Live correct changed; refresh baseline before testing')
assert.equal(hash(readFileSync(path.join(REPO, 'supabase/functions/correct/index.ts'), 'utf8')), prepared.before)
// Refuse accidental reruns of a paid batch, including a previously aborted batch.
assert.ok(!readdirSync(dir).some((name) => /^results-\d+\.json$/.test(name)), 'A paid batch exists; review before any further calls')
const keys = await api('/api-keys')
const anon = keys.find((key) => key.name === 'anon')?.api_key
assert.ok(typeof anon === 'string' && anon.split('.').length === 3)
const token = randomBytes(32).toString('hex')
const setSecrets = async (values) => {
  const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/secrets`, {
    method: 'POST', signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Bearer ${accessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.entries(values).map(([name, value]) => ({ name, value }))),
  })
  if (!response.ok) throw new Error(`Experiment control update: HTTP ${response.status}`)
  await response.body?.cancel()
}
const endpoint = `https://${ref}.supabase.co/functions/v1/${slug}`
const call = async (supplied = token) => {
  const response = await fetch(endpoint, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Bearer ${anon}`, 'Content-Type': 'application/json', 'x-dialect-experiment-token': supplied },
    body: JSON.stringify({ caseId: 1, variant: 'before', includeDialect: true }),
  })
  await response.body?.cancel()
  return response.status
}
const controls = { startedAt: new Date().toISOString(), closed: false, closedStatus: null, wrongTokenStatus: null }
try {
  await setSecrets({ DIALECT_EXPERIMENT_OPEN: 'false' })
  assert.equal(await call(), 410, 'Must be closed before opening')
  const now = Date.now()
  await setSecrets({
    DIALECT_EXPERIMENT_OPEN: 'true', DIALECT_EXPERIMENT_TOKEN: token,
    DIALECT_EXPERIMENT_STARTS_AT: new Date(now).toISOString(),
    DIALECT_EXPERIMENT_EXPIRES_AT: new Date(now + 15 * 60_000).toISOString(),
    DIALECT_EXPERIMENT_ALLOW_PAID_OFF: 'false',
  })
  controls.wrongTokenStatus = await call('0'.repeat(64))
  assert.equal(controls.wrongTokenStatus, 401)
  process.env.DIALECT_EXPERIMENT_URL = endpoint
  process.env.DIALECT_EXPERIMENT_TOKEN = token
  process.env.DIALECT_EXPERIMENT_JWT = anon
  const { run } = await import('../../supabase/experiments/20261019-dialect-standardization/run.mjs')
  await run(['--run', '--approve-paid-ai'])
} finally {
  await setSecrets({ DIALECT_EXPERIMENT_OPEN: 'false' })
  for (let attempt = 0; attempt < 10; attempt++) {
    controls.closedStatus = await call()
    if (controls.closedStatus === 410) { controls.closed = true; break }
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }
  delete process.env.DIALECT_EXPERIMENT_TOKEN
  delete process.env.DIALECT_EXPERIMENT_JWT
  controls.finishedAt = new Date().toISOString()
  writeFileSync(path.join(dir, 'closure.json'), JSON.stringify(controls, null, 2) + '\n')
  console.log(JSON.stringify(controls))
  assert.equal(controls.closed, true, 'Experiment closure not confirmed')
}
