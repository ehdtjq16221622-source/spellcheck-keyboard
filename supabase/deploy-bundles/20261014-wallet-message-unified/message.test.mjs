import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const APPLE = "킹보드 앱을 열고 '지갑 연결' 창에서 [연결]을 눌러 주세요.";
const GUEST = '킹보드 앱을 한 번 열어 주세요.';

for (const path of ['correct/_shared/wallet_auth.ts', 'translate/_shared/wallet_auth.ts']) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const runnable = stripTypeScriptTypes(source.replace(/^import type \{ SupabaseClient \} from .*$/m, ''));
  const auth = await import(`data:text/javascript,${encodeURIComponent(runnable)}`);

  // device_credits rows: v2:apple is linked, v2:guest is not; v2:broken makes the lookup fail.
  const db = {
    from(table) {
      return {
        select() {
          return {
            eq(_column, walletId) {
              return {
                async maybeSingle() {
                  if (table === 'credit_protected_wallets') {
                    return { data: walletId === 'legacy-apple' ? { wallet_id: walletId } : null, error: null };
                  }
                  if (table === 'device_credits') {
                    if (walletId === 'v2:broken') return { data: null, error: new Error('db down') };
                    if (walletId === 'v2:apple') return { data: { apple_user_id: 'apple-sub' }, error: null };
                    if (walletId === 'v2:guest') return { data: { apple_user_id: null }, error: null };
                  }
                  return { data: null, error: null };
                },
              };
            },
          };
        },
      };
    },
  };

  test(`${path}: missing wallet token names the right recovery action`, async () => {
    for (const sessionsEnabled of [false, true]) {
      globalThis.Deno = { env: { get: (key) => key === 'WALLET_SESSIONS_ENABLED' && sessionsEnabled ? 'true' : undefined } };
      const request = new Request('http://localhost/correct');
      const rejects = (id, message) => assert.rejects(
        auth.resolveCreditWallet(request, db, id),
        (error) => error.status === 409 && error.message === message,
      );
      await rejects('legacy-apple', APPLE);
      await rejects('v2:apple', APPLE);
      await rejects('v2:guest', GUEST);
      await rejects('v2:broken', APPLE); // lookup failure keeps the Apple wording and the 409 status
      assert.deepEqual(await auth.resolveCreditWallet(request, db, 'legacy-guest'), {
        walletId: 'legacy-guest', authenticated: false,
      });
      await assert.rejects(
        auth.resolveCreditWallet(request, db, 'legacy-guest', true),
        (error) => error.status === 409 && error.message === '앱을 최신 버전으로 업데이트해 주세요.',
      );
    }
  });
}

for (const path of ['correct/index.ts', 'translate/index.ts']) {
  test(`${path}: old request ID rejection still asks for an app update`, () => {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(source, /APP_UPDATE_REQUIRED/);
    assert.match(source, /앱을 최신 버전으로 업데이트해 주세요/);
  });
}
