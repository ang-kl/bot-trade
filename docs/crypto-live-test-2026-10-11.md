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

## 5. What happened in the gate, and the fix (Claude · № 13,126 · 11-10'26 15:2x SGT)

Owner, 14:5x SGT: "What happen, fix it." Read from the code and the
production earned-floor report (`GET /state/earned-floor`, 06:53Z):

1. **The pad's proposal was judged as strategy `manual`.** The route stamped
   the trader's registry key on the label, the ledger row and the plan, but
   the proposal sent to the risk gate carried the literal `'manual'`. The
   gate's bridge between the registry's 2R designs (fib_confluence builds
   its target at exactly 2R; vwap_trend, vp_value, va_breakout at 1.5–2.5R)
   and the 3.0 hard floor is the earned floor: a thin account sample is
   shrunk toward the strategy's sweep prior and admitted at half risk when
   the expectancy clears 0.1R, else stretched up to 2R. A strategy named
   `manual` has no prior and no record, so every pad order read
   `earned_floor_denied: thin_sample 0<9` on an account whose prior report
   held 12 strategies with priors (sweep 06:28Z) and whose gate had already
   admitted 131 loop approvals via prior. The pad could never exercise the
   strategies' own floors. **Fix:** the proposal (and the bracket-gap advice)
   carry the validated key; `manual_order` stays the default when none is
   given. Pinned comment-stripped and by `rrFloorVerdict` on an in-memory
   database with a seeded prior (mutation M2 red).
2. **The exposure guard's leg split read crypto by name length.** A 6-letter
   symbol is split into an FX pair, so BTCUSD, XRPUSD, BCHUSD, DOTUSD, UNIUSD
   and XLMUSD each became a short-USD leg, while DOGEUSD, AVAXUSD and
   LINKUSD read as single units. With XRPUSD and DOGEUSD held, every further
   6-letter crypto long was refused `overexposed_USD=-2` and a 7-letter one
   would have passed. **Fix:** a crypto CFD is one instrument, like an index
   or a commodity quoted in USD (`isCryptoSymbol` in contracts.js, a name
   list only; `currencyLegs` returns one leg for it). FX, metals and the
   per-symbol limit are unchanged (mutation M1 red). The sizing table
   (`instrumentType`, `contractSize`) is deliberately not touched by this.
   Codex's review of the first cut (P2) named broker crypto outside the
   list; the split now applies only when BOTH halves are currency or metal
   codes (`isCurrencyCode`), so ETCUSD, SUIUSD, TONUSD and XBRUSD-style
   commodity CFDs are one leg too (mutation M3 red), and the name list is
   the broker catalogue's own at this revision. Codex's second P2: the
   pad's bracket-gap advice now takes the floor the gate will demand of
   this account and strategy (`effectiveRrFloor`), so an rsi2 pad order is
   never told 1R would satisfy a 3R gate (mutation M4 red).
3. **Not a defect, stated for the record:** with the key passed, the gate
   would still refuse fib_confluence and vp_value at 2R on this account,
   because their prior expectancy is negative (fib_confluence shrunk
   win rate 20.8%, E(2R) −0.38R; vp_value E(2R) +0.02R under the 0.1R
   bar), and admit vwap_trend (E(2R) +0.23R) at half risk with a stretch
   to 2R where its target sits under. ETHUSD and SOLUSD shorts cannot reach
   3R at all (a 3R target lies below zero); that is the monthly stop, not
   the gate. Pad orders carry no timeframe gate by design, which is how
   monthly signals reached the gate at all; the loop's armed-timeframe gate
   would have refused them upstream.
4. **Separate finding, not changed here:** the gate's sizing reads
   `units_per_lot` from the broker when the symbol's volume metadata is
   cached and from the contracts table otherwise; a crypto absent from that
   table (DOTUSD, UNIUSD, BCHUSD, XLMUSD, AVAXUSD, LINKUSD) falls to the FX
   default of 100,000 units per lot on the table path. The 11-10 orders
   read `units_per_lot: {value: 100000, source: 'table'}` for exactly those.
   The volume actually sent is converted with the broker's metadata, but the
   risk the gate believes it is taking on the table path is not the broker's
   unit. Owner's call whether to extend the table or require the broker
   metadata before sizing.

