import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
const root = new URL('../functions/tone_completion_probe/', import.meta.url)
const load = (file, extra = {}) => {
  const context = { Request, Response, TextEncoder, TextDecoder, URL, Uint8Array, AbortSignal, crypto, setTimeout, Date, console, ...extra }
  const source = readFileSync(new URL(file, root), 'utf8').replace(/^import .*$/gm, '').replace(/^export /gm, '')
  runInNewContext(stripTypeScriptTypes(source) + '\nglobalThis.exports = { ' + (file === 'index.ts' ? 'createHandler' : file === 'cases.ts' ? 'cases' : 'createPipeline, sourceSha256') + ' }', context)
  return context.exports
}
const token = 'a'.repeat(64)
function harness({ enabled = true, expires = 600_000, finishReason = 'STOP', multipart = false } = {}) {
  let now = 1000
  let control = JSON.stringify({ enabled, starts: 0, expires, token })
  let calls = 0
  const base = load('generated-before.ts')
  const next = load('generated-after.ts')
  const { cases } = load('cases.ts')
  const { createHandler } = load('index.ts', { before: base.createPipeline, after: next.createPipeline, beforeHash: base.sourceSha256, afterHash: next.sourceSha256, cases, Deno: { serve: () => {} } })
  const handler = createHandler({ now: () => now, env: (name) => name === 'TONE_COMPLETION_PROBE_CONTROL' ? control : name === 'GEMINI_API_KEY' ? 'provider-secret' : undefined,
    fetch: async () => { calls++; return Response.json({ candidates: [{ finishReason, content: { parts: multipart ? [{ text: 'first' }, { text: 'second' }] : [{ text: 'complete' }] } }] }) },
  })
  return { get calls() { return calls }, expire() { now = expires }, close() { control = JSON.stringify({ enabled: false }) },
    async request(body = { caseId: 0, variant: 'after', repeat: 0 }, supplied = token) {
      const response = await handler(new Request('https://probe.invalid', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-tone-probe-token': supplied }, body: JSON.stringify(body) }))
      return { status: response.status, body: await response.json() }
    },
  }
}
test('closed and expired probes fail before any provider request', async () => {
  for (const options of [{ enabled: false }, { expires: 601_000 }]) {
    const h = harness(options); assert.equal((await h.request()).status, 410); assert.equal(h.calls, 0)
  }
  const h = harness(); h.expire(); assert.equal((await h.request()).status, 410); assert.equal(h.calls, 0)
})
test('an additional token is required and invalid tokens cannot invoke the provider', async () => {
  for (const value of ['', 'b'.repeat(64), 'arbitrary']) {
    const h = harness(); assert.equal((await h.request(undefined, value)).status, 401); assert.equal(h.calls, 0)
  }
})
test('unknown text, models, cases, variants and repetitions are rejected', async () => {
  for (const body of [{ text: 'private' }, { caseId: 0, variant: 'after', repeat: 0, model: 'other' }, { caseId: 9, variant: 'after', repeat: 0 }, { caseId: 0, variant: 'other', repeat: 0 }, { caseId: 0, variant: 'after', repeat: 2 }]) {
    const h = harness(); assert.equal((await h.request(body)).status, 400); assert.equal(h.calls, 0)
  }
})
test('oversized bodies are bounded while streaming', async () => {
  const h = harness(); assert.equal((await h.request({ text: 'a'.repeat(500) })).status, 413); assert.equal(h.calls, 0)
})
test('actual generated handler receives fixed synthetic data with no real wallet or DB', async () => {
  const h = harness(); const result = await h.request()
  assert.equal(result.status, 200); assert.equal(result.body.correctionStatus, 200)
  assert.equal(result.body.result, 'complete'); assert.equal(h.calls, 1)
  assert.equal(result.body.realDatabaseCalls, 0); assert.equal(result.body.realCreditOperations, 0)
  assert.equal(result.body.simulated.charge, 1); assert.equal(result.body.simulated.refund, 0)
  assert.ok(!JSON.stringify(result).includes('provider-secret'))
  assert.equal((await h.request()).status, 409); assert.equal(h.calls, 1)
})
test('before preserves the first-part defect and after returns both visible parts', async () => {
  for (const variant of ['before', 'after']) {
    const h = harness({ multipart: true }); const result = await h.request({ caseId: 0, variant, repeat: 0 })
    assert.equal(result.body.result, variant === 'before' ? 'first' : 'firstsecond')
    assert.equal(result.body.traces[0].visibleParts, 2)
  }
})
test('incomplete candidate does not return partial success and only simulates refund', async () => {
  const h = harness({ finishReason: 'MAX_TOKENS' }); const result = await h.request()
  assert.equal(result.body.correctionStatus, 500); assert.equal(result.body.result, null)
  assert.equal(h.calls, 1); assert.equal(result.body.simulated.refund, 1)
})
test('explicit closure disables the same warm handler', async () => {
  const h = harness(); h.close(); assert.equal((await h.request()).status, 410); assert.equal(h.calls, 0)
})
