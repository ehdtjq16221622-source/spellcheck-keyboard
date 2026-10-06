# Activate-session linked wallet merge

Based on the production `wallet_link_v2` v40 bundle. The API now invokes the existing `merge_linked_apple_subject_wallets_once` RPC after Apple identity verification and successful session activation, but only while the existing all-user merge rollout flag is enabled.

The RPC still proves the session's Apple subject and canonical wallet, locks and reconciles the two wallet rows atomically, applies the existing free-credit and paid-credit rules, and rejects subscription mappings or ownership conflicts for review. No arbitrary device wallet IDs are accepted. Exact no-source results are reported as `no_linked_source`; an existing matching alias is idempotently reported as `already_merged`; review cases remain explicitly `review_required`. The request key is a deterministic hash-derived value, not the raw Apple subject.

No schema, RLS, feature flag, secret, bonus amount, debit rule, or subscription rule is changed. No production balances are changed during deployment; future authenticated `activate_session` calls may perform the pre-existing approved atomic merge. This is a balance-affecting server path and is authorized only within the user's existing wallet-link resolution request.

Deploy the files under this bundle's `_shared/` and `wallet_link_v2/` directories with entrypoint `wallet_link_v2/index.ts` and preserve `verify_jwt=false` (the function validates Apple identity and wallet session itself).

Tests:

```powershell
node --test supabase/deploy-bundles/20261006-activate-linked-wallet-merge/tests/*.test.mjs
```

Rollback code target: the `20261006-wallet-link-retry` bundle. Redeploying it stops this activation-triggered attempt but does not reverse merges already completed.
