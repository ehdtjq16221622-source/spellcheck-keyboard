# 2026-10-17 iOS subscription sync: plan changes, verification, failure log

**Live now: `sync_subscription_ios` v49.** `functions/` in this folder is the exact live v49 source
(downloaded from the project after deploy and compared file by file: 8/8 identical).

> Warning: `supabase/functions/sync_subscription_ios` and `supabase/functions/_shared` in the working tree are a
> different line of work and are NOT what is live. Deploying them would remove the fixes below. Merge them with
> `functions/` here first, or redeploy from this folder:
>
> `npx supabase functions deploy sync_subscription_ios --use-api --no-verify-jwt` (run from a copy of `functions/`).

Database: migration `20261017140000_subscription_sync_failures.sql` (applied; table, indexes, RLS and service-role-only
grants checked against the live schema).

Root cause: the App Store library cannot verify Apple signatures in the Edge runtime (failed 364/364 in production),
so every plan change was rejected and StoreKit JWS fell back to the app receipt. The portable verifier
(`_shared/apple_subscription_portable.ts`, already used by `wallet_link_v2`) passes 364/364.

## Version history

### v42

Deployed from a copy downloaded from the live project (never from this working tree).

| Item | Live version | Change |
|---|---|---|
| `sync_subscription_ios` | v41 -> v42 | When Apple does not yet show the new plan on a plan change, look again up to 2 more times (1.5 s, 3 s) before returning 409. The rejection code now carries Apple's reason: `apple_plan_not_confirmed:<reason>`. |
| `_shared/apple_subscription_status.ts` (this function's bundle only) | - | New `verifyAppleSubscriptionRecordWithReason`; the existing functions are unchanged. |

Reasons: signed_transaction_mismatch (Apple still shows the previous plan), subscription_not_found,
subscription_status_not_eligible, subscription_expired, subscription_revoked, signed_transaction_missing,
signed_transaction_unverified, bundle_id_mismatch, subscription_data_missing, invalid_transaction_id.
Only signed_transaction_mismatch and subscription_not_found are retried.

## v43 (same day): signature verification fallback
Production alert `apple_plan_not_confirmed:signed_transaction_unverified` showed Apple's answer was fine but the strict
verification (online certificate checks on) failed. When it fails, the signed transaction is now verified once more with
online checks off (certificate chain and signature still checked). If both fail the code carries both library status
numbers: `signed_transaction_unverified_s<strict>_o<offline>` (x = unknown).

## v44 (same day): Edge-safe verification instead of the offline library verifier
v43's offline retry also failed (`..._s1_o1`): the library's certificate handling does not work in the Edge runtime.
v44 falls back to `verifyAppleSignedTransactionPortable` (`_shared/apple_subscription_portable.ts`, the same module live
`wallet_link_v2` already runs): pinned Apple root, certificate chain at the signed date, JWS signature. Failure codes:
`signed_transaction_unverified_s<strict status>_p_<portable reason>`.

## v45 (same day): keep every failure + readable app messages
- New table `subscription_sync_failures` (migration `20261017140000_subscription_sync_failures.sql`, service role only):
  one row per failed or rejected sync (environment, stage, failure code, product, wallet ids). Telegram alerts are unchanged
  (one per wallet and failure type per day).
- Plan-change rejections now answer with the codes the shipped app already translates:
  `stale_subscription_transaction` (new plan not active) and `subscription_plan_change_unverified` (Apple did not confirm),
  instead of English sentences that the app showed as "서버 요청을 처리하지 못했어요".

## v46 (same day)
`subscription_sync_failures.detail` (jsonb) keeps the transaction facts behind a rejection: server time, purchase / expiry / signed dates, transaction ids, reason, upgrade flag.

## v47 (same day)
`detail` also records which path decided active (JWS or receipt), the verified state / expiry, and the audit event names.

## v48 (same day)
Confirmed cause (failure log, TestFlight): `jws_fallback_to_receipt:jws_verification_failed` - the library cannot verify StoreKit JWS in the Edge runtime, the stale app receipt (newest premium transaction expired 2026-10-11) decided "plan not active". `verifyAppleTransactionJws` now falls back to `verifyAppleSignedTransactionPortable` per environment. Receipt and JWS paths use the same grant key (originalTransactionId + expiry ms), so grants stay idempotent.
Rollback: redeploy the v47 copy.

## v49 (same day)
The app now sends `clientDiag` (StoreKit entitlements snapshot) and `syncOrigin`; both are stored in `subscription_sync_failures.detail`.

## Reconciliation (2026-10-17)
Temporary read-only function `subscription_plan_audit_tmp` (token-locked; source kept here as
`subscription_plan_audit_tmp.index.ts`, deleted after use) compared all 364 active subscriptions with Apple:
- Library verification failed for 364/364 in the Edge runtime; the portable verifier passed 364/364.
- 9 wallets had paid for a higher plan (Apple: active, PURCHASED, no offer; KRW 2,200 premium / 6,600 pro)
  while the server kept the lower plan and never granted the higher plan's credits.
  Fixed with `sync_ios_subscription_once` (same grant key as the app sync; metadata source `reconcile_20261017`).
  Re-audit: 9/9 match Apple.
- Left as is: 1 wallet (001647…) revoked at Apple but ACTIVE on the server, 0 credits; 3 scheduled premium -> basic downgrades.
