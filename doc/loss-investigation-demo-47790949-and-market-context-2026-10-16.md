<!-- Claude · № 15,08x 16-Oct (owner instruction "bot-trade-dynamic-market-context-investigation-instruction-2026-10-16.md", read 06:0x SGT; claude-builder). Investigation and design only: no application code, test, configuration, watchlist, risk limit, order, position or stop was changed under it. -->

# Loss investigation — demo 47790949 — and dynamic market context

**Status: investigation report and design proposal. Nothing in it is implemented, activated or deployed.** Prepared 16 October 2026, 06:10–06:4x SGT, against fresh main `f9d084a2` (public `/health` commit `f9d084a`, version 0.1.381, status ok at 06:10 SGT) and the deployed Node service's authenticated read routes. All code references are `file:line` on `f9d084a2` unless marked otherwise.

## 1. Verdict

1. **The account statement reconciles exactly.** SHA-256 of the supplied CSV matches the instruction's hash. 23 unique closing deals, net −521.01 USD, commissions −11.67 USD already inside net, Cotton +274.90 on two closing deals totalling five lots, AUDUSD +192.78 on 1.38 lots. The six screenshot deals (GER40, JPYX, GD.US, US30 ×2, COST.US) sum to −615.95 and the other 17 to +94.94, as the instruction states. The eight incident deals sum to −837.77. Ending balance 42,326.57 equals the bot's `broker_deals.balance` after the last deal (§3).
2. **One confirmed defect candidate with monetary impact: GER40 (−227.25).** The premise `price<25201.95805` was breached by 06:57:06Z at the latest (the autopilot sibling on …0058, same premise, closed at 25200.2 by the one-minute position manager at that instant). The …0949 position was a `manual` row, which the position manager does not manage (`loop.js selectActivePositions` ~3165 selects `source IS NULL OR IN ('autopilot','preopen','external')`); its only closer is the fast monitor's TICK pass (3 s ticker; each row due every 1–3 min by relVol), which skipped its own next firing three times in 06:59–07:00:42Z (`previous pass still running`, the tick's overlap guard). The protection BAND (60 s ticker, where the loss guardian runs) overran its 5 s budget on each of its six passes in the same window — on an independent interval with its own guard (fast-monitor.js:1326–1343), so it cannot consume the tick's budget and is not the cause. The broker stop filled at 07:00:01.403Z, 7.8 points through, at the 09:00 CET cash open. The fast monitor reported the premise exit at 07:00:45Z as `already_closed`. Intended behaviour: a premise exit within the row's 1–3 minute cadence, about 3 minutes before the stop. Observed: none. Confidence high that the exit was due and missing (two independent records: the sibling's close and the tick's skip log), low on the cause of the tick's slowness (the tick's per-position receipts for that window are not retained; the band's concurrent overrun is a separate problem). **Estimated avoidable loss ≈ 100 USD** (a close near 25200 on 2.7 lots instead of 25169) out of −227.25 observed; the rest is the strategy's loss to its premise.
3. **Seven other incidents are valid protection or policy weakness, not execution defects.** JPN225, JPYX, US30 #1827: broker stops filled through (valid protection). COST.US, US30 #1889, NAS100: premise closes executed as designed (NAS100's 4.29 s life is a policy weakness: the analysis premise, computed off a planned entry 296 points higher, armed 2.6 points under the actual fill because `premiseAtFill` only requires stop < level < fill). GD.US: a 4-hour time cap on a 1h NYSE setup expired after the close; the exit was held by the closed-market hold (#1186) and sent at the open gap (policy weakness, mechanism as coded, −1.07R).
4. **The bot does not use most of the market context it already scans.** Correlation is computed on array tails of 1h closes for at most 24 symbols chosen in SQLite's row order, stores unknown pairs as 0, feeds one concentration veto and nothing else; the market pulse is advisory and never read back; correlation shifts have no consumer; the tick path consults no correlation, pulse, news or market hours (the momentum book's entries pass `evaluateTrade` like scan entries — loop.js:819 via `autoTrade` — so they carry the same concentration veto, optional news gate and advisory pulse stamp); resting orders are never revalidated against context after placement. These are confirmed from source (§4), not inferred from the losses.
5. **No dynamic-context decision would have prevented the GER40 loss**; a working premise exit would have. The design in §5–§9 is justified by the data-use gaps in §4, not by these eight deals, which are too few to certify anything (§9).

**Verified scope versus missing evidence.** Verified: account identity and registry (authenticated `GET /state/accounts`), every deal/trade/position join, premise text, stops recorded, position-event journals, risk events, decision-log skips in the US30 window, the Railway Node logs for 06:50–07:03Z and 22:55–13:32Z, broker orders readback, every source observation in §2 of the instruction. Missing: fast-monitor per-position receipts for 15 Oct 06:57–07:00Z (only the latest pass is kept); the writer of the JPYX 691.4→691.2 tightening (observation only); any runtime correlation matrix for 12–16 Oct (only the current and previous matrices are stored); a historical decision audit (`/state/decision-audit` returns 404); the sixth screenshot (JPYX) was not attached (five-image limit), its deal is reconciled from the CSV.

## 2. Sources and limits

| Source | What it gave | Limit |
|---|---|---|
| Owner's statement CSV (SHA-256 `b0b2edea…7647b`), five screenshots (deal pages for 325136560, 325314459, 325171595, 324627643, 324580093) | Deals, orders, positions, summary; the screenshots' Fees field vs the CSV's Commissions (same quantity: GD.US −1.14 vs −1.58 differ because the screenshot shows the position's fees and the CSV the closing deal's commission — not subtracted twice) | Timestamps UTC+8; no account-ID column (identity from the authenticated registry) |
| `GET /state/trades`, `/state/positions`, `/state/position/:id/cockpit` (position_events), `/state/risk-events`, `/state/decisions`, `/state/action-log`, `/state/broker-orders`, `/state/orders`, `/state/pending-orders`, `/state/accounts`, `/state/heartbeats`, `/state/config`, `/state/trail-status`, `/state/loss-guardian`, `/state/closed-market-limits`, `/state/analysis/:id`, `/state/postmortems` | Bot-side records per account; handlers verified SELECT-only on `agent/routes/state.js` (the cockpit route also reads trendbars from the broker: read traffic) | Only the latest fast-monitor pass receipt is retained; `/state/decision-audit` 404 |
| Railway Node logs (`bot-trade` service) | PM lines, fast-monitor pass lines, loss-guardian overruns, the GD.US closed-market hold retries | Log retention window; no sidecar (cpp-exec) logs read |
| Source on `f9d084a2` | Every mechanism cited | The code deployed during 12–13 Oct incidents was older (`40abc8c5` and before); the mechanisms cited for those incidents (time cap, closed-market hold, broker stops) predate this week's PRs |

