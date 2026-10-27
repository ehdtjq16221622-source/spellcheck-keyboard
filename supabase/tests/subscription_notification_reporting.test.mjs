import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const helper = readFileSync(new URL('../functions/_shared/subscription_reporting.ts', import.meta.url), 'utf8');
const helperUrl = `data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(helper))}`;
const source = readFileSync(new URL('../functions/apple_notifications/index.ts', import.meta.url), 'utf8');
const runnable = stripTypeScriptTypes(source
  .replace(/^import \{ createClient \} from .*$/m, 'const createClient = globalThis.__notificationDb;')
  .replace(/^import \{ verifyAppleNotificationJws, verifyAppleRenewalInfoJws, verifyAppleTransactionJws \} from .*$/m,
    'const { verifyAppleNotificationJws, verifyAppleRenewalInfoJws, verifyAppleTransactionJws } = globalThis.__notificationVerification;')
  .replace(/^import \{ sendTelegram \} from .*$/m, 'const sendTelegram = globalThis.__notificationSender;')
  .replace(/^import \{ subscriptionCreditsForProduct \} from .*$/m, 'const subscriptionCreditsForProduct = () => 4000;')
  .replace("'../_shared/subscription_reporting.ts'", JSON.stringify(helperUrl)));

async function run(type, subtype) {
  const messages = [];
  let handler;
  const savedFetch = globalThis.fetch;
  globalThis.Deno = { env: { get: key => ({ SUPABASE_URL: 'https://example.invalid',
    SUPABASE_SERVICE_ROLE_KEY: 'private-service-secret' })[key] }, serve: fn => { handler = fn; } };
  globalThis.__notificationDb = () => ({ from: () => ({ select() { return this; }, eq() { return this; },
    async maybeSingle() { return { data: { device_id: 'private-wallet' } }; } }),
    rpc() { throw Error('Reporting must not change balances'); } });
  globalThis.__notificationVerification = {
    verifyAppleNotificationJws: async () => ({ verified: true, environment: 'Production', notification: {
      notificationType: type, subtype, notificationUUID: 'delivery-one', signedDate: Date.now(),
      data: { bundleId: 'com.kingboard.app', signedTransactionInfo: 'fixture', signedRenewalInfo: 'fixture' },
    } }),
    verifyAppleTransactionJws: async () => ({ originalTransactionId: 'private-purchase',
      productId: 'com.kingboard.app.monthly_basic', expiresDate: Date.now() + 86400_000 }),
    verifyAppleRenewalInfoJws: async () => ({ originalTransactionId: 'private-purchase', autoRenewStatus: 1,
      autoRenewProductId: 'com.kingboard.app.monthly_pro' }),
  };
  globalThis.__notificationSender = async (text, options) => { messages.push({ text, options }); return true; };
  globalThis.fetch = async () => Response.json({ active_subscribers_now: 10, auto_renew_on_now: 7,
    auto_renew_off_now: 2, auto_renew_unknown_now: 1 });
  try {
    await import(`data:text/javascript,${encodeURIComponent(runnable)}#${crypto.randomUUID()}`);
    const response = await handler(new Request('https://example.invalid/apple_notifications', {
      method: 'POST', body: JSON.stringify({ signedPayload: 'fixture' }),
    }));
    return { status: response.status, messages };
  } finally { globalThis.fetch = savedFetch; }
}

test('upgrade and downgrade send separate plan-change notifications without credit writes', async () => {
  for (const subtype of ['UPGRADE', 'DOWNGRADE']) {
    const result = await run('DID_CHANGE_RENEWAL_PREF', subtype);
    assert.equal(result.status, 200);
    assert.equal(result.messages.length, 1);
    assert.match(result.messages[0].text, subtype === 'UPGRADE' ? /^⬆️ 플랜 올림 · 베이직 → 프로$/m : /^⬇️ 플랜 내림 예약 · 베이직 → 프로$/m);
    assert.doesNotMatch(result.messages[0].text, /com\.kingboard|Production|해지/);
    assert.match(result.messages[0].options.metadata.subscriptionFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(result.messages[0].options.idempotencyKey, 'delivery-one');
    assert.doesNotMatch(JSON.stringify(result.messages), /private-purchase|private-wallet|private-service-secret/);
  }
});

test('turning renewal off sends one short message with an unknown-aware subscriber line, not churn rate', async () => {
  const result = await run('DID_CHANGE_RENEWAL_STATUS', 'AUTO_RENEW_DISABLED');
  assert.equal(result.status, 200);
  assert.equal(result.messages.length, 1);
  const lines = result.messages[0].text.split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], '😢 해지 예약 · 베이직');
  assert.match(lines[1], /^- \d+\/\d+ \d\d:\d\d · 만료일까지 이용 가능$/);
  assert.equal(lines[2], '- 구독자 <b>10</b>명 (유지 7 · 해지 예약 2 · 확인 불가 1)');
  assert.doesNotMatch(result.messages[0].text, /해지율|AUTO_RENEW/);
});

test('ordinary events are two lines with no product ID, environment or subscriber lookup', async () => {
  const result = await run('DID_CHANGE_RENEWAL_STATUS', 'AUTO_RENEW_ENABLED');
  assert.equal(result.messages.length, 1);
  const lines = result.messages[0].text.split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0], '🙌 해지 취소 · 베이직');
  assert.match(lines[1], /^- \d+\/\d+ \d\d:\d\d$/);
});
