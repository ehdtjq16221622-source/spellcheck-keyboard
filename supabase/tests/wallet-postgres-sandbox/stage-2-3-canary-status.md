# Wallet stages 2 and 3: canary status

Date: 2026-09-27. This is an owner-only test path, not approval for all-user rollout.

## Stage 2: device and Apple wallet consistency

- Already observed on TestFlight 2.9 build 752: screen and detail balances matched, one AI correction reduced both equally, and restart preserved the result.
- Synthetic Postgres tests cover canonical resolution, wallet sessions, atomic guest merge, idempotent retry, and refusal of ambiguous purchases.
- Build 764 compiled, finished App Store Connect processing, and is waiting for TestFlight beta review. It adds a retry safeguard: do not erase the guest Keychain proof until Apple-session activation, merge, and credit refresh finish.
- Device-only remaining check: with a *subscribed guest wallet*, Apple login, correction, app restart, and relogin must all reference the same canonical wallet. Compare wallet IDs and server transactions, not only displayed totals.

## Stage 3: guest subscription to an existing Apple wallet

- Server-side precondition: an Apple API-confirmed active purchase, the guest secret, and an active Apple wallet session. Existing Apple wallet must have neither a subscription row nor subscription credits. Otherwise leave both wallets unchanged for review.
- Atomic candidate moves the guest subscription row and remaining subscription credits, then applies the existing guest merge rules to free/paid balances. It records the original transaction ID and request ID to make retries idempotent.
- Local checks: 49 Postgres tests and 21 focused route/status tests pass. These prove synthetic cases, not a real StoreKit transaction.
- The migration and `wallet_link_v2` function are deployed, but `WALLET_SUBSCRIPTION_MERGE_CANARY_APPLE_IDS` remains empty, so the new transfer route is disabled. No user balance was changed.
- Owner-account limitation: the owner's existing Apple wallet already has a subscription row and subscription credits. The safe merge must reject a second guest subscription for this destination. Do not clear either record to manufacture a passing test.
- Device-only remaining check requires an Apple login test wallet with no subscription row or subscription credits: make a guest purchase on TestFlight, then log in to that existing wallet; compare before/after wallet IDs, credits, subscription ownership, one AI debit, retry, restart, and next-cycle grant. A TestFlight purchase may have sandbox renewal timing.

## Release gates

1. Wait for TestFlight beta review of build 764. Do not repeat earlier balance-only tests.
2. Keep the transfer allowlist empty until a subscription-free Apple login test account is available. Never enable all users as a substitute for this test.
3. Run the two device-only checks above once and compare `device_credits`, `device_subscriptions`, and `credit_transactions` read-only. A failed check stops this stage; do not compensate by manual credit mutation.
4. Separately review older app versions and the existing subscription-sync verification/atomicity before all-user activation. The new transfer path does not by itself fix those flows.

Rollback: empty the transfer allowlist first. If needed, redeploy the previous `wallet_link_v2` function version. The additive table/function may remain unused. A completed balance move cannot be rolled back by changing the feature flag; it requires transaction-by-transaction review.
