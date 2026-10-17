# Historical mixed working sources

These fourteen `.ts.txt` files preserve the working files from before the live-source recovery.
The `tests/` folder preserves the original assertions before live-contract cleanup.
The latest seven source copies are reference-only: diagnostics and shared-path differences
must be reviewed individually before any future feature is promoted.
They intentionally contain old paths and missing live guards. DO NOT deploy or copy them over
the recovered functions. Review their differences against live; only the selected pending features
were re-applied in the separate commits above `311b02f`.

Compatibility/X509 and subscription diagnostic work were retained on the independent subscription
integration branch. Other pre-existing files and edits in the owner's original worktree were left
untouched and were not swept into these commits.
