# Verification - 2026-10-11 12:01 UTC / 21:01 KST

- Commit `2309eacff59930111207dd86678647527b4e04a2` pushed to
  `spellcheck-keyboard:codex/wallet-bonus-canary-server`.
- Twelve local tests passed. These include syntax, observer-only source diff,
  deduplication, Telegram rejection/retry, identifier redaction, authentication,
  grant-key lookup and incomplete-scan failure. Not an actual purchase test.
- The final predeployment API metadata reported sync version 37 instead of 34.
  Its downloaded files were exactly identical to the originally captured v34
  files. Deployment proceeded only after this source comparison passed.
- `sync_subscription_ios` v38 ACTIVE; `subscription_monitor` v1 ACTIVE.
  Downloaded deployed sources match the isolated release files (ignoring EOF
  newlines). Live authentication policy preserved for sync; monitor requires its
  dedicated secret or exact service role token. Anonymous monitor call: HTTP 401.
- Setup Telegram test returned `ok=true`; one incident log is `delivered`.
  This proves setup delivery, not receipt of a future real customer failure.
- Authenticated monitor invocation: HTTP 200; checked 85, ledger-matched 85,
  missing 0, insufficient 0. Database pg_net invocation separately returned the
  same result without timeout.
- Cron job 4 `kingboard_subscription_monitor` is active every 15 minutes.
  Its command reads the dedicated secret from Vault, not a literal token.
  The first scheduled tick was not awaited; the same database HTTP path was
  invoked manually and its completed response was checked.
- No balances, purchase records, grants, subscription approval policy, existing
  app secrets, Android source or iOS source were changed by this release.
- Real customer failure-to-alert flow and TestFlight rejection root cause remain
  unverified after deployment. The new monitoring does not resolve that cause.

Existing baseline files retain their original EOF whitespace. The staged diff
passes `git -c core.whitespace=-blank-at-eof diff --cached --check`.
