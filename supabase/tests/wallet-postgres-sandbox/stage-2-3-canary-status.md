# Wallet stages 2 and 3: canary status

Date: 2026-09-27. This is an owner-only test path, not approval for all-user rollout.

## Stage 2: device and Apple wallet consistency

- Already observed on TestFlight 2.9 build 752: screen and detail balances matched, one AI correction reduced both equally, and restart preserved the result.
- Synthetic Postgres tests cover canonical resolution, wallet sessions, atomic guest merge, idempotent retry, and refusal of ambiguous purchases.
- Build 764 adds a retry safeguard: do not erase the guest Keychain proof until Apple-session activation, merge, and credit refresh finish.
- Device-only remaining check: with a *subscribed guest wallet*, Apple login, correction, app restart, and relogin must all reference the same canonical wallet. Compare wallet IDs and server transactions, not only displayed totals.

## Stage 3: guest subscription to an existing Apple wallet

- Server-side precondition: an Apple API-confirmed active purchase, the guest secret, and an active Apple wallet session. Existing Apple wallet must have neither a subscription row nor subscription credits. Otherwise leave both wallets unchanged for review.
- Atomic candidate moves the guest subscription row and remaining subscription credits, then applies the existing guest merge rules to free/paid balances. It records the original transaction ID and request ID to make retries idempotent.
- Local checks: 49 Postgres tests and 21 focused route/status tests pass. These prove synthetic cases, not a real StoreKit transaction.
- The migration and `wallet_link_v2` function are deployed, but `WALLET_SUBSCRIPTION_MERGE_CANARY_APPLE_IDS` remains empty, so the new transfer route is disabled. No user balance was changed.
- Device-only remaining check: a guest purchase on a TestFlight device, then Apple login to an existing wallet; compare before/after wallet IDs, credits, subscription ownership, one AI debit, retry, restart, and next-cycle grant. A TestFlight purchase may have sandbox renewal timing.

## Release gates

1. Confirm build 764 compiled and reached TestFlight. Do not repeat earlier balance-only tests.
2. Turn on the transfer allowlist for the owner account only after reviewing the build; do not enable other users yet.
3. Run the two device-only checks above once and compare `device_credits`, `device_subscriptions`, and `credit_transactions` read-only. A failed check stops this stage; do not compensate by manual credit mutation.
4. Separately review older app versions and the existing subscription-sync verification/atomicity before all-user activation. The new transfer path does not by itself fix those flows.

Rollback: empty the transfer allowlist first. If needed, redeploy the previous `wallet_link_v2` function version. The additive table/function may remain unused. A completed balance move cannot be rolled back by changing the feature flag; it requires transaction-by-transaction review.
