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

## Deployment verification (2026-10-07 KST)

- Server implementation commit: 9c1693d, pushed to codex/wallet-server-link-flow.
- iOS implementation commit: 12fd9f2, pushed to codex/wallet-v2-canary.
- Production DB migration: 20261007051446_preserve_wallet_merge_balances.
  Local source file was generated at 20261007045625; the MCP apply operation assigned
  the production version above. Do not apply the same source again as a new migration.
- wallet_link_v2 version 45 is ACTIVE. All seven deployed source files match the reviewed bundle.
- Both merge RPCs call the shared guard. anon/authenticated execution is denied;
  service_role execution is allowed.
- Read-only availability returned enabled=true. A resume request with no session returned 401.
- 57 focused server/SQL checks and 6 iOS source-contract checks passed.
- iOS has not been compiled or distributed. Its branch also lacks main's release-version bump;
  release integration and Xcode validation remain required. No claim of App Store completion.

## Historical balance audit

Five legacy merge records and zero linked merge records were present at inspection.
All five aliases matched their canonical wallet. Paid balances were conserved in all five
merge snapshots; the inspected advertisement and event grants used paid_delta, not free_delta.
The synthetic free-credit reward reproduction demonstrates a rule weakness, not proof that
those actual advertisement/event grants were lost.

Three records had zero source free balance. Two excluded source free balances of 870 and 500.
For the 870 case, the retained free ledger net was -130 with an unexplained opening balance;
for the 500 case, there was no preceding source transaction history. Destination histories
were also absent before these merges. These amounts are NOT confirmed compensation amounts:
duplicate initial credits cannot be distinguished from legitimate balance using these records alone.
No positive ledger entries on the old wallets after these five merges were found.

Per the user's clarified instruction, no direct balance repair, grant, or mass merge was performed.
The paused monitor remains paused.
