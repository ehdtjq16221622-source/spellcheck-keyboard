# Wallet reconnect response copy

Prepared only; not deployed. The seven source files were copied from the
`20261012-require-ai-request-id` bundle after verifying every file matched
live `correct` v158 and `translate` v46. Only the two copied `wallet_auth.ts`
files have been changed.

For a missing token on a protected legacy wallet, ask the user to sign in to
the same Apple account and complete the wallet connection prompt. For a v2
wallet, ask the user to check wallet connection in the app. Request-ID errors
retain `APP_UPDATE_REQUIRED`; authorization rules, status codes, and the
response shape are unchanged.

Run `node --test message.test.mjs` before deployment. Deploy only after
approval and a fresh live-file comparison. Roll back `correct` to v158 and
`translate` to v46 independently if either function regresses.
