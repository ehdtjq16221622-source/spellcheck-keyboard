import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'
import vm from 'node:vm'
import { buildPipeline } from '../experiments/20261019-dialect-standardization/prepare.mjs'

const baseline = new URL('../deploy-bundles/20261019-dialect-proofing-release/baseline/supabase/functions/correct/', import.meta.url)
const current = new URL('../functions/correct/', import.meta.url)
const experiment = new URL('../experiments/20261019-dialect-standardization/', import.meta.url)
const read = (root, file) => readFileSync(new URL(file, root), 'utf8').replace(/\r\n/g, '\n')
const before = read(baseline, 'index.ts')
const after = read(current, 'index.ts')
const edits = read(current, 'proofing_edits.ts')

test('deployed candidate is exactly the one approved after the paid 30-pair experiment', () => {
  const prepared = JSON.parse(read(experiment, 'prepared.json'))
  assert.equal(after, read(experiment, 'candidate-correct.ts'))
  assert.equal(createHash('sha256').update(after).digest('hex'), prepared.after)
  assert.equal(createHash('sha256').update(before).digest('hex'), prepared.before)
})

test('only the prompt helper and three spelling-ON branches differ; all dependencies stay identical', () => {
  const helper = read(experiment, 'prompt.ts')
  let restored = after.replace(helper + '\n', '')
  for (const guard of [
    '  if (includeDialect) return buildDialectProofingPrompt(removePunct, true)\n',
    '  if (includeDialect) return buildDialectProofingPrompt(removePunct, false)\n',
    '  if (includeDialect) return buildDialectProofingPrompt(true, true)\n',
  ]) {
    assert.equal(restored.split(guard).length, 2)
    restored = restored.replace(guard, '')
  }
  assert.equal(restored, before)
  for (const file of ['proofing_edits.ts', '_shared/credits.ts', '_shared/wallet_auth.ts']) assert.equal(read(current, file), read(baseline, file))
})

test('all 99 protected prompt combinations remain identical; only 35 spelling-ON combinations change', () => {
  const builders = (source) => {
    const context = vm.createContext({ Deno: { serve: () => {} } })
    vm.runInContext(stripTypeScriptTypes(source.replace(/^import .*$/gm, '')), context)
    return context
  }
  const a = builders(before), b = builders(after)
  let unchanged = 0, changed = 0
  const compare = (name, args, expectedChange) => {
    if (expectedChange) { assert.notEqual(b[name](...args), a[name](...args)); changed++ }
    else { assert.equal(b[name](...args), a[name](...args)); unchanged++ }
  }
  for (const formal of [false, true]) for (const remove of [false, true]) for (const dialect of [false, true]) {
    for (const level of ['스마트 교정', '존댓말', '격식체', '비즈니스', '고객 안내', '학부모 안내', '소개팅체', '커스텀']) {
      for (const punct of [false, true]) compare('buildSystemPrompt', [formal, remove, dialect, level, punct, '친절하게 안내하세요.'], !formal && dialect)
    }
  }
  for (const remove of [false, true]) for (const dialect of [false, true]) compare('buildLowCostProofingPrompt', [remove, dialect], dialect)
  for (const dialect of [false, true]) compare('buildEditFallbackPrompt', [dialect], dialect)
  assert.equal(unchanged, 99)
  assert.equal(changed, 35)
})

test('spelling requests keep model, sampling, credit and response contracts; OFF is request-identical', async () => {
  const source = '택배는 문 앞에 놔뒀슈. 비 맞지 않게 봉투도 씌웠어유.'
  const execute = async (code, dialect) => {
    const context = vm.createContext({ Request, Response, Headers, URL, TextEncoder, TextDecoder, Uint8Array, AbortSignal, crypto, setTimeout, clearTimeout })
    vm.runInContext(stripTypeScriptTypes(buildPipeline(code, edits).replace(/^export /gm, '')) + '\nglobalThis.factory = createPipeline;', context)
    const requests = []
    const pipeline = context.factory(async (_url, init) => {
      requests.push({ url: String(_url), body: JSON.parse(init.body) })
      return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: source }] } }] })
    }, 'synthetic-provider-key')
    const response = await pipeline.handleCorrection(new Request('https://local.invalid/correct', { method: 'POST', body: JSON.stringify({ text: source, deviceId: 'synthetic-dialect-only', requestId: crypto.randomUUID(), includeDialect: dialect, formalMode: false, removePunct: true }) }))
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.result, source)
    assert.equal(pipeline.metrics.charge, 1)
    assert.equal(pipeline.metrics.refund, 0)
    delete body.diagnostic_id
    return { requests, body }
  }
  assert.deepEqual(await execute(after, false), await execute(before, false))
  const oldOn = await execute(before, true), newOn = await execute(after, true)
  assert.notEqual(oldOn.requests[0].body.system_instruction.parts[0].text, newOn.requests[0].body.system_instruction.parts[0].text)
  delete oldOn.requests[0].body.system_instruction
  delete newOn.requests[0].body.system_instruction
  assert.deepEqual(newOn, oldOn)
})
