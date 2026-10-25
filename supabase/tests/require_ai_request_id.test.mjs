import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';

const bundle = new URL('../deploy-bundles/20261012-require-ai-request-id/', import.meta.url);
const live = new URL('../deploy-bundles/20261012-wallet-session-rejection-audit/', import.meta.url);

function sourceFor(root, functionName) {
  const path = functionName === 'correct' ? 'correct/correct/index.ts' : 'translate/translate/index.ts';
  return readFileSync(new URL(path, root), 'utf8');
}

function createHandler(functionName, source = sourceFor(bundle, functionName), accepted = true) {
  let handler;
  const calls = { client: 0, wallet: 0, debit: 0, refund: 0, ai: 0, logs: [], errors: [] };
  const context = {
    Deno: {
      env: { get: () => 'test-value' },
      serve: (callback) => { handler = callback; },
    },
    Response,
    Request,
    URL,
    TextEncoder,
    crypto,
    console: {
      warn: (...args) => {
        if (args.length === 1 && typeof args[0] === 'string' && args[0].startsWith('{')) {
          calls.logs.push(JSON.parse(args[0]));
        }
      },
      error: (...args) => calls.errors.push(JSON.stringify(args)),
      log: () => {},
    },
    __createClient: () => {
      calls.client++;
      return {};
    },
    __resolveCreditWallet: async (_req, _client, walletId) => {
      calls.wallet++;
      return { walletId, authenticated: false };
    },
    __consumeAIUsage: async () => {
      calls.debit++;
      return { accepted, alreadyProcessed: false, freeCredits: 500, paidCredits: 0, remaining: 500 };
    },
    __refundAIUsage: async () => { calls.refund++; },
    __applyValidatedProofingEdits: (text) => ({ result: text, rejected: [] }),
    __parseProofingEdits: () => [],
    fetch: async (url) => {
      calls.ai++;
      const payload = String(url).includes('api.openai.com')
        ? { status: 'completed', output_text: functionName === 'translate'
          ? JSON.stringify({ translation: 'Hello', pronunciation_ko: '헬로' })
          : 'polished result' }
        : { candidates: [{ content: { parts: [{ text: 'corrected result' }] } }] };
      return new Response(JSON.stringify(payload), { status: 200 });
    },
  };
  let runnable = source
    .replace(/^import \{ applyValidatedProofingEdits, parseProofingEdits \} from .*$/m,
      'const applyValidatedProofingEdits = globalThis.__applyValidatedProofingEdits; const parseProofingEdits = globalThis.__parseProofingEdits;')
    .replace(/^import \{ createClient \} from .*$/m, 'const createClient = globalThis.__createClient;')
    .replace(/^import \{ consumeAIUsage, refundAIUsage(?:, completeAIUsage)? \} from .*$/m,
      'const consumeAIUsage = globalThis.__consumeAIUsage; const refundAIUsage = globalThis.__refundAIUsage;')
    .replace(/^import \{ resolveCreditWallet, WalletAccessError \} from .*$/m,
      'const resolveCreditWallet = globalThis.__resolveCreditWallet; class WalletAccessError extends Error { constructor(message, status) { super(message); this.status = status; } }');
  runnable = stripTypeScriptTypes(runnable);
  vm.runInNewContext(runnable, context, { filename: `${functionName}/index.ts` });
  return { handler, calls };
}

