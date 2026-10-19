import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const beforeRoot = new URL('../deploy-bundles/20261014-tone-complete-response/baseline/supabase/functions/correct/', import.meta.url)
const afterRoot = new URL('../functions/correct/', import.meta.url)
const read = (root, file) => readFileSync(new URL(file, root), 'utf8').replace(/\r\n/g, '\n')
const builders = (source) => {
  const context = { Deno: { serve: () => {} } }
  runInNewContext(stripTypeScriptTypes(source.replace(/^import .*$/gm, '')), context)
  return context
}
test('response-only release preserves all 134 prompt combinations, including dialect ON', () => {
  const a = builders(read(beforeRoot, 'index.ts'))
  const b = builders(read(afterRoot, 'index.ts'))
  let comparisons = 0
  for (const formal of [false, true]) for (const remove of [false, true]) for (const dialect of [false, true]) {
    for (const level of ['스마트 교정', '존댓말', '격식체', '비즈니스', '고객 안내', '학부모 안내', '소개팅체', '커스텀']) {
      for (const punct of [false, true]) {
        const args = [formal, remove, dialect, level, punct, '친절하게 안내하세요.']
        assert.equal(b.buildSystemPrompt(...args), a.buildSystemPrompt(...args)); comparisons++
      }
    }
  }
  for (const remove of [false, true]) for (const dialect of [false, true]) {
    assert.equal(b.buildLowCostProofingPrompt(remove, dialect), a.buildLowCostProofingPrompt(remove, dialect)); comparisons++
  }
  for (const dialect of [false, true]) {
    assert.equal(b.buildEditFallbackPrompt(dialect), a.buildEditFallbackPrompt(dialect)); comparisons++
  }
  assert.equal(comparisons, 134)
})
test('authentication, wallet credit accounting and edit validation remain byte-identical to recorded live', () => {
  for (const file of ['_shared/credits.ts', '_shared/wallet_auth.ts', 'proofing_edits.ts']) {
    assert.equal(read(afterRoot, file), read(beforeRoot, file), file)
  }
})
