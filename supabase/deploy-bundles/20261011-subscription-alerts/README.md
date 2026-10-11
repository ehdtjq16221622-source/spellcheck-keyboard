# iOS subscription incident alerts

Project: `ltjhlaprtjgmmijfnmri`. Server repository: `spellcheck-keyboard`.
This is server-only code; it does not modify Android or iOS app source.

## Release boundary

`baseline` is the live `sync_subscription_ios` v34 download. Deploy only the
explicit files in `release`, NOT the unrelated dirty `supabase/functions` tree.
Apple verification, credit helpers, wallet authentication, response bodies and
grant conditions are unchanged. Tests strip the observer and compare the
remaining handler to the baseline.

`sync_subscription_ios` keeps its existing `verify_jwt=false` and wallet auth.
`subscription_monitor` uses `verify_jwt=false` with mandatory scoped secret or
exact service-role authentication inside the handler. Never make it public.

## Coverage and limitations

- Sync failures send a safe diagnostic ID and failure classification to the
  existing administrator Telegram destination. No wallet/transaction raw IDs.
- Retries with the same authenticated wallet/environment/stage/code are grouped
  per UTC day. Unauthenticated failures are grouped without caller-controlled IDs.
- Telegram must return `ok=true` before the delivery record is marked delivered.
  Ambiguous network timeouts can still duplicate delivery; unknown deliveries are
  retried by the monitor after five minutes.
- Every 15 minutes the monitor checks recorded active, unexpired iOS subscription
  cycle keys against monthly grant ledger entries. Updated rows wait 15 minutes.
  The scan is capped at 500 and fails closed on truncation or query errors.
- This is not verification of all Apple purchases, amounts, wallet routing or
  spendability. Payments never recorded on our server and failures before an app
  request reaches it are outside coverage. No balance-based loss inference.
- Missing cycle keys remain insufficient evidence, not confirmed loss. Missing
  ledger entries trigger investigation only, never automatic credit repair.
- Database/Telegram-wide outages can prevent the failure alert itself. Check
  cron HTTP responses and function logs independently when delivery is absent.

## Operations

`node --test supabase/deploy-bundles/20261011-subscription-alerts/alerts.test.mjs`

`operate.mjs configure` creates/reuses a dedicated random secret in Vault and
Edge secrets; it does not rotate existing application secrets. `test` sends one
explicitly labelled setup alert; `scan` reads current subscription ledgers;
`schedule` creates/updates the single `kingboard_subscription_monitor` cron job.
All commands require the management token in the existing environment and print
only safe aggregates. Secrets are never written to this repository.

## Rollback

Redeploy the six `baseline` files as `sync_subscription_ios` with
`verify_jwt=false`; verify active version and downloaded contents. Disable only
`kingboard_subscription_monitor` via `cron.alter_job(active := false)` using its
looked-up job ID. Keep alert delivery history. No user balance rollback is needed
because this release never changes credit policy or manually adjusts balances.
