# Apple wallet session renewal candidate

Status: Owner-approved server rollout completed on 2026-10-24 KST. Initial production verification passed; longer observation and iOS release/device verification remain pending.
Server work continues on codex/ai-deadline-wallet-guidance; iOS renewal continues on codex/keyboard-session-renewal. Unrelated dirty files are preserved.

## Scope and security review

| Check | Decision |
| --- | --- |
| Consistency | Apple session rotation only. Expired credentials still fail correct/translate/get_credits authorization. |
| Boundaries | Rotate before 7 days remaining; allow expired old tokens strictly less than 30 days old. Exact 30-day boundary rejects. Revocation and unlink checks remain. |
| Scope | Main iOS app launch/foreground and keyboard AI requests, before automatic reconnect prompts. Both call the same shared renewal directly. No Android change. |
| Existing behavior | No wallet IDs, balances, subscriptions, merge rules or ordinary API auth rules changed. |
| Feedback | Transient network/5xx/Keychain failures retain pending state and retry later; explicit auth rejection keeps existing reconnect UI. |
| Storage | Pending next token is an optional field in the existing atomic Keychain credential. No tokens in UserDefaults/logs. Logout removes the same credential. |
| Platform | Shared actor single-flight renewal; short cross-process file locks protect Keychain staging and confirmation. Network awaits run outside the lock and do not block the UI thread. Pending tokens survive process termination. |
| Measurement | Compare error/status rates for the same three API endpoints before and after rollout. Ledger entries alone do not prove result delivery. |
| Deployment | DB -> wallet_link_v2 -> iOS app. Only this server candidate is approved. No production fixtures, unrelated AI rollout, push or app upload. |

Security tradeoff explicitly requested: possession of an expired token can authorize rotation for an extra 30 days.
A rotated old token can only retrieve its already-issued, still-active next token when the exact next hash matches (existing retry rule).
The SQL replay branch ordering is preserved, not redesigned.

## SQL and rollback

- Candidate: ../../migrations/20261024115300_apple_wallet_session_30_day_grace.sql
- Migration history version is the production apply_migration version, not the draft file timestamp.
- Previous definition: ../../sql/rollback_apple_wallet_session_30_day_grace.sql
- Live definition was read on 2026-10-24 KST: only postgres/service_role execute, SECURITY DEFINER, empty search_path.
- CREATE OR REPLACE preserves ACL/owner. Local PostgreSQL tests compare the complete body (only one predicate differs), ACL and rollback.
- Rollback restores rotation eligibility only; it does not delete sessions already issued.

## Edge function

wallet_link_v2 v62 was retrieved read-only using the connector.
The rotate_session action reads token ownership and calls the RPC without first rejecting expiry.
The candidate additionally returns expiresAt read from the actual new session. A replay must not invent another 29 days.
The SQL grace change must ship before claiming expired-session recovery works in production.
The iOS client also accepts the current expiresInSeconds response, conservatively anchored to the persisted first attempt time; an optional actual expiresAt takes precedence.
The separate Korean 401-copy rollout does not include this migration or wallet_link_v2 change.

The required check-live script confirmed wallet_link_v2 v62 matches its recorded live snapshot on 2026-10-24 KST.
Repeat immediately before any later rollout:

    node scripts/supabase/check-live.mjs wallet_link_v2

Before deployment, compare the entire candidate bundle against current live; preserve existing helper copies.
Commit only the reviewed candidate files. After owner OK, apply only the reviewed migration, not every pending repository migration.
Deploy only through:

    node scripts/supabase/deploy-function.mjs wallet_link_v2
    node scripts/supabase/deploy-function.mjs wallet_link_v2 --yes

After deployment, commit supabase/live-functions/ and supabase/DEPLOYS.md as required by AGENTS.md.
If Edge rollback is needed, restore its reviewed pre-change response code and use the same deployment script.

## Verification gate after owner approval

1. Read pg_get_functiondef and pg_proc ACL/owner/search_path again; compare with candidate.
2. Verify the deployed Edge snapshot and verify_jwt remain unchanged except reviewed source.
3. Compare 30-minute correct/translate/get_credits HTTP 401/409/5xx counts AND rates against an equal pre-deploy window.
4. Do not infer causality from low-traffic counts; retain build/user-agent splits.
5. Device checks still required: seven-day proactive renewal, expired one-day recovery, force-quit after request, offline retry, logout during request.

The 16 server checks passed again before this rollout. All runnable fixture tests use isolated local PostgreSQL or injected Swift doubles, never live customer credentials.

## Production verification (2026-10-24 KST)

- Applied only migration 20261024115300 at 20:53 KST using apply_migration. No customer fixtures or session rotations were performed.
- Read the deployed function definition back: its sole body difference from rollback is the approved expiry predicate. Definition MD5: c6e83b16ee9a2045e2bd62f34eebf400.
- Owner postgres, SECURITY DEFINER, empty search_path and ACL postgres/service_role are unchanged. anon/authenticated still cannot execute.
- Deployed wallet_link_v2 v63 at approximately 20:56 KST through deploy-function.mjs from b4b22ad, preserving verify_jwt=false. check-live reports source matches and zero unrecorded deploys for this function.
- Full helper/previous-route comparison matched live after import-path relocation normalization. Only the reviewed actual-expiry response changed.
- A random nonexistent session probe returned 404 Not found with diagnostic ID; it did not use customer credentials or create a session. Successful expired rotation was tested only in isolated PostgreSQL, not on production customer sessions.
- Re-ran the 16 focused server tests after deployment: 16 passed, 0 failed, 0 timeout, 0 skipped.
- Security advisors have no new categories/counts: the existing 22 no-policy INFO findings and one pg_net public-schema WARN remain unchanged.
- correct v174, translate v59 and get_credits v36 are unchanged. The separate AI deadline migration is absent from production history; no AI deadline rollout occurred.

Equal five-minute windows around the DB change, excluding diagnostic probes:

| Endpoint | Before 20:48-20:53 requests | After 20:53-20:58 requests | Before / after 401, 409, 5xx |
| --- | ---: | ---: | --- |
| correct | 118 | 116 | 0 / 0 in each category |
| translate | 0 | 2 | 0 / 0 in each category |
| get_credits | 11 | 36 | 0 / 0 in each category |
| wallet_link_v2 | 2 | 3 | 0 / 0 in each category |

This is an initial observation, not a completed 30-minute comparison. The window includes the DB-first, Edge-second rollout. Low traffic and log ingestion delay limit conclusions; no successful real-customer automatic renewal or end-to-end iOS result is claimed.
