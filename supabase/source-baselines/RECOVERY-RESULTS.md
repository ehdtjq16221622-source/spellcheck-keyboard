# 2026-10-18 server recovery completion

## Scope

No production deployment, operational function deletion, DB write, or secret change was performed
by this recovery task. The owner separately recorded referral v14 while this work was in progress;
those existing commits were preserved, not re-deployed by this task.

- The additional seven functions were downloaded through the read-only Supabase connector.
  All 18 files matched the recorded live snapshots, normalizing CRLF to LF.
- Recovery now pins fourteen bundles / 50 files, in addition to the earlier five compatibility
  entrypoints. Only entrypoint ../_shared imports move to ./_shared; runtime behavior is unchanged.
- Versions: daily_checkin 23, daily_digest 27, language_study_generate 7, redeem_coupon 24,
  sync_credit_usage 20, sync_subscription 22, telegram_bot 19.
- Unused translate/translation_result.ts and its dedicated tests are absent from the recovery
  branch and already committed on codex/server-pending-work-20261018. Their contents were
  hash-compared before removal from the owner's original worktree.
- Fourteen original mixed source files and eight original test files are preserved as non-deployable
  reference text on the pending branch. Selected pending features remain separate executable commits.
- Android, iOS and unrelated pre-existing server/SQL work were not swept into these commits.

## Branch separation

| Branch | Purpose | Verified top-level Node suite |
|---|---|---|
| codex/wallet-bonus-canary-server | Live recovery | 152 / 152 pass from an exported committed tree, 16 test files |
| codex/subscription-integration-20261018 | Subscription compatibility + diagnostics, not deployed | 169 / 169 pass, 19 test files |
| codex/server-pending-work-20261018 | Three pending features + preserved original sources/tests | 156 / 156 pass, 17 test files |

The owner's original dirty worktree also passed all 204 top-level checks across 29 files. That
number includes unrelated uncommitted tests, so the clean committed-tree counts above are the
reproducible release-review results. No tests were skipped in those three branch suites.

Both review branches incorporate the additional seven live bundles. The subscription changes now
reach only sync_subscription_ios, not language_study_generate. The 36-function dependency report
was regenerated from actual tracked file contents and validates source existence as well as paths.
There are 25 tracked entrypoints; this is not certification that all 25 are deployable.

## Test cleanup

- Import mocks accept both private ./_shared and historical ../_shared paths.
- Normal correct/translate fixtures include requestId; missing-request rejection remains tested
  against actual working entrypoints before any DB/credit/AI call.
- Recovery balance tests assert live v27 single-wallet balances; combined legacy display and
  additional balance diagnostics stay on pending.
- Legacy Apple tests cover the live one-time claim RPC: linked, already_linked, other_owner,
  missing, protected and apple_existing, with no direct balance grant.
- Subscription tests retain ownership, invalid-session, unverified-plan, atomic-failure and
  no-fallback-grant assertions while mocking the current WithReason and diagnostic imports.
- Recovery DeviceCheck tests assert retries and 503 on continued lock contention. The pending
  policy and its fifty mocked busy registrations remain on the pending branch.
- The standalone shared Apple verifier test now mocks its existing X509 compatibility import.

Known live limitation: daily_checkin still returns String(error) and has no new diagnostic ID.
The proposed redacted diagnostic behavior was not smuggled into a live-source recovery; the
original proposed source and assertions are preserved under preserved-work on pending.

## Verification and limits

- Deno type checks passed for all seven newly recovered entrypoints.
- Recovered dependency contents and relative-import resolution passed all 16 baseline checks.
- No literal API token or private-key payload was found in the changes; a PEM-header parser
  string was checked and is not a key value.
- No real AI, Apple payment, Telegram send, TestFlight Sandbox or production DB test was run.
  The nested Postgres sandbox/SQL tests were not executed because this task prohibits DB changes.
- The account token is still supplied by the owner separately; no token was read or printed.

The owner authorized pushing all three branches. Git push and remote-head confirmation are the
final delivery checks; production deployment remains a separate approval after Sandbox testing.