Saved evidence: `scratchpad/inv/` (trades, monitored rows 1748–1875, cockpit journals, risk events per symbol, decisions, action log, broker deals/orders, Railway log extracts). These are session files, not repository content.

## 3. Reconciliation and incident timelines

### 3.1 Statement reconciliation (computed from the CSV)

| Measure | Value |
|---|---:|
| Unique closing deal records | 23 |
| Net realised result | −521.01 USD |
| Commissions (inside net) | −11.67 USD |
| Six screenshot deals (325136560, 324502658, 324627643, 324580093, 325314459, 325171595) | −615.95 |
| Other 17 closing deals | +94.94 |
| Eight incident deals (the six plus JPN225 324345442 and NAS100 325160369) | −837.77 |
| Cotton, two closing deals (2 + 3 lots) | +274.90 |
| AUDUSD, two closing deals (0.69 + 0.69 lots) | +192.78 |
| Ending balance / unrealised / equity | 42,326.57 / +38.54 / 42,365.11 |

The closing window is 12–16 Oct SGT; UNH.US (18 Sep) and the 11 Oct crypto rows predate it. The bot's `broker_deals` carry the same balance after each deal (Passed).

### 3.2 Incident table (bot records joined to broker deals; all on account 47790949, demo, USD)

| Deal / order | Symbol | Bot trade / monitor / position | Origin, strategy | Entry → close (UTC) | Stop sent / premise | Closer | Net | Class |
|---|---|---|---|---|---|---|---:|---|
| 325136560 / 367385457 | GER40 buy 2.7 | 1879 / 1836 / 248609272 | manual (owner demo test № 14,884), vwap_trend | 06:31:22 → 07:00:01.403 | 25176.8 (broker) / `price<25201.95805` | broker stop at the cash open; fast monitor reported `already_closed` 07:00:45 | −227.25 | **defect candidate** |
| 324345442 / 366486681 | JPN225 buy 1.2 | 1795 / 1752 / 247937128 | manual (stress test w1), vp_value | 12 Oct 09:15 → 13:32:15 | 68542.3 / none | broker stop (10.3 through) | −220.52 | valid protection |
| 324502658 / 366487114 | JPYX sell 100 | 1798 / 1755 + 1758 / 247938246 | manual (stress test w2), vwap_trend | 12 Oct 09:21 → 13 Oct 00:19:29 | 691.4 → 691.2 / none | broker stop | −155.27 | valid protection; record defect (duplicate monitor row; tightening without a writer row) |
| 324627643 / 366852932 | GD.US sell 39.3 | 1815 / 1772 / 248098554 | autopilot rsi_meanrev 1h | 12 Oct 18:54 → 13 Oct 13:31:30 | 335.92 / free text (pre-#1374) | position manager `time_cap_expired` (22:54Z), held by the closed-market hold, sent at the open | −93.89 | policy weakness |
| 324580093 / 366801901 | US30 buy 0.6 | 1827 / 1784 / 248223902 | autopilot rsi_meanrev 5m | 13 Oct 10:46:43 → 10:50:00.695 | 51966 / none (time cap 20 min) | broker stop (8.2 through) | −55.32 | valid protection; stop-width policy |
| 325314459 / 367581934 | COST.US buy 7.2 | 1908 / 1865 / 248691582 | autopilot fvg_retrace 10m | 15 Oct 15:10 → 19:21:55 | 980.757 / `price<981.99` | fast monitor premise close | −47.37 | valid protection |
| 325171595 / 367426940 | US30 buy 1.1 | 1889 / 1846 / 248626606 | manual (owner demo test № 14,915), va_breakout | 15 Oct 08:28 → 09:25:04 | 51737.1 / `price<51811.07083` | fast monitor premise close (−0.33R, MFE +0.32R) | −36.85 | valid protection |
| 325160369 / 367415025 | NAS100 buy 0.5 | 1890 / 1847 / 248628981 | manual (owner demo test № 14,915), rsi2_reversion | 15 Oct 08:38:41 → 08:38:45 | 29244.69 / `price<29634.167` (2.6 under the fill) | fast monitor premise close | −1.30 | policy weakness |

Lots recorded equal broker lots on every row (`filled_volume_source = broker_opening_deals`; COST.US requested 7.25 filled 7.2, US30 #1827 requested 0.63 filled 0.6). Costs: commissions as the CSV; swap only on JPYX (−3.78) and GD.US (+0.44).

### 3.3 GER40 timeline (15 Oct, UTC)

| Time | Event | Source |
|---|---|---|
| 06:26:27 | analysis 218694 vwap_trend, premise `price<25201.95805` | `/state/analysis/218694` |
| 06:30:55 | …0058 autopilot sibling (trade 1878, 0.2 lots) opens @25242.4 on the same premise | trades …0058 |
| 06:31:22 | …0949 manual order (owner's demo test) fills 2.7 lots @25244.1; monitor row 1836, `manual` | trades …0949, risk_event 449730 |
| 06:35:13 | `trail_observed` 25176.8 (native trail status; the broker stop) | position_events 1836 |
| 06:55:05 … 07:00:45 | six protection-BAND passes (the 60 s ticker that runs the loss guardian), each `loss_guardian exceeded its 5s budget … protection band failed`; separately, the TICK (the 3 s ticker that runs the premise evaluation) skipped its own next firing three times: `previous pass still running — skipped 1 tick(s)` at 06:59:02, 07:00:03, 07:00:42 | Railway |
| 06:57:06.269 | `[loop] PM GER40 […0058 row1835 t1878]: FULL_EXIT — closed @ ?` — the sibling's premise close at 25200.2 | Railway, trades …0058 |
| 06:57–07:00 | no PM line for …0949 row 1836 (manual rows are not in the PM select); no fast-monitor action on row 1836 | Railway filter `t1879` → 0 rows |
| 07:00:01.403 | broker stop fills @25169.0 at the 09:00 CET open, 7.8 points through 25176.8 | statement, broker_deals |
| 07:00:45.560 | fast monitor: `FULL_EXIT premise_invalidated … broker: already_closed` | monitor row 1836, Railway |

Intended: the premise exit fires on the first fast-monitor pass after the breach (cadence 1–3 min by relVol). Observed: no action across at least three due passes. Causal chain (confidence low on the cause): the premise evaluation runs in the TICK (`evaluatePosition` on the mid, fast-monitor.js:545), and the tick is skipped only by its own overlap guard, so the three skips show the tick pass itself ran longer than its 3 s cadence at 06:59–07:00:42Z; the row's due evaluation was therefore late or ran without a fresh quote — the tick's per-position receipt that would settle which is not retained. The loss guardian runs in the BAND on an independent interval with its own guard (fast-monitor.js:1326–1343, 1478–1566; two tickers, two guards); its 5 s overruns in the same window (the heartbeat's standing warning since 14 Oct) are a concurrent problem and cannot consume the tick's budget, so they are not the cause. What made the tick slow — quote fetches for the open rows across the 09:00 CET open, the session-open guard that runs inside the tick (:1466), or event-loop contention from the band's work — is not established. (The first draft of this report attributed the skips to the loss guardian; corrected on the automated review of the PR that carries it.) Historical version: the deployed commit at 07:00Z was `618e2991` (#1378) plus whatever the owner's merges carried by then; the premise close itself was built in #1374 (14 Oct). Severity: high (the only incident where a bot action was due and missing). Monetary: −227.25 observed, ≈ −100 estimated avoidable.

### 3.4 US30 re-entry window (13 Oct 10:50–14:20Z)

No long on US30 was vetoed in the window. The decision log holds only upstream skips: `vp_value OFF` (eight times), `va_breakout OFF` (10:52–11:01), `donchian_breakout OFF` (four), `ema_pullback rr_prefilter bad_rr 2.00<2.23` (11:45–13:07); risk vetoes: 12:29:10Z SELL rsi2_reversion 12h `bad_rr 0.92<3`, 12:39:14Z SELL rsi_meanrev 1m `bad_rr 0.45<3`. The re-entry at 14:20:15Z (rsi_meanrev 10m, conviction 9, 0.4 lots @51890) was moved to breakeven by the session-open guard at 14:25:44 (+0.32R), trailed by the broker to 51919, and closed +10.44 at 14:29:04Z. Nothing in the window was blocked by context; the strategies that were OFF were the owner's arming choices. Missing logs do not prove no opportunity; the stored candidates are what the pipeline considered.

### 3.5 Pending limits (read, not amended)

Working broker orders on 47790949 (first seen 2 Oct 01:33Z, last seen 16 Oct 22:08Z): 364445547 NatGas BUY LIMIT 2.745, 3 lots, SL 2.713, TP 3.105; 364445778 SpotCrude BUY LIMIT 68.548, 4 lots, **no SL**, TP 100.759. Both are `bot: false` and absent from `pending_orders`, so neither the closed-market-limit nor the pending-order fill handling applies (and `closed_market_limits.on` is false). On a fill the reconciler adopts the position as external; the only protection path for a naked external row is the LossGuardian (`loss-guardian.js:14,35,83`: a broker stop at 3 × ATR(1h) on a naked position; config on, scope all). Derived exposure: SpotCrude ≈ US$27,419 notional with no stop until adopted; NatGas ≈ US$82,350 notional with ≈ US$960 at risk. Whether the LossGuardian would act inside its 5 s budget is Not Verifiable (its band overran repeatedly on 15 Oct). **Confirmed exposure, reported; nothing amended under this instruction.**

### 3.6 Selection bias

The later screenshots favour GER40 and both US30 buys (recovered after the exits); JPYX, GD.US (shorts) and COST.US (long) remain adverse at their displayed endpoints. Neither endpoint proves the strategy. The comparable cohort is every closing deal of the window (23) plus the three still-open test positions (USDJPY #1881, XPTUSD #1884, FRA40 #1885) and the two working limits; JPN225 (−220.52, the second-largest loss) is in the cohort and was a plain broker-stop fill.

## 4. Data inventory and lifecycle coverage

### 4.1 Lineage (collected → normalised → stored → related → consumed → execution)

| Source | Collected | Provenance | Event vs ingestion time | Cadence / retention | Related to peers | Consumed by | Execution outcome |
|---|---|---|---|---|---|---|---|
| Timeframe scan (fib-strategy, 150 closed bars per armed strategy) → `scans`, `analyses` | OHLCV per timeframe; bias, confidence, entry/sl/tp, conviction, premise | global scan creds; 15 symbols per cycle | `scanned_at` is ingestion; no bar time, no account_id on `scans` | every loop; 30 d | none at scan time | `evaluateTrade` via autoTrade/preorder; `rankHotSymbols` + cluster conviction (observe-only unless enforce); regime/correlation universe | orders |
| Native timeframe mirror (scanner-feed.js:58-100) | same closed bars with the account calendar | per (host, account, symbolId) | `sourceTimestampMs`, `barCloseAtMs`, `receivedAtMs` | per evaluation | none | comparison records only (`orderAuthority:false`) | none |
| Tick feed (cpp-exec spot feed, tick_firer) | raw spots; permits per account | one feed per side | fire older than 5 s refused | tick; permits TTL 5 min | none | permit feeder (pregate, max positions, identity, trend side, book cap) → firer | orders, no Node gate at fire time |
| Market pulse (market-pulse.js:94-403) | ER, sigma, pin, traverse, netPct, state; herds; divergences | the same 1h bars as the correlation fetch | `builtAt` wall clock; forming bar not filtered | ~30 min; one key, no history | herds from the matrix (no age check) | `risk.js:1996-2013` stamps `checks.pulse` — **advisory, never read back**; `/state/market-pulse` display | none |
| Correlation matrix (correlation-matrix.js) | Pearson of 1h log returns, 60 lookback, threshold 0.7, maxCorrelated 2, maxAgeMin 90 | global creds; symbols = held (all accounts) + scans of 6 h, `.slice(0,24)` in SQLite row order (loop.js:6386-6397, matrix :233) | `builtAt` wall clock; returns paired by **array tail** (:64-67), `logReturns` drops `bar.t` (:54-61); null pair stored as **0** (:90) | ~30 min; current + previous only | yes (the only live relationship) | `correlationVerdict` (risk.js:1705; callers :2567 and account-pregate.js:189) — veto on ≥ 2 held correlated positions; cluster conviction and pulse herds (no age check); `/state/correlation` display; shifts (:194) display only | vetoes only |
| Regimes (regime.js) | ADX/ATR regime, trend direction | global creds; scanned ∪ momentum ∪ tick names | `computed_at` ingestion; no timeframe column; raw cached bars incl. forming; `atr_14`/`adx_14` never written | ~30 min; 30 d | none | `checkRegimeGate` (loop, preorder, momentum paths); `permittedSides` → tick permits; labels | vetoes, side vetoes |
| Sessions / hours | broker weekly schedule + tz; per-account calendar with holidays | name-keyed (global) / per account | DST-correct schedule; `nextOpenInfo` wall-clock projection (DST transition one hour off: Codex P2 on #1382, booked) | ~daily refresh | — | entry gates; closed-market routing; exit-hours (book); momentum-account uses the weekly-only reader | routing |
| FX rates | scan price per symbol | global | ingestion time | each scan; 26 h | — | sizing only | sizing vetoes |
| News calendar (ForexFactory) | scheduled events by currency/impact | global HTTP | event time from feed | 6 h TTL | — | `risk.js:2078-2092` veto only if `newsGate.on` (default **false**); cockpit | none by default |
| Index / commodity / USDX benchmarks | **none computed** (contracts/taxonomy only) | — | — | — | — | — | — |
| Candidate decisions (`risk_events`, `decision_log`) | proposal, checks, veto reason, stage skips | per account | ingestion | 90 d | — | audits, reports | — |
| Pending orders (three paths) | row + broker order | per account | — | — | none after placement | fib pending: closed-bar-vs-SL check on raw cached bars keyed by symbol (pending-orders.js:485-509); closed-market limits: level move / expiry / stale reconcile; momentum limit: re-evaluation only inside the reservation transaction before send (momentum-limit-entry.js:89-121) | cancel/replace, expiry |
| Monitored positions | current price, stops, premise, MAE/MFE | per account | tick/1-min | — | none | position-manager (time cap → premise → bank → partial → trails → breakeven), fast-monitor tick (`evaluatePosition` on the mid every 1–3 min, the same ruleset) and band (trade guards → keeper → loss guardian → stop policy), native trail engine, loss cap, weekend bank, momentum book | exits, stop moves |
| Postmortems | bars_json, verdict | per trade | — | — | — | lessons tuner (`stop ×1.3` on `stop_hunt` ≥ 60 %) | sizing of later stops |

### 4.2 Gaps, classified

| Gap | Class |
|---|---|
| Correlation returns paired by array tail; disjoint sessions misalign (precondition confirmed at ctrader-ws.js:771-781; a bad veto from it not verified) | missing relationship |
| Forming hour included in correlation and pulse inputs | stale input |
| Matrix universe: arbitrary order, 24 cap, held symbols of all accounts, symbols missing from the global map dropped | missing data |
| 60 × 1h window; only two matrices retained; no runtime matrix for the incident week | insufficient history |
| Correlation shifts, pulse `checks.pulse`: no decision consumer; pending paths do not consume pulse despite the module header | missing consumer |
| Cluster conviction and pulse herds read the matrix with no age check | stale input |
| Tick path: no correlation, news, pulse or market-hours gate (the momentum book's entries pass `evaluateTrade` via `autoTrade` and carry the scan path's checks) | missing consumer |
| Fib pending invalidation reads the raw cache (possibly forming) keyed by symbol, not the row's timeframe | stale input |
| Resting limits (all three paths): no post-placement context revalidation beyond level/SL, expiry, pause | missing consumer |
| `regimes` has no timeframe column; ATR/ADX columns never written; forming bar included | missing data / stale input |
| `scans` without bar event time or account_id; FX `t` ingestion time | missing data |
| News gate off by default; no actuals, no sentiment; no index/commodity/USDX benchmark relationship | missing data / missing relationship |
| Premise exit fires on a tick crossing with no bar confirmation or gap awareness (by the owner's choice at § 14,744: tick-fired) | intended behaviour, recorded |
| Postmortem dual-touch candle resolved by the close side | insufficient history (intra-bar order unknown) |
| Fast-monitor per-position receipts: only the latest pass retained | data/observability deficiency (the GER40 gap) |
| `manual` rows outside the position-manager pass | intended behaviour with a consequence (single closer) |

Price-regime-only sources: scans, mirror, tick feed, regimes, pulse, correlation, clusters, momentum rank, postmortems, FX table. Fundamental explanation: only the ForexFactory calendar (scheduled releases, no actuals). No news-text or sentiment feed exists in the bot; the TradingView MCP available to this session is outside the bot and has no in-repo consumer. No feed is invented here.

## 5. Findings, classified

| # | Finding | Class | Intended vs observed | Causal chain | Version | Confidence | Severity | Observed / est. avoidable |
|---|---|---|---|---|---|---|---|---|
| F1 | GER40 premise breach not acted on for ≥ 3 minutes; stop filled at the cash open | **confirmed defect candidate** | premise exit within 1–3 min / none | manual row has one closer (the fast-monitor tick); the tick pass overran its own 3 s cadence and skipped three firings; cause not retained (the band's loss-guardian overrun is concurrent, not causal) | #1374 premise; tick duration and receipts unchanged | high that the exit was due and missing, low on the cause | high | −227.25 / ≈ −100 |
| F2 | NAS100 premise armed 2.6 points under the fill | policy weakness | premise from the analysis's planned entry / applied unchanged to a fill 296 points lower | `premiseAtFill` requires only stop < level < fill | #1374 | high | low (money), medium (pattern) | −1.30 / 0 (the trade would have paid the spread anyway) |
| F3 | GD.US time cap expired after the NYSE close; exit held and sent at the open gap | policy weakness; mechanism intended (#1186) | time-capped exit at 22:54Z / executed 13:31:30Z next session | 4 h cap on a 1h cash-session setup; closed-market hold re-sends at the first loop after the open | #1186 | high | medium | −93.89 / Not Verifiable (the position could have been worse or better at any earlier executable time) |
| F4 | US30 #1827: 84-point stop on a 5m mean reversion filled 8 points through; price reclaimed entry in 3 bars | policy weakness (stop placement) | — | strategy stop width vs 5m noise | pre-existing | medium | medium | −55.32 / Not Verifiable |
| F5 | JPYX: two monitored rows for one position (manual + external import); the 691.4→691.2 tightening has no writer row | data/observability deficiency | one row per position; every stop move journalled | adoption created a second row; the native trail status recorded an observation only | pre-existing | high | low | 0 |
| F6 | SpotCrude 4-lot buy limit with no stop at the broker since 2 Oct | confirmed exposure (owner-placed order) | — | not a bot order; adoption-on-fill relies on the LossGuardian | — | high | medium | 0 so far |
| F7 | Correlation: tail alignment, unknown = 0, 24-symbol cap in row order, forming hour | data quality / missing relationship | aligned, known-quality relationships for every subject | see §4 | pre-existing | high (source), unverified (runtime impact) | medium | none attributable |
| F8 | Market context has no decision consumer beyond the concentration veto; pulse advisory; shifts unread; resting orders never revalidated | missing consumer (design gap) | the owner's proactive requirement | see §4 | pre-existing | high | medium | none attributable |
| F9 | Protection-band budget overruns (loss guardian 5 s; 14–16 Oct heartbeat warning) and, separately, tick-pass overlap skips | two observability deficiencies on two independent tickers; the tick's is the one with the execution consequence (F1) | each ticker inside its cadence; per-position receipts retained | the guardian's sweep exceeds the band's 5 s budget; the tick pass exceeds its 3 s cadence and skips firings; neither retains per-position receipts beyond the latest pass | pre-existing | high | high | see F1 |
| F10 | Main-loop monitor phase 187 s at 22:11Z 16 Oct (loop 213 s, a trendbar request in flight) | observability (recorded, recovered) | 60 s loop | long broker read inside the monitor phase | current | high | medium | 0 |

Losses that were valid protection: JPN225, JPYX, US30 #1827 (broker stops), COST.US, US30 #1889 (premise closes), NAS100 (premise close as built). Defects proven: none to the standard of a reproduced test; F1 is the strongest candidate and needs the retained receipts to become proven. Policy changes with supporting evidence: a minimum premise distance (F2; two cases: NAS100 and the earlier …0949 NAS100 #1890 note at № 14,953), a session-aware time cap for cash-session instruments (F3), per-position receipts retained for a window (F9). Unproven: that any stop was "wrong" (recovery after an exit is not proof), any fundamental cause for the 15 Oct GER40 and US30 moves (no timestamped evidence feed), any cross-market relationship for the incident symbols (no runtime matrix retained).

## 6. Dynamic correlation coverage — proposed design

Replaces the first-24-symbols concept with explicit tiers and coverage accounting.

**Universe tiers.** M, mandatory, never evicted: active monitored positions of every enabled account (not only the selected one); working entries (`pending_orders` working, `entry_intents` ACCEPTED); in-flight intents (OPEN_STATES) and standing tick/VPO permits; actionable candidates from every non-retired producer (scan synthesis rows reaching `evaluateTrade`, momentum-book rank rows, momentum-account candidates, the tick feeder's accounts × symbols). C, required context per M subject from a versioned instrument-context registry: benchmark(s), peer group, FX/commodity/macro proxies; admissible provenance only the broker catalogue's asset class and symbol category ids (`wsGetAssetClasses`, `wsGetSymbolCategories`, ctrader-ws.js:941-959; instrument-tree.js:11-45), the broker description, and owner-verified mappings with an effective-from date; ticker-shape heuristics (symbol-taxonomy.js, sessions.js:91) may seed a proposal marked `heuristic` and never satisfy coverage; a subject with no verified mapping is `context_unmapped`, a recorded gap. D, discovery: the remaining scanned universe on a rotating cursor, from leftover budget only.

**Scheduler.** One `ContextScheduler` with a priority queue keyed (tier, staleness, horizon). Work unit = one bar-window fetch per (symbol, timeframe) = one historical token (the global bucket runs 4/s against the documented 5/s, ctrader-ws.js:88-109; `historicalRateStatus()` exposes queue depth). Budget per cycle = measured bucket capacity × a configured share, started at the observed idle fraction. M first, C second, D last; D is pre-empted when M/C work arrives. Incremental: cached aligned return series per (symbol, timeframe) keyed by bar open time; a refresh fetches only bars after the cached last closed bar; only pairs touching changed series are recomputed. Spot subscriptions feed freshness only. Market data is shared by instrument identity; account symbol ids resolve per account.

**Coverage accounting.** Each refresh writes `context_coverage_json`: per subject the required members, the covered members, the missing ones with a reason (quota, unmapped, insufficient overlap, fetch failed, unsupported), the compute time and horizon; tier counters; the discovery cursor. A decision whose subject has any missing required member reads `coverage: incomplete` and takes the §8 policy. Mandatory coverage can be late under quota pressure, never silently dropped.

**Event-time alignment.** Returns on the intersection of closed-bar open times across a pair or group (`bar.t`, which `decodeTrendbars` already supplies), never array tails; per-symbol calendars (market-calendar.js, calendar-intervals.js) define expected bars; a missing expected bar is a gap (no zero fill); a forming bar is excluded (the feed receipt's forming flag); a bar whose receipt is older than its period plus tolerance is stale. Disjoint-session pairs are estimated only on horizons with overlap (daily close-to-close with an explicit lag convention; intraday only on co-open bars). Every relationship carries `n_overlap`, `n_expected`, `gap_ratio`, effective sample size, and is `unknown` below a per-horizon minimum (provisionally 40/40/60 for 1h/4h/1d, to be set from the §9 study). Quote currency is recorded so FX proxies are explicit members. Corporate actions: no adjustment feed is verified in the repo; ex-date gaps beyond k·σ are marked suspect and excluded until an owner-verified event list exists (a missing feed, reported, not invented).

**Estimators.** Short (1h, days), intermediate (4h, weeks), long (1d, months). Pearson with a Fisher-z interval; shrinkage toward the curated clusters (correlation.js:24-46) as prior with the intensity reported; downside co-movement conditional on benchmark < 0 and a lower-tail hit ratio; breadth; relative strength = subject return − β × benchmark return. Monetary cluster exposure = Σ account-scoped risk-to-stop in money × β to the factor, using the account money conversion (risk.js:1986-1993) and broker lot geometry, reported beside the existing ticker-count veto (risk.js:1703-1723), which stays unchanged.

**Refresh and triggers.** Short horizon on each closed 1h bar of the subject's session; intermediate each 4h; long daily. Event triggers enqueue an M refresh: `reserveEntry`, intent FILLED/ACCEPTED/REJECTED, reconciler adoption or close, a pending-order status change, a regime row change, a session open or close, a correlation shift beyond hysteresis, and timestamped releases only where a verified feed exists (the news gate is config-off today). Service levels are measured first and targeted later: subject-registration-to-coverage latency, assessment age at decision time, historical-token wait, coverage completeness per tier, gap ratio per relationship, published on `/health`, targets set after two weeks of measurement.

## 7. Market structure and propagation

Per horizon on aligned returns: r_i = α_i + β_mkt·r_mkt + β_sec·r_sec + ε_i, with r_sec the equal-weight peer index orthogonalised against the benchmark; expose β_mkt, β_sec, r², residual volatility, effective sample size; `unknown` where coverage fails; the pulse's `driverOf` kept as a coarse cross-check. Lead/lag only on residuals, lags ±1..k bars within co-open sessions (daily for cross-region pairs), Benjamini–Hochberg across pairs × lags × horizons; a "candidate leader" needs significance in a discovery window and in a later disjoint validation window and an implied follower move above round-trip costs from the measured schedules (risk.js:1725-1729, lib/tick-cost-schedule.js); correlated members count as one effective confirmation. Regime classes, each with required evidence: retracement, chop, broad trend, rotation, idiosyncratic, fundamental shift (requires a timestamped evidence reference; without a verified feed it is unreachable and reads `unknown`). Every assessment exposes confidence, evidence references, horizon, coverage and expiry; `unknown` is first-class; HOLD is an ordinary outcome.

## 8. Proactive decision contract

**Context assessment** (`context_assessments`, immutable rows): assessment id, schema version, model version, subject (symbol, per-account instrument identity), members (benchmarks, peers, proxies, registry version), horizon, event-time cutoff, generated-at, expires-at, coverage (complete / incomplete / unknown with the missing list), quality (overlap, effective sample size, gap ratio, stale inputs), metrics (correlation, previous, delta, downside correlation, β_mkt, β_sec, breadth, relative strength, cluster exposure in money per account), regime (class, confidence), premise implications (per premise kind: supports / neutral / weakens / invalidates, with confidence), evidence references, the bar receipts it was computed from. Account policy, risk and execution ownership are not in this row.

**Policy function.** `decideContextPolicy(assessment, target, accountPolicy, hardLimits)` returns one of ALLOW, ALLOW_REDUCED (size factor), DEFER (condition, deadline), REFUSE, CANCEL_WORKING_ENTRY, HOLD, TIGHTEN_PROTECTION, PARTIAL_EXIT, FULL_EXIT, with the reason, assessment id and policy version. Favourable context never bypasses any `evaluateTrade` check and never creates a trade without a producer setup; a reduced size passes the same broker increment and minimum checks (an infeasible size is REFUSE, never rounded up); admissible evidence is an unexpired assessment with coverage known for the premise kind and a model version enabled for the account; strategy compatibility is read from `STRATEGY_KIND` (regime-gate.js:49) and the account horizon family.

**One arbiter.** A proposed `management-arbiter.js` consumed by `evaluatePosition` (position-manager.js:216) and the fast-monitor job list (fast-monitor.js:1159-1174) under the acting layer's single flight and account scope (acting-layer.js:63, 86-129). Precedence, highest first: exec-guard halt; hard protection (naked-position guard, loss cap, loss guardian, margin floor); already-valid premise exits and bank/time-cap rules; tighten-only movers (trade guard, profit keeper, momentum-book ratchet, weekend bank); context policy last. Context may only add HOLD, TIGHTEN, PARTIAL or FULL_EXIT candidates; the most protective action wins; nothing widens a stop, averages down or expands risk; a context FULL_EXIT needs an `invalidates` implication above the confidence threshold with complete coverage. Safety and premise exits never wait on context computation. No controller cancels protective orders; cancellation is confined to `pending_orders` rows.

**Entry binding.** The advisory pulse stamp (risk.js:1996-2013) becomes a numbered check that calls the policy and records assessment id, policy version and outcome in `checks_json`; every active producer except tick passes `evaluateTrade`, so one check covers scan, momentum account, momentum book and the limit transport, including its in-transaction re-check (momentum-limit-entry.js:89-121). For tick: bind assessment id and expiry to the standing permit at issue (entry-ledger.js:157), withdraw the permit on invalidation as volume and epoch changes do, and have `redeemPermit` refuse a stale binding (:341-347); `reserveEntry` stores the assessment id on the intent; a stale binding is RELEASED with `context_stale` before send.

| Lifecycle stage | Required behaviour | Anchor |
|---|---|---|
| Opportunity selection | rank valid setups by expected net after costs, relative strength, breadth; concentration from monetary cluster exposure; never buy every herd member | momentum-book ranking; risk.js:1703 |
| Before submission | the context check inside `evaluateTrade` at the last responsible point, every producer | risk.js:1911; loop.js:819 |
| Reservation / dispatch | intent carries assessment id and expiry; stale redeem refused; idempotency unchanged | entry-ledger.js:256, 329 |
| Working pending | a context predicate beside the SL predicate; cancel via the exec engine; the row stays working until broker evidence; no re-arm (a new reservation on the key is refused while a cancel is unresolved: a `cancel_requested_at` column) | pending-orders.js:483-508, 503-507 |
| Fill during reassessment | reconcile first (`reconcileIntents`, `linkAdoptedFill`), adopt residual and partial fills, protect, then re-evaluate under the arbiter | entry-ledger.js:666-689 |
| Existing position | the arbiter; bounded outcomes | position-manager.js:216 |
| After closure | join lifecycle, costs and the assessment ids seen at each decision for §10 | position-history.js, risk_events |

Re-entry requires a fresh producer setup, the per-symbol cooldown (risk.js:2268) and a campaign risk budget shared across the symbol's attempts (an extension of campaign-stop.js); a wider initial stop is admitted only with recomputed smaller size under the same money limits (risk.js:2463-2550). Autonomous operation within an enabled policy; no human decision per qualifying action.

## 9. Noise control, faults and degraded operation

State changes require persistence (two consecutive refreshes short and intermediate, one long, provisional), a minimum effect |Δρ| ≥ 0.25 with non-overlapping Fisher-z intervals, confidence ≥ 0.6, hysteresis (enter 0.7, leave 0.6). Detection delay and false alarms are measured on the §10 history, not on the eight losses.

| Fault | New entry | Working pending | Open position | Existing mechanism / gap |
|---|---|---|---|---|
| Stale or missing feed | DEFER until a fresh receipt, deadline = producer expiry | keep | management on existing stops; no context exit | feed receipts; pulse age; the matrix's fail-open (:115) becomes fail-closed for NEW risk on context-required strategies only |
| Unsupported or unmapped symbol | REFUSE if the strategy requires context, else ALLOW with coverage unknown recorded | keep | hold | registry gap |
| Disjoint sessions | horizon restricted; short unknown | keep | hold | §6 alignment |
| Partial computation | coverage incomplete → DEFER at most one refresh, then REFUSE | keep | hold | coverage accounting |
| Budget exhaustion | mandatory served late; discovery starved; last valid unexpired assessment else DEFER | keep | hold | scheduler |
| Corrupt or inconsistent version | treated as absent; logged | keep | hold | `loadStoredMatrix` catch |
| Simultaneous placement | the ledger's duplicate authority | — | — | entry-ledger.js:93-115 |
| Timeout | intent UNKNOWN blocks the key | cancel outcome unknown → row stays working, no re-arm | — | entry-ledger.js:19-23, 462-468 |
| Rejected cancellation | — | row working; bounded retry; reconcile is the truth | — | pending-orders.js:503-507 |
| Restart | UNKNOWN survives; assessments immutable; queue rebuilt from M | reconcile | protection audit | naked-position guard; tick restart hold |
| Competing controllers | — | — | arbiter precedence; single flight | acting-layer.js:63 |

Unknown context never triggers an exit and never reads as favourable. Money, limits, reservations and receipts stay account-scoped (acting-layer.js:86; risk.js:2034); market assessments are shared by verified instrument identity only. The account registry is the authenticated one in §3; no account is guessed. No live activation is granted by this document.

## 10. Calibration and economic validation

Definitions fixed before any computation: whole-position net (all closing deals of one broker position id; commissions and swaps from the statement fields; fees are not subtracted twice), profit factor, win rate, a scratch band (|net| < 0.1R), horizon cohorts, eligibility (bot-originated via trade-origin.js; manual rows reported separately, including the owner's demo-test rows of 14–15 Oct), open and pending exposure at dataset boundaries. Labels exclude execution defects (F1 goes to the defect ledger, not the strategy's record). Retracement studies reconstruct executable bid/ask paths (`exitSidePrice`, position-manager.js:104; the tick spool where retained), original risk from the intent's bracket and `broker_sl_initial`, MAE/MFE, and the first event among recovery, invalidation and risk exhaustion; a dual-touch candle stays `ambiguous` (the close-side rule at loss-postmortem.js:101-111 is not used for calibration). Candidate policies (entry confirmation, initial stop and size, trailing, premise invalidation, fresh-setup re-entry) are frozen and evaluated on a later period with purged overlaps, with costs, slippage, gaps, clustered losses, concurrent and pending exposure, turnover and missed winners; effective sample size and intervals reported. Leakage control: an assessment is usable only if generated at or before the decision time and its event-time cutoff precedes it. Recalibration on a schedule from mature outcomes only. The 23 deals are a case study. Future offline stress scenarios come from the observed paths (F1's skipped passes; F3's held exit; the SpotCrude fill-while-naked case); no live fault injection.

Missing evidence or feeds, named: retained fast-monitor per-position receipts (a window, not the latest pass); runtime correlation matrices retained per refresh; a verified instrument-context registry; a timestamped event feed with actuals (the ForexFactory calendar carries schedule only); corporate-action data for equity CFDs. None is invented here.

## 11. Acceptance scenarios for a later implementation

1. A universe above 24 subjects across three accounts: every mandatory subject and its required context covered or listed as missing with a reason; discovery starved under a one-token budget without any mandatory eviction (criterion 1).
2. A disjoint-session pair with an injected missing bar: short horizon unknown, long horizon computed with the overlap reported; a build whose constituent receipt is older than its period marks stale inputs and incomplete coverage (criterion 2).
3. The same proposal under two assessments differing only in premise implications yields different outcomes, both recorded with assessment id and policy version (criterion 3).
4. Invalidation between DISPATCHING and SENT, and during a cancel with a simultaneous partial fill: no second intent on the key, the fill adopted with protection, the reservation released only on broker evidence (criterion 4; extend `agent/acceptance/matrix.json` with a `context_invalidated` event).
5. One material shift reaches scan, momentum book, limit transport, tick permit and the arbiter in one refresh; a sub-hysteresis fluctuation changes nothing across ten refreshes (criterion 5).
6. Stale feed plus worker restart plus conflicting keeper/context proposals: broker stops unchanged, the loss cap still acts, the residual gap (a tick permit issued before a late withdrawal) measured (criterion 6).
7. The calibration join reproduces whole-position net to the statement, keeps ambiguous labels, refuses any assessment generated after the decision time (criterion 7).
8. Economic acceptance only on the frozen out-of-sample comparison with uncertainty, tails, false alarms, turnover and missed winners reported (criterion 8).

## 12. Ranked backlog (corrections first, then design)

| # | Change | Source | Contract | Incident evidence | Regression scenario | Verification |
|---|---|---|---|---|---|---|
| 1 | Fast-monitor TICK: per-position receipts retained for a rolling window (which rows were evaluated, with what quote, how late) and the tick pass's own duration bounded so a due premise evaluation is not lost to the overlap guard; the band's loss-guardian budget is a separate, lower-ranked item | fast-monitor.js:1478-1527 (the tick), :545 (the premise evaluation), the `fast_monitor_position_work_json` writer; loss-guardian.js separately | tick duration; receipt retention | F1/F9 (GER40: three tick skips 06:59–07:00:42Z) | a manual row with a breached premise and a slow tick pass: the premise exit fires on the next due pass and the receipt shows it | the retained receipts show the row checked each due pass; red before / green after |
| 2 | Minimum premise distance from the actual fill (a fraction of initial risk or k × spread), else `unreadable:too_close` and the broker stop governs | lib/premise.js `premiseAtFill` | premise arming | F2 (NAS100 2.6 points) | fill within the minimum of the level | the trigger reads unreadable; no close on noise |
| 3 | Session-aware time cap for cash-session instruments: cap at the lesser of the policy and the session close, or a hold-until-open decision recorded with the gap exposure | position-manager.js time cap; closed-market-hold.js | time cap vs session | F3 (GD.US) | a 1h NYSE setup with a cap expiring after the close | the exit is sent before the close or the hold is an explicit decision |
| 4 | One monitor row per broker position; every stop change journalled with a writer | reconciler.js adoption; native-trail-events.js | row identity; event journal | F5 (JPYX) | manual order then reconciler import | one row; a `trail_tightened` event with its source |
| 5 | Event-time alignment, unknown ≠ 0, per-pair quality in the matrix | correlation-matrix.js:54-94 | matrix payload gains n, ess, unknown | F7 | disjoint-session pair; missing bar | criterion 2 |
| 6 | Tiered universe, coverage accounting, scheduler | loop.js:6386-6404; new context-scheduler.js | `context_coverage_json` | F7/F8 | 40 symbols, 3 accounts | criterion 1 |
| 7 | Instrument-context registry from the broker catalogue | new instrument-context-registry.js; instrument-tree.js:11 | versioned mapping with provenance | F8 | unmapped symbol | criterion 1 |
| 8 | Assessment schema, policy function, `evaluateTrade` check replacing the advisory stamp | risk.js:1996-2013; new context-policy.js | `context_assessments`, `checks_json` | F8 | criterion-3 pair | criterion 3 |
| 9 | Intent and permit binding to assessment expiry | entry-ledger.js:256, 329, 157 | intent columns | F8 (tick path uncovered) | dispatch-time invalidation | criterion 4 |
| 10 | Pending context predicate, no re-arm | pending-orders.js:483-508 | `cancel_requested_at` | F8; §3.5 | cancel/fill race | criteria 4, 5 |
| 11 | Management arbiter | new management-arbiter.js; position-manager.js:216; fast-monitor.js:1159 | precedence table | F1 (a single closer with no fallback) | conflicting proposals | criterion 6 |
| 12 | Calibration dataset builder with ambiguity labels | loss-postmortem.js:101-111; position-history.js | cohort definitions | §3.1 | dual-touch candle | criterion 7 |

Items 1–4 are corrections with incident evidence; 5–12 are the design. None is a root-cause fix for the account's net result, which is dominated by valid stop fills on the owner's stress-test positions.

## 13. Sequence and activation (proposed, not authorised)

(1) Establish incident causes and input correctness: items 1–4 and the retained receipts; (2) dynamic coverage and reliable snapshots: items 5–7, compute-only on demo; (3) active policy consumption and arbitration: items 8–11 on one demo account with outcomes limited to ALLOW/DEFER/REFUSE, then pending cancel and HOLD/TIGHTEN/PARTIAL, then FULL_EXIT and tick binding; (4) economics and fault scenarios: §10–§11; (5) bounded activation per phase behind `context_policy_json.enabled_accounts`, kill via the exec-guard halt, rollback = flag off with assessments kept as immutable records and no stop, order or reservation altered. A comparison phase supports validation; the target is functioning proactive decisions. Live accounts are out of scope. Nothing is activated by this report.

## 14. The closing questions

- **Already implemented:** a live correlation veto on concentration (plus curated clusters); a per-symbol regime gate and trend-side permits; an advisory market pulse stamped on every verdict; correlation shift detection (display); broker-schedule entry gates and closed-market routing; durable account-owned reservations and idempotency; premise exits (tick-fired, frozen level); keeper/trail/guardian/loss-cap protection; closed-market hold for refused exits; postmortems with a lessons tuner.
- **Collected but unused:** the pulse stamp (`checks.pulse`, never read); correlation shifts; the previous matrix; `bar.t` on every fetched bar (dropped before correlation); the ForexFactory calendar (gate off by default); the native mirror's calendar-projected bars; the position-event journal for ongoing decisions.
- **Genuinely missing:** benchmark and sector relationships from verified instrument mappings; event-time-aligned returns with quality; a context consumer in the tick entry path and in every pending path after placement; a single management arbiter; retained per-pass monitor receipts; a timestamped fundamental-event feed with actuals; corporate-action data.
- **Losses that were valid protection:** JPN225, JPYX, US30 #1827 (broker stops); COST.US, US30 #1889 (premise closes); NAS100 (premise close as built, though the arming distance is a policy weakness).
- **Defects proven:** none to a reproduced-test standard; F1 (GER40) is a confirmed defect candidate with two independent records; F5 (JPYX duplicate row, unattributed tightening) is a record defect.
- **Policy changes with supporting evidence:** minimum premise distance (F2); session-aware time cap (F3); tick-pass receipts and duration bound, the band's loss-guardian budget separately (F1/F9).
- **Unproven:** any stop being "wrong" (F4's recovery after the fill is not proof); any fundamental cause of the 15 Oct moves; any cross-market relationship for the incident symbols; any improvement in net outcomes from the design.

Completion of this investigation is not implementation, activation or improved trading. The engineering corrections (items 1–4) and the design (items 5–12) each need their own order.

Conversation ref: owner instruction document and "read the .MD attached, supported by the logs as of today 6 AM SGT" (after № 15,080) · reported № 15,08x
Session: https://claude.ai/code/session_01C1hz86KuE5JKVq6W2KtUE2
