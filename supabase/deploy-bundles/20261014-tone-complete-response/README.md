# Complete Tone Responses (Candidate, Not Deployed)

## Baseline And Scope

- Production project: `ltjhlaprtjgmmijfnmri`; function: `correct` v162 ACTIVE.
- Downloaded baseline was rechecked against live v162 on 2026-10-14 KST.
- `verify_jwt=false` stays unchanged. No DB migration is needed.
- `baseline/` preserves all four downloaded files; `release/` contains the candidate.
- Only `correct/index.ts` differs. Authentication, credit handling and
  `proofing_edits.ts` are unchanged. The dirty main working copy is not a release source.
- No production endpoint, wallet, balance, schema or deployment was changed for these tests.

## Confirmed Defects And Limits

The live implementation accepts an interrupted Gemini response as success and
reads only the first response text part. Local execution of the actual downloaded
function with mocked responses reproduces both defects. This establishes a code
defect, not the exact cause of the user's particular production request.

The app stores the returned result without a length cap in the inspected result
pipeline. Collapsed result preview can hide lines visually, but the user also
observed truncation in the expanded result. Input context limits and intentional
model rewriting remain separate possible causes; these are not ruled out by this fix.

## Candidate Changes

1. All seven built-in Gemini tones keep the existing model, prompts, temperature
   and medium reasoning. Raise the response budget from 1000 to 4096 tokens.
2. Require `finishReason=STOP`. Reject incomplete, blocked or missing completion
   status instead of returning partial text as success.
3. Concatenate every visible text part in order, excluding thought/non-text parts.
4. Log only diagnostic ID and categorical completion failure, never candidate text.
5. Use the existing error/refund path. Do not introduce automatic additional AI calls.

The custom Luna route already checks incomplete status and joins output parts;
its 4000-token cap remains unchanged. The spelling route is unchanged.
User credit cost remains 30 for tone correction, but provider cost/latency can rise
when longer generation uses the increased maximum. A maximum is not a fixed charge.

## Verification

Run from the bundle directory:

```powershell
node --test response.test.mjs
```

Result on 2026-10-14 KST: **21 passed, 0 failed**. Executes the actual baseline and
candidate handler with isolated mock provider/auth/DB dependencies, covering:

- Old partial success and dropped second part reproduced.
- Visible multipart joining and thought exclusion.
- MAX_TOKENS, SAFETY, RECITATION, absent status, and empty visible response rejection.
- One existing consume/refund attempt; no duplicate refund for already-processed requests.
- Seven built-in tone routes; prompt/model/temperature/reasoning preserved.
- Spelling route unchanged; custom completed/incomplete behavior unchanged.
- Request-ID guard, insufficient credits, and custom preview unchanged.
- All shared files identical to baseline.

These checks do not verify a real database refund, native iOS compilation,
end-user diagnosis, or real-provider repeated output quality. Direct provider
comparison using the reported source sentence remains pending. Do not describe
this candidate as a deployed fix or guaranteed prevention of semantic omissions.

## Risk Review

| Check | Result |
| --- | --- |
| Consistency | All seven built-in tones share the response guard; custom checked separately. |
| Failure/boundaries | Incomplete output fails safely; original refund logic retained. |
| Scope | Server correct only; no app release or DB migration required. |
| Conflicts | Auth, wallet, billing, prompts, models and spelling unchanged. |
| Feedback | Existing temporary AI error shown instead of truncated success. |
| Settings/accessibility | No new setting or UI permission. |
| Platform | Existing Gemini REST response fields; no dependency added. |
| Measurement | 21 local mock checks; production failure rate and real-provider comparison pending. |
| Release/recovery | Approval required; deploy pushed candidate only; restore baseline v162 code if needed. |

## Deployment And Rollback (Approval Required)

1. Before approval/deployment, re-download live `correct` and compare all files
   with baseline. If production has changed, stop and reconcile the new baseline.
2. After approval, deploy only the pushed `release` bundle, with `verify_jwt=false`.
   Never deploy unrelated dirty working-tree files or main.
3. Download the deployed function and verify zero content differences against
   the committed release; confirm auth/shared files and verify_jwt unchanged.
4. Monitor ordinary correction errors plus tone incomplete errors, credit refunds
   and response latency. Do not infer user counts from request counts.
5. If a regression is established, redeploy the committed baseline v162 code with
   `verify_jwt=false`. Supabase will assign a new version number. No SQL rollback
   is required; already-issued responses/transactions are not erased.

## Official References

- https://ai.google.dev/gemini-api/docs/generate-content/thinking
- https://ai.google.dev/api/generate-content
