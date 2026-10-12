import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('./correct/index.ts', import.meta.url), 'utf8');
const context = vm.createContext({ Deno: { serve() {}, env: { get() { return ''; } } }, console });
vm.runInContext(stripTypeScriptTypes(source.replace(/^import .*$/gm, '')), context);

test('default correction retains dialect-preservation instruction', () => {
  for (const expression of ['buildLowCostProofingPrompt(true, false)', 'buildEditFallbackPrompt(false)']) {
    assert.match(vm.runInContext(expression, context), /사투리와 구어체를 억지로 표준어로 바꾸지 마라/);
  }
});

test('dialect mode explicitly overrides word and ending preservation without changing politeness', () => {
  for (const expression of ['buildLowCostProofingPrompt(true, true)', 'buildEditFallbackPrompt(true)']) {
    const prompt = vm.runInContext(expression, context);
    assert.match(prompt, /같은 의미의 표준어로/);
    assert.match(prompt, /반말·존댓말 수준/);
    assert.doesNotMatch(prompt, /억지로 표준어로 바꾸지/);
  }
});