Conversation ref: ordered № 13,125 · reported № 13,126.

## 6. The resend on the corrected gate (Claude · № 13,172 · 11-10'26 16:10 SGT)

#1317 merged as b51ce2f9 and read back live at 08:07:50Z. The eight vetoed
orders were resent at 08:10:36–08:10:58Z, one at a time, shorts first, with
the same bodies as §2 (the strategies' own stops and targets, no lots given).

| Order | Strategy | Verdict | Gate reason |
|---|---|---|---|
| BTCUSD SELL | fib_confluence | **placed** | position 247844220, trade 1788, 0.01 lots; entry 82,960.78, sl 98,748.8, tp 53,315.39 (1.88R) |
| ETHUSD SELL | fib_confluence | refused | `bad_rr 1.44<3` — under the strategy's 1.5R prefilter, so the earned floor is not consulted |
| SOLUSD SELL | fib_confluence | refused | `bad_rr 1.42<3` — same |
| DOTUSD BUY | vwap_trend | refused | `below_min_volume: 0.01 lots < broker minimum (0.1 lots)` |
| AVAXUSD BUY | vp_value | refused | same |
| UNIUSD BUY | vwap_trend | refused | same |
| BCHUSD BUY | fib_confluence | refused | `insufficient_equity min_lot=0.01 computed=0 risk_budget=$214.27 usd_per_lot=$4049170.29` |
| XLMUSD BUY | fib_confluence | refused | `below_min_volume: 0.01 lots < broker minimum (0.1 lots)` |

**What the #1317 fix did.** Every order carried its strategy to the gate; the
exposure guard counted each crypto as one leg (no `overexposed_USD`); the
earned floor read fib_confluence's measured record on this account (47.8%
win rate over 67 closes, E 1.445R in BCH's checks) and admitted BTC at
1.88R. ETH and SOL sit under the 1.5R prefilter that applies before any
earned floor; the `<3` in their reason quotes the hard floor, not the bar
they failed. That is §5 item 3 as predicted, with the fib_confluence prior
now outranked by the account's own closes.

**The five remaining refusals are one defect, §5 item 4 made concrete.** The
lot-size registry (`agent/lib/lot-size-registry.js`) holds a broker record
only for symbols the order path or the position capture has seen; the
manual-order route fetched the broker's lot size and minimum AFTER the gate,
to send the order. So on DOT, AVAX, UNI and XLM the gate floored at the
assumed 0.01 lots and the route then found the broker's minimum is 0.1; on
BCH the gate priced one lot from the contract table's FX default of 100,000
units (40.49 stop × 100,000 = $4,049,170) and the budget bought zero. XRPUSD
was placed in §2 at 0.1 lots only because its record already existed. **Fix
(this PR):** the route fetches the broker's record first (cached per account
and symbol) and writes it to the registry before the gate, so the gate sizes
in broker units and floors at the broker's own minimum; the dry run
(`/state/preorder`) stays read-only and now names the lot record it sized
on (`lotRecord`), saying when the route will size differently. The gate
(`risk.js`) and every management file are untouched. Red-then-green: the
sequence pin fails on unchanged main; mutations M-A (record moved after the
gate), M-B (record call removed) and M-C (dry run always claims the
route's basis) each turn a named test red.

**Read-back after the resend (08:11–08:14Z).** 47790949 balance 42,854.57,
equity 42,845.40; open: UNH.US short, XRPUSD long, DOGEUSD long, BTCUSD
short, all with stop and target. Stop-policy controller since 08:07:33Z:
10 amends, 10 ratchet, 10 unchanged, 0 errors, readback confirmed 10/10;
BTC's position had its Opposite trigger confirmed at 08:11:50Z. Fast
monitor at 08:11:42Z: lastMs 12,125, skipped10m 62, skipShare10m 0.747,
busyShare10m 0.826 — the ten minutes after the deploy restart, to be
re-read before the next report. Effective limits on 47790949: maxOpenPositions
10 (overlay), maxCurrencyExposure 1, minRR 3.

**Not done, waiting on the owner:** the resend of DOT, AVAX, UNI, BCH and
XLM after this fix is live; ETH and SOL cannot pass at their signals' own
targets.

Conversation ref: ordered № 13,171 · reported № 13,172.
