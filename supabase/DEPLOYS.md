# Edge Function deploys

| date (UTC) | function | version | commit |
|---|---|---|---|
| 2026-10-17 19:37 | referral | v14 | 44d5941 |
| 2026-10-17 19:49 | 10 benchmark functions | deleted | (source in supabase/archived-functions) |
| 2026-10-20 16:29 | subscription_apple_reconcile | v1 | 10d806c |
| 2026-10-20 16:38 | daily_digest | v36 | 848e30a |
| 2026-10-20 16:39 | sync_subscription_ios | v59 | 848e30a |
| 2026-10-24 08:49 | correct | v174 | d7855cd |
| 2026-10-24 08:49 | translate | v59 | dd3c834 |
| 2026-10-24 08:49 | get_credits | v36 | 2c47475 |
| 2026-10-24 08:50 | daily_checkin | v32 | 95a752a |
| 2026-10-24 08:50 | language_study_generate | v16 | 5eb814e |
| 2026-10-24 08:50 | redeem_coupon | v33 | 217f361 |
| 2026-10-24 08:51 | sync_credit_usage | v29 | b4bbbc0 |
| 2026-10-24 08:51 | sync_subscription | v31 | d73e3f4 |
| 2026-10-24 08:52 | sync_subscription_ios | v60 | c73bd6f |
| 2026-10-24 11:56 | wallet_link_v2 | v63 | b4b22ad |
| 2026-10-25 12:28 | correct | v175 | d1df0f0 |
| 2026-10-25 12:30 | translate | v60 | 7caf943 |
| 2026-10-25 12:32 | get_active_notice | v26 | 5373675 |
| 2026-10-26 15:47 | subscriber_status | v29 | b3e5402 |
| 2026-10-26 15:50 | subscriber_status | v30 | d52ebd5 |
| 2026-10-26 15:55 | daily_digest | v38 | edd24f8 |
| 2026-10-26 15:56 | apple_notifications | v39 | dde3f47 |
| 2026-10-27 17:31 | apple_notifications | v40 | 3b40ed6 |
| 2026-10-27 17:32 | daily_digest | v39 | d6eb2ce |
| 2026-10-27 17:32 | subscription_apple_reconcile | v3 | f5912b1 |
| 2026-10-27 17:33 | sync_subscription_ios | v61 | 0f3d307 |
| 2026-10-27 19:58 | apple_notifications | v41 | f178f14 |
| 2026-10-27 19:59 | daily_digest | v40 | 667711c |
| 2026-10-27 20:00 | subscription_apple_reconcile | v4 | 4b4c613 |
| 2026-10-27 20:02 | sync_subscription_ios | v62 | 17aa81d |
| 2026-10-27 20:03 | service_monitor | v12 | 7cf66c5 |
| 2026-11-12 12:36 | apple_notifications | v47 | ebca88f |
| 2026-11-12 12:36 | sync_subscription_ios | v67 | ebca88f |
| 2026-11-12 12:36 | wallet_link_v2 | v67 | ebca88f |
| 2026-11-12 12:37 | subscriber_status | v33 | ebca88f |
| 2026-11-12 12:37 | daily_digest | v43 | ebca88f |
| 2026-11-14 17:04 | DB: migrations 20261114100000 / 110000 / 120000 (Google accounts, Play packs, subscriptions v2, sign-up bonus) | applied | e39e816 |
| 2026-11-14 17:05 | wallet_link_v2 | v68 | e39e816 |
| 2026-11-14 17:05 | credit_pack_purchase | v2 | e39e816 |
| 2026-11-14 17:05 | sync_subscription | v34 | e39e816 (live credits.ts / subscription_audit.ts kept: no Max plan) |
| 2026-11-14 17:05 | google_play_notifications | v1 | e39e816 |
| 2026-11-14 17:06 | correct | v178 | live v177 + language_prompts.ts (branch correct source is behind live; do not deploy it) |
| 2026-11-16 04:07 | DB: migration 20261115100000 (sync_google_subscription_v2_once replaced; same signature and grants) | applied | 43f3a12 |
| 2026-11-16 04:08 | credit_pack_purchase | v3 | 43f3a12 |
| 2026-11-16 04:08 | sync_subscription | v35 | 43f3a12 (live credits.ts / subscription_audit.ts kept: no Max plan) |
| 2026-11-16 04:08 | wallet_link_v2 | v69 | 43f3a12 |
| 2026-11-16 04:08 | google_play_notifications | v2 | 43f3a12 |
| 2026-11-16 04:09 | correct | v179 | 43f3a12 (live credits.ts kept: no Max plan) |

## 2026-10-25 AI recovery and optional benefit database rollout

| committed migration | production migration version |
|---|---|
| 20261024080206_ai_request_deadline_correlation.sql | 20261025122620 |
| 20261025091650_ai_refund_retry_ledger.sql | 20261025122621 |
| 20261025093344_subscriber_benefit_campaigns.sql | 20261025122623 |

Verified at 2026-10-25 12:35 UTC: 98 completed AI attempts, zero overdue recovery rows,
zero negative wallets, nine successful recovery scheduler runs, zero active benefit campaigns.
The production rollback-only debit/refund probe passed and left zero probe wallets.
Correct/translate/notice live source matches the recorded commits. AI provider work is
limited to 10 seconds; wallet lookup, ledger calls, and client delivery are outside that budget.
Server tests: 230 passed. Isolated database tests: 44 passed. iOS source/Swift logic tests:
494 passed, zero failed, one UIKit/ImageIO simulator test skipped. No new iOS archive or
physical-device ad callback/benefit popup verification was performed in this rollout.
