# Rules for agents working in this repo

## Supabase Edge Functions: deploy only through the script

Live functions and this repo drifted apart (on 2026-10-17 only 1 of 36 live functions matched a commit).
Fixes made here never reached production, and deploys from other copies silently removed live fixes.
To keep "what is live" = "what is committed":

1. **Deploy only with** `node scripts/supabase/deploy-function.mjs <slug>` (dry run), then `--yes`.
   It refuses uncommitted files, shows what changes against live, keeps the live `verify_jwt` setting,
   checks the live source afterwards, and records it. Never run `supabase functions deploy` by hand,
   never deploy from a scratch or temp copy.
2. **After every deploy, commit** `supabase/live-functions/` and `supabase/DEPLOYS.md`.
3. **Before changing a function**, run `node scripts/supabase/check-live.mjs <slug>`.
   `supabase/live-functions/<slug>/` is the exact live source; `supabase/functions/<slug>/` may differ.
   Start from the live source unless the difference is work that is meant to ship.
4. To see drift for everything: `node scripts/supabase/check-live.mjs` (exit 1 = someone deployed
   without recording it). To re-record live: `node scripts/supabase/live-snapshot.mjs [slug]`.

Known drift on 2026-10-17: `supabase/functions/sync_subscription_ios` and `supabase/functions/_shared`
are older/other work. Deploying them would remove the iOS subscription fixes (Edge-safe Apple signature
verification, plan-change handling, failure log). See
`supabase/deploy-bundles/20261017-plan-change-confirm-retry/README.md`.

The scripts need `SUPABASE_ACCESS_TOKEN` (Supabase account token) in the environment. Never commit tokens.

## Admin endpoints

`admin_stats` and `trigger_test_notification` require the `x-admin-token` header (Supabase secret
`ADMIN_API_TOKEN`). On the owner's PC the token is in `~/.kingboard/admin-token`;
`node scripts/supabase/admin-stats.mjs [deviceId] [--history]` uses it. Never print or commit the token.
