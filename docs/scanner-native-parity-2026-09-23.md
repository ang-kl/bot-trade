# Native timeframe parity continuation

This package adds closed-bar ports of `donchian_breakout`, `rsi2_reversion`,
`vwap_trend` and `fib_confluence` to the existing mirror-only scanner and
identified feed/comparison path. Their JavaScript functions remain the owners.
The reference functions ignore options; each native profile is a versioned
hash of the strategy's existing defaults. Unknown profiles, nonempty options,
partial bars and malformed windows are refused. No activation or ownership
setting changes, new broker subscription, request cadence or order authority.

The scanner reports the exact supported subset. With the existing default FX
Fibonacci port, five of twelve per-symbol strategies have native coverage;
Fibonacci filters/class tuning/pending entries and seven other strategies are
still unsupported. This is not full P5c acceptance or a production load result.

## Semantic evidence

`scripts/generate-timeframe-parity.mjs` freezes the full output of the actual
JavaScript functions. Sixty-four cases include both directions and no-signal
outcomes for each strategy, volume thresholds, warm-up, the RSI2 timeframe
floor and anchored VWAP over intraday/daily/weekly/monthly inputs. Four separate
pivot cases cover unique extrema, equal neighbours and flat plateaus.

C++ compares signal presence, direction, entry, SL, both targets, conviction,
RR, timeframe, time cap, strategy, direction reason and confluence count.
Explanatory `thesis` prose remains owned by the JavaScript reference; this
package does not claim native presentation-text parity. JavaScript tests pin
the full frozen outputs and exercise all 64 cases through the real native HTTP
service, feed publisher, candidate collector and persisted comparison store.
Changed direction/confluence metadata causes a mismatch. No intent is created.

The fixtures found an existing extraction defect: the C++ swing detector
accepted tied neighbours while the current JavaScript detector requires strict
extrema. Both identical C++ copies now reject ties and exclude the centre bar
from neighbour comparisons. The research/backtest copy shares the correction;
previous research output involving tied extrema must be recomputed before use.
This restores the existing JavaScript rule, with no strategy parameter change.
The native close/touch backtest, exit ordering, walk-forward and time-cap tests
also pass. Existing byte-identical extraction checks remain intact.

## Acceptance state

Focused parity and native backtest checks: **Passed**. Full repository and PR
gates, rollout readback and the remaining native ports are pending. Runtime
load/failure acceptance and scanner activation remain distinct. Activation
still requires the owner's scoped decision after parity and protection-load
evidence. Rollback owner: Adrian Ang.
