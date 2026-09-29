# Wallet rollout gates

This is a test plan, not permission to deploy or transfer balances.

## 2026-09-30 audit update

The older snapshot below describes the initial implementation, not the live
deployment. Production `sync_subscription_ios` v24 still uses the atomic RPC
only for allowlisted wallets, and production `link_apple_user` v14 still has a
delete-before-move path. The newer iOS login can fall back to that legacy
endpoint when v2 linking is unavailable; older clients can switch local wallet
identity before checking whether the link succeeded. Do not enable all-user
wallet migration on the basis of the canary tests alone.

The local plan-change patch consists of
`20260930034000_verified_ios_subscription_plan_change.sql` and the matching
`sync_subscription_ios` Edge code. It checks Apple's current product before an
atomic plan change, rejects stale expiry, replaces rather than sums monthly
subscription credits, and leaves the existing paid-credit bucket intact.
The Edge tests and PGlite rollback/retry tests passed locally; neither patch
has been deployed. Deploy the SQL before the Edge code, then verify an
allowlisted TestFlight wallet before considering a wider rollout.

Read-only reconciliation found a production active subscription whose current
wallet has zero subscription credits while the latest-cycle grant record is on
an unaliased former wallet. That account needs separate verified recovery;
neither a ledger record nor a successful local test proves spendable credits.
No account balance was changed by this audit.

Current local state (2026-09-26): wallet sessions, a canary-only Apple link
endpoint, atomic verified guest/Apple merges, and guest 500/zero registration
are implemented behind `WALLET_SESSIONS_ENABLED`, `WALLET_GUEST_V2_ENABLED`,
and `WALLET_LINK_V2_ENABLED`. Runner and KeyboardExtension now have a shared
Keychain credential store, wallet-scoped request headers, guarded cache updates,
fresh-install provisioning, and the Apple sign-in/logout flow. The iOS code has
not been compiled on Xcode in this environment, and no production migration,
edge deploy, or balance transfer was performed. Keep all three flags off until
the signed Codemagic build passes and the server migrations/functions are
deployed in the staged order.

The one-time free policy is: if either wallet has a recorded free-credit debit,
keep the destination wallet's remaining free balance and discard the source's
remaining installation bonus; otherwise keep `max(remaining free)`, never the
sum. An absent debit record is not proof of no historical use, so uncertain
history requires review. Paid balances are added once only for the verified
pair; any source
subscription balance or purchase mapping blocks automatic merge. An unclear
historical wallet remains unchanged. New unauthenticated installs retain the
500-credit offer. The v2 `register` action grants 500 and is idempotent for
the same proof; `register_after_logout` grants zero. It is still not a
production replacement because a new proof can request another 500. Keep
`WALLET_GUEST_V2_ENABLED` off until anti-repeat controls and a signed-device
test are complete. Monitor and rate-limit repeated issuance, but do not claim perfect person-level
deduplication without a stable identity. If historical usage is incomplete,
preserve the user's existing balances for review instead of erasing them.

| Case | Current safe decision | Required before release |
| --- | --- | --- |
| Device wallet only | Keep its balance; do not claim a public ID without account evidence | Verify an existing Apple association or use reviewed support migration |
| Apple wallet only | Continue with the Apple wallet | Check display, AI debit, ad grant, subscription grant, logout/relogin |
| Both wallets with verified Apple association | Merge once into the spending wallet; free=max, paid=sum, source zeroed but retained | Active Apple wallet session, idempotency, paid/ad history and subscription exception checks |
| Both wallets without verified association | Preserve both, no automatic transfer by typed device ID | Ownership evidence or reviewed support migration |
| Already linked device wallet | Use the linked canonical wallet | Verify the link is authentic and all old IDs resolve consistently |

For a fresh install with no existing legacy device ID or Keychain guest ID, the
new app first attempts a server-issued v2 guest wallet with 500 credits and
switches only after activation succeeds. If the feature endpoint is unavailable,
it falls back to the legacy guest path. After a v2 Apple logout, the app requests
a separate zero-credit guest wallet, revokes the Apple session, and switches
only after both server operations succeed. Existing legacy installs are not
silently moved because they have no possession proof for the old UUID.

The local PGlite tests cover synthetic balance preservation, rollback, retry,
duplicate AdMob transaction IDs, and these classifications. They do not prove
historical device ownership, actual App Store/AdMob callbacks, concurrent
production traffic, or iOS 2.8/2.9 behavior on a physical phone.

The legacy merge Edge route additionally requires
`WALLET_LEGACY_MERGE_ENABLED=true` and an exact Apple-subject/source-wallet
entry in `WALLET_LEGACY_MERGE_CANARY_PAIRS`. Leave both unset for general
traffic. This configuration is an operator-reviewed canary boundary, not proof
that the historical source wallet belongs to that Apple user; do not widen it
from a public device ID alone.

The currently deployed Apple link endpoint is shared by older app versions.
The iOS 2.8-era sign-in path could switch its local identity even if server
linking failed. Changing that endpoint globally without old-version tests is
therefore a release blocker. The v2.9 path waits for server confirmation, but
the old path remains in circulation.

The ad RPC migration is additive. Deploy it before the updated SSV callback;
then use a controlled, verified callback to compare a single transaction ID's
ledger row and paid balance. Check retries and SSV errors before widening.
Do not use a synthetic unsigned request as a production reward test.
