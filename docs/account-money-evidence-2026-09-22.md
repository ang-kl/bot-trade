# P2 native account-money evidence

This is a reporting contract, not the remaining risk-input migration.
Existing trader reads now capture native balance, account, broker host,
deposit asset, receipt time and currency provenance in the account's own
observation. The existing full snapshot's asset response resolves currency;
no new broker requests or connections are introduced. Asset IDs cannot be
shared across accounts or environments. The trader's original receipt time
is retained when currency metadata arrives later. No broker source timestamp
for that balance has been established, so it is explicitly null.

`GET /state/account-money?account=<registered-id>` reports fresh, stale,
unverified or unavailable evidence. It requires an explicit account and is
not HTTP-cached. Native EUR remains EUR. A USD value is exposed only for a
fresh, broker-identified USD amount; missing currency never means USD, and
unavailable balance never means zero. The existing 15-minute display age is
reused; it is not a protection or entry freshness threshold.

## Risk migration boundary

The existing `account_balance_usd` producers and consumers remain legacy
inputs. Their native-currency assumption is **not fixed by this package**.
The scalar can be used by percentage loss caps; clearing it without a
replacement policy can remove that cap. Moving those consumers requires a
separate, reviewed decision for unknown currency, missing/stale conversion,
manual USD input and last-good USD evidence. This package supplies observable
facts for that decision and for P5 accounting, without changing risk limits
or a missing-input policy. No currency conversion is invented from another
account's symbol-name cache.

## Acceptance

Tests cover currency and account/host/asset isolation, zero, missing and
malformed evidence, original receipt age, future observations and unchanged
risk inputs. Runtime acceptance requires an authenticated broker snapshot and
subsequent trader refresh on each intended account. The account roster and
that authenticated acceptance remain outstanding.
