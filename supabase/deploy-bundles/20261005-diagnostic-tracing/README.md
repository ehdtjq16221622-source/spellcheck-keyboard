# Pinned Supabase diagnostic deployment bundle

This source snapshot was retrieved from the live project before changing response diagnostics:
- `wallet_link_v2` version 38
- `sync_subscription_ios` version 33

The only code changes in this bundle add `diagnostic_id` and `failure_stage` to error bodies and expose `X-Kingboard-Diagnostic-ID`. The existing `audit_id` is preserved and equals the diagnostic ID.

Each function directory is a self-contained deployment bundle. Keep the two copies of `_shared` separate: the live functions were deployed with different dependency snapshots.

Validation:
`node --test supabase/deploy-bundles/20261005-diagnostic-tracing/tests/diagnostic-response.test.mjs`
