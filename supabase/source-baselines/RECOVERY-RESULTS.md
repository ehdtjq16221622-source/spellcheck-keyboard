# 2026-10-18 server source recovery results

No deployment, function deletion, database write, secret change, or push was performed.
The owner will provide a new SUPABASE_ACCESS_TOKEN through the PC environment. Until then,
live comparisons use the existing read-only Supabase connector, as the owner requested.

## Commits and branches

| Branch | Commit | Contents |
|---|---|---|
| codex/wallet-bonus-canary-server | dbad01f | Five compatibility entrypoints match recorded live source; shared Apple auth EOF also matches |
| codex/wallet-bonus-canary-server | 311b02f | Seven high-risk functions restored with 32 per-function live files; only local import relocation |
| codex/subscription-integration-20261018 | b491e3d | Live subscription fixes + compatibility/diagnostics, dependency impact report and regression checks |
| codex/server-pending-work-20261018 | ac2adef | Pending legacy balance aggregation, retaining activation error code |
| codex/server-pending-work-20261018 | f4ece58 | Pending translation parser/plain-response fallback, retaining live request-ID/pronunciation guards |
| codex/server-pending-work-20261018 | 99103c9 | Pending immediate verification_pending policy, retaining other v54 wallet protections |
| codex/server-pending-work-20261018 | 431c88b | Non-deployable reference copies of the seven original mixed working files |

Both review branches start at 311b02f. The pending feature branch is not merged into the subscription
branch. The original iOS branch, Android edits, unrelated server work, SQL and operational settings
were not swept into these commits. Review branches have clean worktrees; the owner's original
worktree still intentionally contains other pre-existing uncommitted changes.

## Preservation and next-deploy scope

The restored functions use private live dependency copies to avoid overwriting the five different
operational wallet-auth behaviors. File content is preserved except that entrypoints referencing
../_shared now reference ./_shared. This path-only change is visible in future raw deployment diffs;
it is not an unreported behavior change and was checked against the recorded snapshots.

The subscription branch's shared changes reach exactly sync_subscription_ios and
language_study_generate. Other recovered functions remain pinned. A 36-function table, including
pre-existing unresolved drift and functions with no deployable source, is committed at
supabase/source-baselines/SUBSCRIPTION-INTEGRATION-IMPACT.md on that branch. The table does not
declare the entire repository ready for deployment.

## Verification and limits

- Owner's recovery branch: 9 focused checks pass, covering 32 live files, dependency resolution,
  and actual working correct/translate rejection before DB or AI calls.
- Subscription branch: 37 focused Node checks pass; Deno type checks for sync_subscription_ios
  and language_study_generate pass.
- Pending branch: 52 focused checks pass. Its fifty busy registrations are local mocked invocations,
  not production concurrency, database or actual credit-grant tests.
- Initial and final live inventories both contain 36 functions with unchanged versions and
  verify_jwt values. No secret literals were found in staged changes.
- The complete old server test suite is NOT certified green. An extra probe of four pre-existing
  test files in the owner's dirty worktree exposed obsolete ../_shared mock paths and expectations
  for pending behavior (combined display and added diagnostic events). Those original pending
  tests were not erased or represented as passing recovery checks. The targeted new recovery and
  branch tests above are the verified results.
- No TestFlight Sandbox run or real Apple payment/server-grant certification was done. A TestFlight
  app still pointing at live v50 cannot validate the un-deployed integration code. A separate Sandbox
  endpoint/test plan is required before the later production deployment decision.

Only local commits were requested, so no branches were pushed. Deployment remains gated on the
owner's later Sandbox verification and release instruction.
