# Dialect spelling-only release, 2026-10-19

## Approval and scope

User reviewed the paired 30-sentence report and approved this exact candidate. Only spelling with includeDialect=true changes. Spelling OFF, all tone/custom-tone prompts, translation, models, output caps, request authentication, credit cost (10), refunds and DB schema remain unchanged.

The existing one standard-language control rewrite (구먼 -> 네요) and two nuanced rewrites were disclosed before approval. Do not claim perfect linguistic accuracy. Do not silently modify the tested prompt to address them in this release.

Source SHA256 must equal the already-tested candidate 5cdb42fcdc7bee51fb8a548664a902fd362fdf7a30c667b90989eed949b834f2.

## Validation

- check-live confirmed correct v170 matches recorded live and the source before editing.
- Paired protected Supabase experiment: 60/60 jobs, 60 actual provider calls, no HTTP/correction failures or incomplete outputs; explicit test closure HTTP410. Wallet/DB boundaries were simulated.
- This release changes index.ts only: one helper and three spelling-ON branches. All other deployed dependency files must match the frozen baseline.
- Local tests compare unchanged prompts and full handler requests, including charge/response shapes. No additional paid run, customer wallet or DB mutation is required for deployment checks.
- After deployment: download and compare every source file, assert ACTIVE/verify_jwt=false, check CORS/missing-request-ID/invalid-preview rejection without AI/DB, verify both temporary probes remain closed, inspect aggregate error logs. Do not treat a small initial sample as long-term proof.

## Rollback

`baseline/supabase/functions/correct/` contains exact v170 code (same source as v167). To undo, restore only changed correct/index.ts from this committed baseline into supabase/functions/correct, commit and push that reversal, dry run `node scripts/supabase/deploy-function.mjs correct`, then deploy with `--yes`. Verify live source and commit live-functions/DEPLOYS.md afterward. No SQL or balance reversal is needed.

## Deployment result

Deployed correct v171 from pushed commit 434c739 at 2026-10-19 19:18:48 KST. ACTIVE, verify_jwt=false; all four downloaded source/dependency files match. Post-deploy local scope/routing/response/probe checks: 77 passing. Deno source check passed before deployment.

Runtime rejection checks passed (CORS200, missing-request-ID409, invalid-preview400). Both temporary probes remain closed (410). The first 16 seconds of aggregate logs showed six POST200 responses, no recorded 5xx or AI/incomplete/refund failures; the sample is too small and logs may lag. This is not a new paid linguistic test or proof of long-term reliability.
