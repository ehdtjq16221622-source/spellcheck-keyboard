# Pending server work on top of live recovery

Branch: `codex/server-pending-work-20261018`, based on live recovery `311b02f`.
This branch is NOT approved for deployment and is not the subscription integration branch.

1. Legacy balance display aggregation: preserve the prior working change, while retaining the live
   wallet-activation error code and each function's own live authentication. Displayed combined
   balances may differ from the wallet an AI request actually spends. Resolve that product/ledger
   question before deployment.
2. Translation parser: retain the working plain-response fallback as a separate change. Keep the
   live request-ID rejection, pronunciation instruction, and live auth unchanged.
3. DeviceCheck pending: replace the LIVE eight-second retry/503 policy with the original pending
   policy, which returns `verification_pending` immediately on lock contention. Keep the restored
   account-bonus review, grant-result checks, linked-registration race handling, `resume_linked`,
   and merge retry guards. This policy requires app recovery/Sandbox testing and a separate rollout
   decision; it is not automatically safer than live and was not deployed.

Tests are offline mocks. The 50 busy registrations are fifty local simulated invocations, not an
operational parallel-load test, DB transaction test, or proof of actual payments.

Original mixed-source copies are retained in the owner's main worktree under
`reports/supabase-cleanup-20261018/preserved-work/`. They are reference material, not deploy sources.
