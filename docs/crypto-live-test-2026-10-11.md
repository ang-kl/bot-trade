# Crypto live test on demo 47790949 — receipt

Claude · № 13,119 · 11-10'26 13:18 SGT · claude-builder. Owner, 13:0x SGT:
"Create 10 crypto orders now. Test the different strategies on demo $40k
account. Do a live testing." Owner's answers at 13:14 SGT: raise the
account's position cap to 10 for this test; send the strategies' own
current signals as they are; send each signal's own target and let the
gate decide. Demo money only; no live account touched.

## 1. Inputs

- Account 47790949 (demo, USD 42,854.57 balance / 42,845.60 equity at
  13:15 SGT; one position open: UNH.US short 3.6 lots).
- Risk overlay written at 05:15:57Z: `maxOpenPositions: 10` on 47790949
  only (was the global 5). Every other limit unchanged: 1% risk per
  trade, 1.5% cap, R:R floor 3.0, USD exposure guard.
- Signals: `POST /actions/analyze` on 16 crypto symbols at 05:06–05:07Z
  (the deterministic scan with the enabled strategies; no LLM). Ten were
  sent, chosen for strategy spread: vwap_trend XRPUSD/DOTUSD/UNIUSD long,
  vp_value AVAXUSD long, fib_confluence BTCUSD/ETHUSD/SOLUSD short and
  DOGEUSD/BCHUSD/XLMUSD long. All monthly/weekly signals, conviction 10.
  MATICUSD (negative target) and TRXUSD were not sent.
- Orders: `POST /actions/manual-order` with `account`, the strategy key,
  the signal's stop and target and the signal's stated direction reason;
  entry is the latest 1m close (the route's rule), not the signal's level.

## 2. Outcome (05:16:14–05:16:23Z)

| Symbol | Strategy | Side | Result | Gate reason |
|---|---|---|---|---|
| XRPUSD | vwap_trend 1w | BUY | **placed** 0.1 lots, position 247843150, trade 1786, risk event 448593 | R:R from the fill 1.3911 against stop 1.3535 / target 1.8036 passed |
| DOTUSD | vwap_trend 1w | BUY | vetoed | bad_rr 1.54 < 3 |
| UNIUSD | vwap_trend 1w | BUY | vetoed | overexposed_USD = −2 |
| AVAXUSD | vp_value 1mo | BUY | vetoed | bad_rr 2.24 < 3 |
| BTCUSD | fib_confluence 1mo | SELL | vetoed | bad_rr 1.88 < 3 |
| ETHUSD | fib_confluence 1mo | SELL | vetoed | bad_rr 1.46 < 3 |
| SOLUSD | fib_confluence 1mo | SELL | vetoed | bad_rr 1.43 < 3 |
| DOGEUSD | fib_confluence 1mo | BUY | **placed** 0.01 lots, position 247843152, trade 1787, risk event 448600 | R:R from the fill 0.08491 against stop 0.06225 / target 0.15711 = 3.19 |
| BCHUSD | fib_confluence 1mo | BUY | vetoed | overexposed_USD = −2 |
| XLMUSD | fib_confluence 1mo | BUY | vetoed | overexposed_USD = −2 |

Two of ten placed. Every veto is the frozen gate doing its job on the
strategies' own signals: five fail the 3.0 R:R floor (the signal targets sit
at 1.4–2.2R), three hit the USD net-leg exposure guard once two USD-quoted
crypto longs were held beside the UNH.US short. The two that passed did so
because the current price sat well below the signal's level, which widened
the reward against the stop.

Read-back at 05:17:12Z: the account holds UNH.US, XRPUSD 0.1 and DOGEUSD
0.01; ledger rows 1786/1787 carry source `manual`, strategy `vwap_trend` /
`fib_confluence`, initial risk 0.03763 / 0.02266, broker SL and TP set.
Fast monitor after the orders: 0 skipped ticks, busy share 0.079.

## 3. What is now under test

The two positions are managed by the unchanged stack on scope `all`: the
0.5R managed trail, the since-entry Chandelier on the native TrailEngine,
the OPPOSITE-trigger broker trailing once the stop locks profit, the
capped hybrid half at 2R (if the target leaves room), the keeper, the
weekend bank. Nothing in that stack was changed for this test.

## 4. Open to the owner

- The remaining eight need one of two risk-limit changes on this demo
  account, both ask-first: a lower R:R floor (`minRR`) for the test, or a
  wider USD exposure allowance. Neither was changed.
- The `maxOpenPositions: 10` overlay on 47790949 stays until you say to
  reset it (`reset: true` clears it).

Conversation ref: ordered № 13,118 (owner order and three answers) ·
reported № 13,119. Session
https://claude.ai/code/session_01C1hz86KuE5JKVq6W2KtUE2.
