# Wallet reconnect message, unified (correct v162, translate v49)

Deployed 2026-10-14 on top of live correct v161 / translate v48 (downloaded and compared first;
only both `wallet_auth.ts` copies changed, 24 lines each).

`missingWalletSessionMessage` is now async and decides by account type:
- legacy or Apple-linked v2 wallet (device_credits.apple_user_id not null, or the lookup fails):
  "킹보드 앱을 열고 '지갑 연결' 창에서 [연결]을 눌러 주세요."
- guest v2 wallet (apple_user_id null): "킹보드 앱을 한 번 열어 주세요."

Status codes, authorization rules and the old-app message ("앱을 최신 버전으로 업데이트해 주세요.",
APP_UPDATE_REQUIRED) are unchanged. Matches the keyboard-side strings in
KeyboardViewController.swift (commit "Unify keyboard wallet reconnect messages").

Test: `node --test message.test.mjs` (4 passing).
Rollback: redeploy the previous live copies (correct v161, translate v48 = this folder minus the
wallet_auth.ts change).
