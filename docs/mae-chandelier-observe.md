# mae-chandelier-observe

Date: 02-10-2026. Approval: `APPROVE mae-chandelier-observe`.

**Update 02-10-2026 (since #1182, checked in PR-3).** The Node side is no longer observe-only: when the since-entry Chandelier is tighter than the stop and still behind price, the fast monitor (and the slow pass) send a `MOVE_SL` through the normal executor (`source` `mae_chandelier` / `mae_chandelier_timeframe`), and the outcome is recorded as a receipt (`GET /state/mae-chandelier`: `receiptsSent`, `receiptsConfirmed`, `receiptsUnchanged`). That amend carries the stop policy (Opposite trigger, broker trailing once the stop locks profit) and the never-loosen rail, see `docs/stop-policy.md`. The independent `cpp-verify` observer is still read-only (`mayAmend` false, no broker write). The text below is the original observe-only record and is kept as written; where it says no stop is amended, it describes the first release.

**Update 03-10-2026 (since-entry fixed; no "incomplete" excuse).** Owner order: "fix since-entry first and make sure both the MAE and Chandelier work. It should not have excuse like incomplete, live-trade must address immediately".

- **Since entry is now since entry.** `decideAdjust` used `chandelierSinceEntry(bars, 0, ...)`, index 0 of the 40-bar hourly window, so the "since-entry" high included every hour before the position existed. It now takes the bars that BEGAN after the fill (`heldBarsSince`) plus the entry and the live price themselves, so a trade with no completed bar since the fill still has a level. Open time is the trade's `opened_at`, else the row's `created_at` (adoption time is later, so safer). An unknown open time is named `entry_time_unknown` and never amends.
- **Missing inputs are named, not "incomplete".** `market_closed` (expected), `quote_missing_market_open` (a defect: counted as `quoteMissingMarketOpen` on `GET /state/mae-chandelier`), `entry_price_missing`, `direction_missing`, `entry_time_unknown` (counted). `incomplete_quote` no longer exists.
- **A priced position is never read as quote-less.** The slow pass falls back to the fast monitor's own mid (at most a minute old) before declaring a missing price. Both fast-monitor no-quote paths now record a named reading instead of returning silently.
- **Bars reach the cache.** The background bar fetch used the SELECTED account's host and the global symbol id map, so a position on the other broker side never got bars, and the failure was swallowed. It now uses the position's own host and its own account's symbol id, logs a failed fetch (first and every tenth), and the cache is keyed by symbol NAME (an id is meaningful only inside one account's id space). The slow pass reads the same cache.
- **What the fix changes in behaviour.** A stop moves only when since-entry (entry or best price, minus 3 ATR) is tighter than the stop and still behind price. A stop within 3 ATR of entry is not touched until the trade has run; a stop wider than 3 ATR is tightened to 3 ATR from entry at the first reading. Never-loosen and the stop policy still apply on the wire.
- The `cpp-verify` observer is a read-only stub and is unchanged.

**Update 03-10-2026 (closed rows).** The observe record keeps one row per position id and nothing wrote a closed position's row again, so rows of closed positions stayed for ever and counted as "withoutBars" (read back at 16:58Z: 4 of 5 rows). `recordObserve` now drops rows whose monitored position is no longer open, and `GET /state/mae-chandelier` hides them and reports `closedRowsHidden` (the record is cleaned at the next write; a record with no open positions is only hidden, since the monitor writes nothing then). An unreadable monitored table drops nothing.

## What this does

Records, for each open position the observer is given, the worst price against the entry (MAE) and the best price for it (MFE). When 23 or more bars are present it also computes LeBeau's Chandelier: highest high of 22 sessions minus 3 times Wilder ATR(22), and the same line from the high since the entry index. Both numbers are stored. Neither is sent to the broker. The tick does not fetch bars. It passes 1h bars only if the profit keeper has already cached them. Otherwise the row says `observe_only_bars_missing`.

`mayAmend` is constant false in the Node module and in `cpp-verify`. A reading that asks for an amend is folded back to false before it is written.

## Interval

Not a new 1-second loop. The fast monitor already re-prices on a seconds clock: default 3 seconds, floor 1 second, override `FAST_MONITOR_MS`. ATR does not change every second. A second loop would stack work on that tick. The observer uses that same interval, skips a tick if the previous one is still running, and does not hold the process open.

## Files

| Path | Change |
|---|---|
| `agent/services/mae-chandelier-observe.js` | Added. Pure reading, state write, interval starter. |
| `agent/services/mae-chandelier-observe.test.js` | Added. Node test. |
| `agent/services/fast-monitor.js` | After a quote is stored, records one observe row. No evaluate or amend path edited. |
| `cpp-verify/src/mae_chandelier_observe.hpp` | Added. Independent observe. No transport. |
| `cpp-verify/src/tests/test_mae_chandelier_observe.cpp` | Added. Asserts `may_amend` is false. |
| `scripts/verify-mae-chandelier-observe.mjs` | Added. Re-test entry point. |
| `docs/mae-chandelier-observe.md` | This file. |

Nothing deleted.

The live check is the Railway service `cpp-verify`, healthcheck `GET /health`. The observe flag is `GET /mae-chandelier-observe` on that same service, bearer `EXEC_SECRET`, same gate as `/protection-status`. It returns `service: cpp-verify`, `mode: observe_only`, `mayAmend: false`. It does not place or amend.

There is no directory named `verify-cpp`. Do not add a second Railway service for this.

## Serial ledger

Shared with the other desk. This desk's earlier count stopped at № 11. The other desk was at № 10,424 · 02-10'26 06:35 SGT, so this file continues that series.

| Serial | When | Model | Effort | What |
|---|---|---|---|---|
| № 10,425 | 02-10'26 06:38 SGT | Grok 4.7 | not metered on this turn | Ledger baked into this change. Commits `0bcdd23` observe-only, `faad844` cpp-verify route. |

Effort is not a number this session exposes. It is not invented here. A later desk should add its own row rather than renumber these.

## How to verify

```bash
node --test agent/services/mae-chandelier-observe.test.js
node scripts/verify-mae-chandelier-observe.mjs
c++ -std=c++20 cpp-verify/src/tests/test_mae_chandelier_observe.cpp -o /tmp/mae-chandelier-observe-test && /tmp/mae-chandelier-observe-test
```

Pass is exit 0 and a JSON `ok: true`. Fail is exit 2.

State key after a live tick: `mae_chandelier_observe_json`. `mode` must be `observe_only` and `mayAmend` must be false. No `MOVE_SL` line should name this module.

## If it fails

1. Run the three commands above and keep the exit code.
2. If the Node test fails, the reading or the state write changed. Do not point the module at `executeBrokerAction`.
3. If the C++ test fails, `may_amend` was no longer constant. Restore the constant. Do not link `cpp-exec` into this test.
4. If the process has no state row, the observer was not started or `listPositions` threw. The tick logs `[mae-chandelier-observe] tick failed` and tries again. It does not amend on that failure.
