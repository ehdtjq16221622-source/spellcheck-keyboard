# Activate-session linked wallet merge

Based on the production `wallet_link_v2` v40 bundle. The API now invokes the existing `merge_linked_apple_subject_wallets_once` RPC after Apple identity verification and successful session activation, but only while the existing all-user merge rollout flag is enabled.

If the app retries the same Apple-subject wallet through `merge_legacy` after activation, the API verifies the live activated session and exact alias, then returns the current canonical balance without invoking a second merge RPC. Conflicting aliases remain review-required.

The RPC still proves the session's Apple subject and canonical wallet, locks and reconciles the two wallet rows atomically, applies the existing free-credit and paid-credit rules, and rejects subscription mappings or ownership conflicts for review. No arbitrary device wallet IDs are accepted. Exact no-source results are reported as `no_linked_source`; an existing matching alias is idempotently reported as `already_merged`; review cases remain explicitly `review_required`. The request key is a deterministic hash-derived value, not the raw Apple subject.

No schema, RLS, feature flag, secret, bonus amount, debit rule, or subscription rule is changed. No production balances are changed during deployment; future authenticated `activate_session` calls may perform the pre-existing approved atomic merge. This is a balance-affecting server path and is authorized only within the user's existing wallet-link resolution request.

Deploy the files under this bundle's `_shared/` and `wallet_link_v2/` directories with entrypoint `wallet_link_v2/index.ts` and preserve `verify_jwt=false` (the function validates Apple identity and wallet session itself).

Tests:

```powershell
node --test supabase/deploy-bundles/20261006-activate-linked-wallet-merge/tests/*.test.mjs
```

Rollback code target: the `20261006-wallet-link-retry` bundle. Redeploying it stops this activation-triggered attempt but does not reverse merges already completed.

## Prepared P0 install-bonus congestion change (not deployed)

The `wallet_link_v2/index.ts` source was compared byte-for-byte (apart from the final newline) with live v48 before this edit. It now returns the existing wallet with `verification_pending` when the global DeviceCheck lock is busy. The same wallet secret is reused by `register_guest_wallet_v2`; there is no second wallet or 503 busy response. `record_guest_bonus_outcome` persists one of `lock_busy`, `no_device_token`, `devicecheck_unavailable`, `device_already_marked`, or `claim_needs_review` on the wallet credential. Only the last two are terminal/review states. A successful `install_bonus` or pre-existing `install_bonus_restore` clears the reason.

The migration is `supabase/migrations/20261011164037_guard_guest_bonus_restore_and_record_outcome.sql`. It adds the reason columns and an authenticated-by-service-role, wallet-secret-proof RPC. Both bonus reservation and completion reject a second 500 when `install_bonus_restore` already exists. The bonus amount, DeviceCheck enrollment rule, and ownership checks are unchanged. Deploy the migration **before** the Edge bundle; otherwise the new RPC call would fail after wallet creation. The stopped emergency restore cron must remain stopped until the reviewed recovery design is in place.

Pending recovery is **client initiated**, not a server queue. `KingboardStore.retryGuestBonusIfNeeded()` in the iOS canary source saves the pending flag, retries after a random 20-45 seconds while active, and retries on `sceneWillEnterForeground` after an app relaunch. It reuses the same stored guest secret and obtains a fresh DeviceCheck token. If the user never reopens the app, there is no server-only way to re-verify the device; do not call this guaranteed recovery until that iOS version is confirmed in the released build. `claim_needs_review` also needs a separate operator investigation because DeviceCheck enrollment may have succeeded before the DB confirmation failed.

The current global lock is still one-device-at-a-time. A **mock**, not production load test (`tests/guest-bonus-load.test.mjs`) ran 50 concurrent registrations: 0 empty-wallet responses, 0 busy 503s, 0 duplicate grants, 49 initially pending, and 0 pending after 48 retry rounds. That worst-case synchronized retry schedule would be roughly 16-36 minutes at the app's 20-45 second interval; real backlog depends on DeviceCheck latency, traffic, jitter, app activity, and other requests, so this is not an SLA or measured production delay. Measure production backlog after deployment by grouping credentials with `bonus_failure_reason in ('lock_busy', 'devicecheck_unavailable', 'no_device_token')` by `now() - bonus_reason_recorded_at`, and reconcile with `install_bonus`/`install_bonus_restore` ledger rows. Do not interpret a zero balance alone as a failure.

Rollback order: redeploy the exact live v48 bundle first, before removing the new RPC, then run `rollback-guest-bonus-p0.sql` after reviewing safe aggregate reason counts. The rollback intentionally retains the `install_bonus_restore` guards in the existing bonus RPCs: removing them could enable a 1,000-credit duplicate during a later retry. Dropping columns loses the diagnostic reasons. No rollback can undo a bonus transaction that has already been granted, so reconcile the ledger first. Keep cron job 5 inactive; do not resume it as part of rollback.
