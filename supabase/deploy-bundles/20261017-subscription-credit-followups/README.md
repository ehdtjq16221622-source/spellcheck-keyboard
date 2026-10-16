# 2026-10-17 subscription credit follow-ups

Deployed from copies downloaded from the live project, never from this working tree.

| Item | Live version | Change |
|---|---|---|
| `sync_subscription_ios` | v40 -> v41 | `WalletAccessError` sets `this.name`, so wallet rejections alert as `wallet_access_rejected` instead of `stage_canary_classification` (only `_shared/wallet_auth.ts` changed; the copy kept here is the live v41 file). |
| `apple_notifications` | v28 -> v29 | Production `DID_RENEW` grants the cycle's credits; `REFUND` revokes the refunded cycle's subscription credits. Failures are logged only. |
| DB functions | new | `grant_subscription_credits_on_renewal`, `revoke_subscription_credits_on_refund` (migration `20261017015500_...sql`). |

Safety: grants use the same key as the app sync (`originalTransactionId:productId:expiryMs`), skip wallets that
are missing, aliased or ambiguous, and never grant for a past cycle. Verified with rolled-back tests against real data.

One-off: the refunded premium wallet's unused 9,000 subscription credits were revoked through the new function
(ledger type `subscription_refund_revoke`, notification id `manual-20261017-refund-cleanup`).
