# Linked guest install-bonus race (prepared, not deployed)

The seven function files start as byte-for-byte copies of live `wallet_link_v2` v51
at commit `e4789d8`. A concurrent `register` can be delayed by DeviceCheck while
Apple linking changes the same wallet from `active` to `linked`. The v51 bonus
RPCs then raise `Wallet possession proof failed` and the request ends in 500.

The migration lets the *same wallet secret* complete a DeviceCheck-confirmed
bonus after linking. It keeps the DeviceCheck lock, one-claim row, the
`install_bonus`/`install_bonus_restore` guard, and the transaction idempotency
key. A linked wallet must have an Apple owner; an unlinked wallet must not.
Before DeviceCheck enrollment and again before payment, a linked wallet is
checked for another install bonus associated with its Apple account (direct
owner, alias, link attempt, or legacy Apple-subject wallet). An existing grant
is left for review; it is never paid automatically. The register response
does not expose an Apple-linked wallet's balance to a guest secret.

This fixes the observed fast-Apple-link 500 path; it does not pay unverified
devices, repair historical missing credits, or remove the eight-second global
DeviceCheck lock/503 under sustained load. A linked wallet whose initial
request had no usable DeviceCheck token still needs an app-side retry using
its original guest credential. Do not enable restore cron job 5.

## Checks

```powershell
node --test supabase/tests/wallet-postgres-sandbox/linked-guest-bonus-race.test.mjs
node --test supabase/deploy-bundles/20261013-apple-link-bonus-race/tests/*.test.mjs
```

Before production: review the migration, rollback SQL, and a single-request
transactional rollback trial against the current live schema. Get explicit
approval. Keep `verify_jwt=false` and all v51 environment variables unchanged.
Apply `20261013071028_handle_linked_guest_bonus_race.sql` **before** deploying
this bundle's `wallet_link_v2/` and `_shared/` files. Download the deployed
function and compare all seven files with the approved bundle; the diff must
be zero. Monitor register 201/409/500/503, bonus payment rate, zero-balance
linked wallets, and duplicate grants.

If any check fails, redeploy v51 from pushed commit `e4789d8` first, then run
`supabase/sql/rollback_linked_guest_bonus_race.sql`. Rollback restores the
previous RPCs and removes the new lookup function. It preserves all wallets,
claims, transactions, and balances created while this version was live.
