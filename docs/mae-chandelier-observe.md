# mae-chandelier-observe

Date: 02-10-2026. Approval: `APPROVE mae-chandelier-observe`. Mode: observe only. No stop is amended.

## What this does

Records, for each open position the observer is given, the worst price against the entry (MAE) and the best price for it (MFE). When 23 or more bars are present it also computes LeBeau's Chandelier: highest high of 22 sessions minus 3 times Wilder ATR(22), and the same line from the high since the entry index. Both numbers are stored. Neither is sent to the broker.

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

There is no directory named `verify-cpp`. The independent verifier in this repo is `cpp-verify`. The check lives there, and the re-test script calls it.

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
