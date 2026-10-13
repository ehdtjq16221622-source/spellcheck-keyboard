import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

for (const path of ['correct/correct/_shared/wallet_auth.ts', 'translate/_shared/wallet_auth.ts']) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const runnable = stripTypeScriptTypes(source.replace(/^import type \{ SupabaseClient \} from .*$/m, ''));
  const auth = await import(`data:text/javascript,${encodeURIComponent(runnable)}`);

  test(`${path}: missing wallet token gives the right recovery action`, async () => {
    for (const sessionsEnabled of [false, true]) {
      globalThis.Deno = { env: { get: (key) => key === 'WALLET_SESSIONS_ENABLED' && sessionsEnabled ? 'true' : undefined } };
      const request = new Request('http://localhost/correct');
      const protectedWallet = {
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
                      return { data: null, error: null };
                    },
                  };
                },
              };
            },
          };
        },
      };

      await assert.rejects(
        auth.resolveCreditWallet(request, protectedWallet, 'legacy-apple'),
        (error) => error.status === 409 && error.message.includes('같은 Apple 계정') &&
          error.message.includes('크레딧 지갑 연결'),
      );
      await assert.rejects(
        auth.resolveCreditWallet(request, protectedWallet, 'v2:guest'),
        (error) => error.status === 409 && error.message.includes('지갑 연결') &&
          !error.message.includes('Apple'),
      );
      assert.deepEqual(await auth.resolveCreditWallet(request, protectedWallet, 'legacy-guest'), {
        walletId: 'legacy-guest', authenticated: false,
      });
      await assert.rejects(
        auth.resolveCreditWallet(request, protectedWallet, 'legacy-guest', true),
        (error) => error.status === 409 && error.message === '앱을 최신 버전으로 업데이트해 주세요.',
      );
    }
  });
}

for (const path of ['correct/correct/index.ts', 'translate/translate/index.ts']) {
  test(`${path}: old request ID rejection still asks for an app update`, () => {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(source, /APP_UPDATE_REQUIRED/);
    assert.match(source, /앱을 최신 버전으로 업데이트해 주세요\./);
  });
}
