# Wallet merge preservation and retry fix

## Scope

- Reconcile source free credit against its transaction ledger before moving it.
- Preserve earned balances when provenance reconciles; remove only a proven duplicate install bonus.
- Hold incomplete history, mixed bonus consumption and refund balances for review.
- Apply the same checks to linked and legacy merging while wallet rows are locked.
- Resume linked merging using a live activated session, with ownership validation and the same operation key.
- iOS consumes merge decisions, persists pending state, retries on foreground with a five-minute throttle,
  and marks completion only after canonical balance lookup. Expired sessions no longer suppress the prompt.

This does not identify every historical advertisement/event grant. In particular, a missing transaction
ledger is not proof that an existing 500 balance is a duplicate bonus. Such wallets are held unchanged.
No mass merge, historical repair, credit grant, or balance update is executed by this change.

## Validation

Run the PostgreSQL sandbox merge-preservation tests, activation-auto-merge tests and diagnostic tests.
The iOS repository has source-contract tests; these are not an Xcode build or device test.
Validate login cancellation, expiration, offline retry, review-required, session change and foreground
resumption on a device before distributing the app.

## Release order

1. Review this migration against the current live definitions of both merge RPCs and their grants.
2. Apply the additive migration before deploying the updated wallet_link_v2 bundle.
3. Verify function version, session-only authorization rejection, and safe audit categories.
4. Build and distribute the iOS change separately. Server deployment cannot update installed apps.
5. Observe natural traffic and reconcile merge records; do not generate real customer transactions.

Do not redeploy unrelated functions from this worktree. apple_notifications has additional live changes.
Do not re-enable the paused automation.

## Recovery

If problems arise, stop new automatic merges using the approved operational procedure. Preserve the
stricter DB guard: reverting to the earlier heuristic can discard earned balances. A code rollback cannot
reverse completed merges. Keep pre-deployment function definitions for investigation and forward repair;
any manual credit repair requires separate evidence and approval.
