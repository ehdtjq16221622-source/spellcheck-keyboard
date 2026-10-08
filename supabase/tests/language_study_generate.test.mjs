import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = readFileSync(new URL('../functions/language_study_generate/index.ts', import.meta.url), 'utf8');
const runnable = stripTypeScriptTypes(source
  .replace(/^import \{ createClient \} from .*;?$/m, 'const createClient = globalThis.__createClient;')
  .replace(/^import \{ resolveCreditWallet, WalletAccessError \} from .*;?$/m,
    'const resolveCreditWallet = globalThis.__resolveCreditWallet; class WalletAccessError extends Error { constructor(message, status) { super(message); this.status = status; } }'));

test('generates one bounded batch, requires a wallet session, and returns safe request correlation', async () => {
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  const requestId = crypto.randomUUID();
  let handler;
  let modelRequest;
  let walletAuthArgs;
  globalThis.Deno = {
    env: { get: (key) => ({ OPENAI_API_KEY: 'test-secret', SUPABASE_URL: 'test-url', SUPABASE_SERVICE_ROLE_KEY: 'test-role' })[key] },
    serve: (callback) => { handler = callback; },
  };
  globalThis.__createClient = () => ({});
  globalThis.__resolveCreditWallet = async (...args) => { walletAuthArgs = args; return { walletId: 'test-wallet', authenticated: true }; };
  globalThis.fetch = async (url, init) => {
    modelRequest = { url: String(url), body: JSON.parse(init.body) };
    return new Response(JSON.stringify({
      status: 'completed',
      output: [
        { type: 'reasoning', summary: [] },
        { type: 'message', role: 'assistant', content: [{
          type: 'output_text',
          text: JSON.stringify({ items: ids.map((id, index) => ({
            phrase_id: id,
            reply: index ? 'また会いましょう。' : 'コーヒーを飲みましょう。',
            reply_ko: index ? '또 만나요.' : '커피를 마셔요.',
            pronunciation_ko: index ? '마타아이마쇼오' : '코오히이오노미마쇼오',
          })) }),
        }] },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const logs = [];
  const originalLog = console.log;
  console.log = (message) => logs.push(String(message));
  try {
    await import(`data:text/javascript,${encodeURIComponent(runnable)}#${crypto.randomUUID()}`);
    const phrases = ids.map((id, index) => ({
      id, source_text: `표현 ${index}`, translated_text: `saved ${index}`, language_code: 'ja',
    }));
    const response = await handler(new Request('http://localhost/language_study_generate', {
      method: 'POST',
      body: JSON.stringify({ deviceId: 'private-wallet', requestId, phrases }),
    }));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('X-Kingboard-Diagnostic-ID'), requestId);
    assert.equal(body.diagnostic_id, requestId);
    assert.equal(body.items.length, 2);
    assert.deepEqual(walletAuthArgs.slice(2), ['private-wallet', true]);
    assert.equal(modelRequest.url, 'https://api.openai.com/v1/responses');
    assert.equal(modelRequest.body.model, 'gpt-6-luna');
    assert.equal(modelRequest.body.store, false);
    assert.equal(modelRequest.body.input.includes('saved 0'), true);
    assert.equal(logs.join('\n').includes('private-wallet'), false);
    assert.equal(logs.join('\n').includes('표현 0'), false);
  } finally {
    console.log = originalLog;
  }
});

test('rejects more than ten phrases before wallet or model work', async () => {
  let handler;
  let walletAuthCalled = false;
  globalThis.Deno = {
    env: { get: () => 'test-value' },
    serve: (callback) => { handler = callback; },
  };
  globalThis.__createClient = () => ({});
  globalThis.__resolveCreditWallet = async () => { walletAuthCalled = true; return {}; };
  await import(`data:text/javascript,${encodeURIComponent(runnable)}#${crypto.randomUUID()}`);
  const response = await handler(new Request('http://localhost/language_study_generate', {
    method: 'POST',
    body: JSON.stringify({ deviceId: 'private-wallet', requestId: crypto.randomUUID(), phrases: Array.from({ length: 11 }, () => ({})) }),
  }));
  assert.equal(response.status, 400);
  assert.equal(walletAuthCalled, false);
});
