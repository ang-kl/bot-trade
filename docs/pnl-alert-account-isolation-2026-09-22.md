# P2 alert account isolation

The P&L watch queried the broker using `creds.accountId` but divided results by
the selected account's balance, joined every account's monitored rows by broker
position ID and deduplicated notifications with an account-free state key.
Two accounts with the same position ID could suppress or mislabel each other's
alerts and use different denominators for the same threshold.

The watch now requires an explicit broker account, reads its own balance, matches
uncontradicted ownership on the joined trade/monitor and uses an account-scoped
notification step key. Ambiguous duplicates are excluded. Each alert names the
account suffix. The existing threshold, direction-reset rule, toggle and delivery
transport are unchanged. A missing/zero own balance still means no percentage
comparison; a foreign balance never supplies it.

Unattributed legacy step keys are retained but not copied into any account.
Consequently the first valid threshold crossing after deployment may notify once
again. Copying an ambiguous old key would silently suppress another account.

Tests execute the real consumer with injected broker reads and message sinks,
different balances, duplicate position IDs across accounts, conflicting/unknown
ownership, independent suppression and missing inputs. No Telegram message was
sent by validation. Full repository/PR gates and controlled deployment apply.

Local full gate on main `39fd687`: 5,237 Node passes and one existing skip;
911 Vitest passes; zero-warning ESLint, production build, no-green and syntax
checks pass. Every Node test file ran with one concurrent file. PR CI remains
required; delivery/runtime acceptance is not inferred from an injected sink.

This does not implement the independent watchdog, guarantee message delivery or
complete native-currency accounting. The existing USD labels and balance producer
money contract remain P2 follow-ups; no conversion or new alert policy is invented.
