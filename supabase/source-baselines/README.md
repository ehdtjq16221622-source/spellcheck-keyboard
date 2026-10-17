# Recorded live recovery

The 2026-10-18 recovery preserves seven high-risk live bundles in their own function directories.
Only entrypoint imports from `../_shared/` become `./_shared/`; dependency contents are unchanged.
This prevents the five live wallet-auth variants from overwriting each other during source recovery.

Run `node --test supabase/tests/live_source_recovery.test.mjs` to compare the actual source with the
recorded snapshot and ensure local dependencies exist. The test also executes the current AI
entrypoints' missing-request-ID rejection without DB or AI calls.

The source recovery is not a deployment. Pending work and subscription integration belong on
separate branches based on the recovery commit. Use the repository deployment script only after
the owner's Sandbox and release checks. Line endings are normalized; intentional live EOF blank
lines remain to preserve the recorded source.
