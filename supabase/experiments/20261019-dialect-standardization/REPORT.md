# Dialect standardization: Supabase comparison, 2026-10-19

## Approved scope

- 30 synthetic sentences, before/after spelling with dialect ON: 60 jobs, at most 240 provider attempts, one sequential runner only.
- Separate protected Edge Function, 15-minute maximum window, explicit close in finally. verify_jwt=true plus a fresh 256-bit extra token.
- Exact live correct v167 baseline verified by check-live. Candidate adds one prompt helper and three spelling-ON branches only. Production correct is not changed or deployed.
- Existing runtime GEMINI_API_KEY is used inside Edge only; its value is never retrieved or duplicated. Only synthetic fixed text can be sent.
- Actual Supabase HTTP -> actual spelling handler, retries, deletion checks, JSON-edit fallback -> real Gemini. Wallet, credit and slow-log boundaries are simulated and cannot write to production DB.
- OFF and all tone prompts must remain byte-identical offline. Paid OFF tests are not authorized and remain blocked.

## Risk check

1. Consistency: spelling ON only, same model and parameters in both variants.
2. Failure: stop on failed/incomplete result; no outer request retry; per-job 4-provider ceiling. Per-isolate replay guard is not a global cap; only this runner receives the random token.
3. Scope: synthetic Korean dialect, mixed spelling errors, standard/ambiguous/non-Korean controls; no customer data.
4. Existing behavior: production source, auth, credits, DB and tone prompts remain untouched.
5. Feedback: preserve every result, provider finish reason, usage and timing in local synthetic report.
6. Settings: expiring extra token and JWT gateway; no public OPTIONS/CORS.
7. Platform: existing Edge runtime secrets and repository deployment script only.
8. Measurement: 30 paired outputs manually reviewed for standardization, meaning, omission and protected literals. A changed output alone is not a pass.
9. Recovery: close test gate and verify HTTP410; no production rollout or rollback needed.

## Current status

Prepared for test, not yet executed. No claim of production readiness or physical-device verification.
