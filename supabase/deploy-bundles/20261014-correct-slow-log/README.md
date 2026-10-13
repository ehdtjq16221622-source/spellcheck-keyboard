# correct v160: slow spelling log

Deployed 2026-10-14. Built from a download of live `correct` v159 (Codex dialect/tone bundle);
only `index.ts` changed (+26 lines): spelling requests slower than 10s insert a row into
`public.ai_slow_requests` (kind, duration_ms, outcome; no wallet or text) via EdgeRuntime.waitUntil.

Read by `service_monitor` (pg_cron job `kingboard_service_monitor`, every 5 min, header secret in
vault `kingboard_service_monitor_secret` / env `SERVICE_MONITOR_SECRET`), which sends Telegram
alerts for >=3 slow spellings in 5 min and for pending guest wallets (>=5 and >=3% of signups).

Rollback: redeploy the v159 download (this folder minus the recordSlowRequest change).
