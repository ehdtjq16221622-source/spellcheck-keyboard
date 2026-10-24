# Apple wallet session renewal candidate

Status: Owner approved the server rollout on 2026-10-24 KST. Production verification is pending.
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