function request(functionName, body) {
  return new Request(`https://example.test/${functionName}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

for (const functionName of ['correct', 'translate']) {
  test(`${functionName}: missing requestId returns 409 before wallet, debit, or AI`, async () => {
    const { handler, calls } = createHandler(functionName);
    const response = await handler(request(functionName, {
      text: '안녕하세요', targetLang: 'en', deviceId: 'v2:test-wallet',
    }));

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: '앱을 최신 버전으로 업데이트해 주세요.',
      code: 'APP_UPDATE_REQUIRED',
    });
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
    assert.match(response.headers.get('X-Kingboard-Diagnostic-ID'), /^[0-9a-f-]{36}$/i);
    assert.deepEqual({ ...calls, logs: [], errors: [] }, {
      client: 0, wallet: 0, debit: 0, refund: 0, ai: 0, logs: [], errors: [],
    });
    assert.equal(calls.logs.length, 1);
    assert.equal(calls.logs[0].event, 'legacy_request_rejected');
    assert.equal(calls.logs[0].function, functionName);
    assert.equal(calls.logs[0].id_type, 'v2');
    assert.equal(calls.logs[0].diagnostic_id, response.headers.get('X-Kingboard-Diagnostic-ID'));
    assert.deepEqual(Object.keys(calls.logs[0]).sort(),
      ['diagnostic_id', 'event', 'function', 'id_type']);
  });

  test(`${functionName}: rejection log classifies legacy and missing IDs without recording them`, async () => {
    for (const [deviceId, idType] of [['legacy-test-wallet', 'legacy'], [undefined, 'none']]) {
      const { handler, calls } = createHandler(functionName);
      const response = await handler(request(functionName, { text: '안녕하세요', targetLang: 'en', deviceId }));
      assert.equal(response.status, 409);
      assert.equal(calls.logs.length, 1);
      assert.equal(calls.logs[0].id_type, idType);
      assert.deepEqual(Object.keys(calls.logs[0]).sort(),
        ['diagnostic_id', 'event', 'function', 'id_type']);
    }
  });

  test(`${functionName}: valid requestId preserves live debit and AI behavior`, async () => {
    const body = { text: '안녕하세요', targetLang: 'en', deviceId: 'legacy-test', requestId: crypto.randomUUID() };
    const before = createHandler(functionName, sourceFor(live, functionName));
    const after = createHandler(functionName);
    const oldResponse = await before.handler(request(functionName, body));
    const newResponse = await after.handler(request(functionName, body));

    assert.equal(oldResponse.status, 200, JSON.stringify(before.calls.errors));
    assert.equal(newResponse.status, 200, JSON.stringify(after.calls.errors));
    assert.equal((await oldResponse.json()).result, (await newResponse.json()).result);
    assert.equal(after.calls.client, before.calls.client);
    assert.equal(after.calls.wallet, before.calls.wallet);
    assert.equal(after.calls.debit, before.calls.debit);
    assert.equal(after.calls.refund, before.calls.refund);
    assert.equal(after.calls.ai, before.calls.ai);
    assert.ok(after.calls.ai >= 1);
    assert.equal(after.calls.logs.length, 0);
  });

  test(`${functionName}: missing requestId is distinct from insufficient credits`, async () => {
    const { handler, calls } = createHandler(functionName, undefined, false);
    const response = await handler(request(functionName, {
      text: '안녕하세요', targetLang: 'en', deviceId: 'legacy-test', requestId: crypto.randomUUID(),
    }));
    assert.equal(response.status, 429, JSON.stringify(calls.errors));
    assert.equal((await response.json()).error, 'NO_CREDITS');
    assert.equal(calls.debit, 1);
    assert.equal(calls.ai, 0);
  });
}

test('correct: explicit preview without requestId still reaches the live preview flow', async () => {
  const body = {
    text: '오늘 안으로 보내줘.', formalMode: true, formalLevel: 'custom',
    customPrompt: '부드럽게 말해줘.', preview: true,
  };
  const before = createHandler('correct', sourceFor(live, 'correct'));
  const after = createHandler('correct');
  const oldResponse = await before.handler(request('correct', body));
  const newResponse = await after.handler(request('correct', body));
  assert.equal(oldResponse.status, 200);
  assert.equal(newResponse.status, 200);
  assert.equal((await oldResponse.json()).result, (await newResponse.json()).result);
  assert.equal(after.calls.wallet, 0);
  assert.equal(after.calls.debit, 0);
  assert.equal(after.calls.ai, 1);
});

test('correct: legacy preview signature without requestId is unchanged', async () => {
  const legacySource = sourceFor(live, 'correct').match(/const legacyPreviewSource = '([^']+)'/)[1];
  const body = {
    text: legacySource, formalMode: true, formalLevel: 'custom',
    customPrompt: '부드럽게 말해줘.',
  };
  const before = createHandler('correct', sourceFor(live, 'correct'));
  const after = createHandler('correct');
  const oldResponse = await before.handler(request('correct', body));
  const newResponse = await after.handler(request('correct', body));
  assert.equal(oldResponse.status, 200);
  assert.equal(newResponse.status, 200);
  assert.equal((await oldResponse.json()).result, (await newResponse.json()).result);
  assert.equal(after.calls.wallet, 0);
  assert.equal(after.calls.debit, 0);
  assert.equal(after.calls.ai, 1);
});

test('shared deployment files remain byte-identical to live snapshots', () => {
  const sharedPaths = [
    'correct/correct/_shared/credits.ts',
    'correct/correct/_shared/wallet_auth.ts',
    'correct/correct/proofing_edits.ts',
    'translate/_shared/credits.ts',
    'translate/_shared/wallet_auth.ts',
  ];
  for (const path of sharedPaths) {
    assert.deepEqual(readFileSync(new URL(path, bundle)), readFileSync(new URL(path, live)), path);
  }
});
