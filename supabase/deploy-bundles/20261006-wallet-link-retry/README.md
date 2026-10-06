# Wallet-link retry deployment bundle

This bundle is based on the reviewed `20261005-diagnostic-tracing` snapshot. Before deployment, the live `wallet_link_v2` version was confirmed as 39; its source matched that snapshot's wallet-link entrypoint.

The wallet-link change is restricted to `merge_linked`:
- Verify the current Apple wallet session belongs to the verified Apple subject and its canonical wallet.
- Return `already_merged` for an exact existing alias so a retry does not hit the alias uniqueness constraint.
- Return `no_linked_source` only for the two exact database outcomes that mean there is no second linked wallet.
- Keep all other transfer-review outcomes fail-closed with HTTP 409.

No balance calculation, credit amount, transaction, merge rule, database schema, RLS, or secret is changed. No customer balance is written by this code path except through the pre-existing authenticated, atomic, idempotent merge RPC.

Deploy only the files beneath `wallet_link_v2/`, with entrypoint `wallet_link_v2/index.ts`. Keep the versioned `_shared` snapshot with it. Existing production function has `verify_jwt=false`; the handler performs its own Apple/session validation, so preserve that setting.

Validation:
`node --test supabase/deploy-bundles/20261006-wallet-link-retry/tests/diagnostic-response.test.mjs`

Rollback target: redeploy the previously captured `20261005-diagnostic-tracing/wallet_link_v2/` bundle (the source verified against live version 39), restoring prior response semantics. This does not reverse any already completed merge operations.
