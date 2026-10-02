# C·1 currency: PR-1, labels and provenance (03-10-2026)

Owner, 02-10-2026 (№ 10,572·C ¶C·1): the currency "should be SGD". Owner, 03-10-2026: "C·1 currency in SGD."

## What is measured (read-only, 02-10-2026 18:05Z = 03-10 02:05 SGT)

The broker's trader response and asset list already give a verified deposit currency per account (`GET /state/account-money?account=<id>`):

| account | currency | balance |
|---|---|---|
| …3489 (live) | SGD | 51.41 |
| …7342 | SGD | 3,102.80 |
| …0949, …9908, …0058 | USD | 43,098.40 · 697.83 · 30,197.32 |
| …9009 | USD | 0 |

The broker's NATIVE balance is stored unchanged under `acct:<id>:account_balance_usd`. Nothing converts it. Surfaces that print that stored number with a dollar sign or "USD" label are wrong for the two SGD accounts.

## PR-1: labels only (this change)

No stored value, no risk input and no limit changes. The unit is read from the broker-verified evidence (`services/balance-unit.js`); an unverified unit is `null` and a label says "currency unverified" instead of guessing.

- Telegram account lines and the `/status` balance line print "SGD 51.41", not "$51.41". The status line now reads the selected account's own stamped balance, not the legacy global key that belongs to whichever account refreshed it last.
- The daily-stop explanation names the % check in the account's currency ("above SGD 1.54 from the % check"). The USD 200 floor stays USD: that is how the limit is configured.
- `balanceCurrency` is added beside the balance on `/state/health` (`broker`), `/state/risk-config` (`derived`), `/state/perf-ledger` and `/state/profit-ratchet` (`accounts[]`).

## Not in PR-1 (PR-2, ask-first)

Sizing, margin and the daily-loss cap still read the native number as if it were USD. For …3489 that means the loss cap's % check is a fraction of SGD 51.41, and live sizing would change (about 23% smaller by the earlier estimate) once the amount is converted. Converting needs a fresh, verified broker spot rate and a named veto when there is none; it is a risk-input change, so it waits for the owner's approval before any merge.
