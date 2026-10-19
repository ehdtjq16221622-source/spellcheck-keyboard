import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = new URL('./', import.meta.url);
const output = new URL('../../functions/dialect_standardization_experiment/', here);
const read = (path) => readFileSync(new URL(path, here), 'utf8').replace(/\r\n/g, '\n');
const hash = (text) => createHash('sha256').update(text).digest('hex');
const manifest = JSON.parse(read('../../live-functions/MANIFEST.json')).functions.correct;
const before = read('../../live-functions/correct/correct/index.ts');
const beforeEdits = read('../../live-functions/correct/correct/proofing_edits.ts');
assert.equal(hash(before).slice(0, 16), manifest.files['correct/index.ts']);
assert.equal(hash(beforeEdits).slice(0, 16), manifest.files['correct/proofing_edits.ts']);

export function buildPipeline(source, edits) {
  assert.equal((source.match(/^import .*$/gm) ?? []).length, 4, 'Review changed imports before preparing');
  assert.equal((source.match(/Deno\.serve\(/g) ?? []).length, 1);
  const body = source.replace(/^import .*$/gm, '').replace('Deno.serve(', 'const handleCorrection = (');
  return `// Generated offline by prepare.mjs; do not edit. No DB or credit implementation is imported.
export const sourceSha256 = '${hash(source)}';
export const editsSha256 = '${hash(edits)}';
export function createPipeline(fetch: typeof globalThis.fetch, geminiKey: string) {
  const metrics = { wallet: 0, charge: 0, refund: 0, slowLog: 0 };
  const console = { log: (..._args: unknown[]) => {}, warn: (..._args: unknown[]) => {}, error: (..._args: unknown[]) => {} };
  const Deno = { env: { get: (name: string) => name === 'GEMINI_API_KEY' ? geminiKey : undefined } };
  class WalletAccessError extends Error { status: number; constructor(message: string, status: number) { super(message); this.status = status; } }
  const createClient = (..._args: unknown[]) => ({ from: (table: string) => {
    if (table !== 'ai_slow_requests') throw new Error('DB_FORBIDDEN');
    return { insert: (_data: unknown) => { metrics.slowLog++; return Promise.resolve({ error: null }); } };
  } });
  const resolveCreditWallet = async (_req: Request, _client: unknown, walletId: string) => {
    if (walletId !== 'synthetic-dialect-only') throw new Error('REAL_WALLET_FORBIDDEN');
    metrics.wallet++; return { walletId };
  };
  const consumeAIUsage = async (_client: unknown, walletId: string, _id: string, kind: string) => {
    if (walletId !== 'synthetic-dialect-only' || kind !== 'correct') throw new Error('REAL_CREDIT_FORBIDDEN');
    metrics.charge++;
    return { accepted: true, alreadyProcessed: false, freeCredits: 0, paidCredits: 0, remaining: 0 };
  };
  const refundAIUsage = async (..._args: unknown[]) => { metrics.refund++; };
${edits.replace(/^export /gm, '')}
${body}
  return { handleCorrection, metrics };
}
`;
}

// Transplant only owned prompt sections onto the exact recorded live pipeline.
// Concurrent response-truncation/diagnostic work must not enter this experiment.
export function dialectOnlyCandidate() {
  const helper = read('./prompt.ts');
  const replacements = [
    ['  // 맞춤법 교정 모드\n', '  // 맞춤법 교정 모드\n  if (includeDialect) return buildDialectProofingPrompt(removePunct, true)\n'],
    ['function buildLowCostProofingPrompt(removePunct: boolean, includeDialect: boolean): string {\n', 'function buildLowCostProofingPrompt(removePunct: boolean, includeDialect: boolean): string {\n  if (includeDialect) return buildDialectProofingPrompt(removePunct, false)\n'],
    ['function buildEditFallbackPrompt(includeDialect: boolean): string {\n', 'function buildEditFallbackPrompt(includeDialect: boolean): string {\n  if (includeDialect) return buildDialectProofingPrompt(true, true)\n'],
  ];
  let result = before;
  for (const [old, next] of replacements) {
    assert.equal(result.split(old).length, 2, 'Prompt insertion point must be unique');
    result = result.replace(old, next);
  }
  result = result.replace('function buildSystemPrompt(', helper + '\nfunction buildSystemPrompt(');
  let restored = result.replace(helper + '\n', '');
  for (const [old, next] of replacements) restored = restored.replace(next, old);
  assert.equal(restored, before, 'No changes outside the helper and three spelling-ON branches');
  return result;
}

function comparePrompts(working) {
  const builders = (source) => {
    const context = vm.createContext({ Deno: { serve: () => {} } });
    vm.runInContext(stripTypeScriptTypes(source.replace(/^import .*$/gm, '')) +
      '\nglobalThis.builders = { buildSystemPrompt, buildLowCostProofingPrompt, buildEditFallbackPrompt };', context);
    return context.builders;
  };
  const original = builders(before);
  const candidate = builders(working);
  const live = builders(before);
  const levels = ['스마트 교정', '존댓말', '격식체', '비즈니스', '고객 안내', '학부모 안내', '소개팅체', '커스텀'];
  const custom = '친구에게 다정한 말투로 바꿔 주세요.';
  const off = [];
  const tone = [];
  const row = (name, args, reference = original) => {
    const initialPrompt = reference[name](...args);
    const finalPrompt = candidate[name](...args);
    assert.equal(finalPrompt, initialPrompt, `Prompt changed outside spelling ON: ${name}`);
    return { builder: name, args, beforeSha256: hash(initialPrompt), afterSha256: hash(finalPrompt), identical: true };
  };
  for (const removePunct of [false, true]) {
    off.push(row('buildLowCostProofingPrompt', [removePunct, false]));
    for (const formalMode of [false, true]) {
      for (const formalIncludePunct of [false, true]) {
        for (const level of levels) off.push(row('buildSystemPrompt', [formalMode, removePunct, false, level, formalIncludePunct, custom]));
      }
    }
    for (const formalIncludePunct of [false, true]) {
      for (const includeDialect of [false, true]) {
        for (const level of levels) tone.push(row('buildSystemPrompt', [true, removePunct, includeDialect, level, formalIncludePunct, custom]));
      }
    }
  }
  off.push(row('buildEditFallbackPrompt', [false]));
  for (const item of off) assert.equal(candidate[item.builder](...item.args), live[item.builder](...item.args));
  const spellingOn = [
    ['buildLowCostProofingPrompt', [true, true]], ['buildEditFallbackPrompt', [true]],
    ['buildSystemPrompt', [false, true, true, '', true]],
  ].map(([builder, args]) => ({ builder, args, before: original[builder](...args), after: candidate[builder](...args) }));
  return { offlineOnly: true, offIdentical: off.length, toneIdentical: tone.length, off, tone, spellingOn };
}

export function prepare() {
  mkdirSync(output, { recursive: true });
  const after = dialectOnlyCandidate();
  const afterEdits = beforeEdits;
  writeFileSync(new URL('candidate-correct.ts', here), after);
  const sources = { before: [before, beforeEdits], after: [after, afterEdits] };
  for (const [variant, [source, edits]] of Object.entries(sources)) {
    writeFileSync(new URL(`generated-${variant}.ts`, output), buildPipeline(source, edits));
  }
  const cases = JSON.parse(read('./cases.json'));
  assert.equal(cases.length, 30);
  writeFileSync(new URL('generated-cases.ts', output),
    '// Generated offline by prepare.mjs; do not edit.\nexport const cases = ' + JSON.stringify(cases, null, 2) + ';\n');
  const record = {
    liveCheck: '2026-10-19 check-live correct succeeded: live v167, recorded snapshot and source match',
    snapshotVersion: manifest.version,
    before: hash(before), after: hash(after),
    afterScope: 'Exact live pipeline plus one helper and three spelling-ON branches; tone and OFF unchanged',
    beforeEdits: hash(beforeEdits), afterEdits: hash(afterEdits),
    cases: hash(read('./cases.json')),
    paidCallsApproved: true,
    defaultPlan: { sentences: 30, includeDialect: true, primaryCorrections: 60, maxProviderAttemptsOneRunner: 240, globalCapEnforced: false },
    optionalPaidOff: 'Separate approval, runner flag and server gate required; default OFF verification is offline',
    scope: 'Original HTTP handler and full AI correction pipeline; wallet/DB boundaries simulated; no real auth/DB/credits',
  };
  writeFileSync(new URL('prepared.json', here), JSON.stringify(record, null, 2) + '\n');
  writeFileSync(new URL('prompt-comparison.json', here), JSON.stringify(comparePrompts(after), null, 2) + '\n');
  return record;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(prepare(), null, 2));
  console.log('Prepared offline only. No network, secrets, deployment or AI requests.');
}
