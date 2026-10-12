# Keyboard dialect and custom tone

Prepared from live correct v158. Not deployed.

- Explicitly standardize dialect only when includeDialect is true.
- Allow 400 Unicode code points in custom tone preview (previously 200 UTF-16 units).
- Credit debit, authentication, model routing, and request ID enforcement are unchanged.
- proofing_edits.ts and both _shared files are byte-equivalent to the retrieved live files,
  apart from an optional final newline.

Verification: node --test supabase/deploy-bundles/20261013-keyboard-dialect-tone/prompt.test.mjs

Deployment requires the user's production approval. Before deployment download correct
again and confirm it is still v158 or rebase this narrow change on the new live version.
Keep verify_jwt=false. Rollback: redeploy the exact v158 source and dependencies.
No database migration is needed. The iOS 400-character preview depends on this deployment.
