# Tone completion release - 2026-10-19

## Authorization and evidence

The user authorized continuing the truncation repair, testing, deployment and verification without another approval prompt. This release changes `correct` response handling only. It does not deploy the separate dialect prompt work or alter iOS, subscription logic, DB schema, balances, prices or credit accounting rules.

Build 844 device evidence at 16:16:41 KST: 82 source characters; 53 raw response characters; 53 received/stored/displayed characters. The supplied screenshot ends mid-sentence. This localizes that incident before client display/application, but does not identify the provider's termination reason.

## Baseline and scope

- Fresh official-script comparison succeeded against ACTIVE `correct` v163 and its recorded four-file snapshot before creating this release.
- The response candidate is isolated on `codex/tone-complete-response-20261019`; the original dirty worktree is preserved.
- Built-in tones retain their prompts, model, temperature and reasoning setting. Maximum output budget changes from 1000 to 4096.
- Join every visible text part in order; ignore thought/non-text parts. Require completed provider status before success, including the custom tone path.
- Incomplete output uses the existing failure/refund path. No automatic regeneration of incomplete output, credit-price change, or new DB write path is added.
- Opt-in authorized diagnostics record numeric lengths and fixed status categories only. No sentence, prompt, token, provider exception or wallet identifier is added to logs.
- All 134 prompt combinations and three supporting auth/credit/proofing files must remain identical to baseline.

## Temporary real-server comparison

`tone_completion_probe` is a separate, committed test function. It contains generated copies of the exact baseline/candidate handlers with simulated wallet and credit boundaries, not real DB/client implementations. Four synthetic cases, two repetitions and both variants produce 16 sequential jobs; each job permits at most one provider call. There are no automatic request retries. Only the fixed Gemini endpoint is allowed. Customer text, arbitrary prompts, URLs, models and wallets are not accepted.

Keep platform JWT verification enabled. Additionally require a fresh in-memory 256-bit probe token and an explicitly open control secret with at most a 10-minute window. The runner closes the control in `finally` and checks HTTP 410. The per-isolate replay set is not a project-wide billing cap; the sequential runner is executed only once. Existing runtime Gemini credentials stay in Supabase and are not downloaded or printed.

## Deployment and recovery

Deploy only via `node scripts/supabase/deploy-function.mjs <slug>` dry run, then `--yes`. Push the exact source commit first. Preserve the live `verify_jwt` setting. Download/compare afterward and commit the resulting live snapshot and deployment log.

If correction errors materially regress, restore only `correct`'s four files from the pre-release snapshot in a new commit, push it, then use the same deployment script. Do not rewind unrelated files or remove transactions. The probe remains explicitly closed after testing.

## Verification status

Prepared: response/trace/routing tests 54 passed; probe safety tests 8 passed; Deno checks for both function entry points passed. Additional final scope tests, paid results, source commit, deployment version and post-deploy checks are recorded below when actually completed. A mock refund test is not certification of an operational refund.

## Real-server test results

- Initial source commit `b793816` was pushed before the locked probe deployment. Probe v1 was deployed using the repository script, live source matched all four files, and deployment records were committed as `dca512e` and pushed.
- Prompt/auth scope tests: 2 passed, including 134 exact prompt comparisons; total focused source/safety tests: 64 passed. Both entry points passed Deno type checking.
- Paid comparison: 16 sequential Supabase jobs / 16 provider calls, with no retries and no actual wallet/credit/DB operations. Before: 8/8 HTTP 200 and provider STOP; after: 8/8 HTTP 200 and provider STOP.
- Manually read all eight synthetic after-results: no mid-sentence endings; the key instructions, negative conditions and final requests remained present. This is a small synthetic sample, not a population-wide quality or latency guarantee. The original intermittent truncation did not reproduce in these eight baseline calls.
- Result file: `reports/tone-probe-results-20261019.json`. It contains synthetic sentences/results and token usage, not customer input, keys or wallet data.
- Control was explicitly closed in the runner's finally block and an authenticated request returned HTTP 410. No runtime provider key was exported.
- Connector log reads still fail with a permission error; do not translate a failed lookup into zero errors.
