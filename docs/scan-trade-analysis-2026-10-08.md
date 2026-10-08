# Scan → trade → analysis: is it better than a week ago? (08-10-2026)

Ordered by the owner after № 12,272 ("thorough investigation with
scan-trade-analysis is better now than one week ago. Output: Report.
Invariant: these are real-world assessments. Assumption: all services are
working and only 2 accounts are active and verified"). Reported at
№ 12,275. Session `claude-builder`,
https://claude.ai/code/session_01C1hz86KuE5JKVq6W2KtUE2.

Every number is a production read made 08-10-2026 14:22–14:27 UTC with the
read secret (`/state/*` routes, Railway environment status). "This week" is
01-10 14:22Z → 08-10 14:22Z; "last week" is 24-09 → 01-10, derived where a
route only offers 7-day and 14-day windows as (14-day − 7-day). Nothing was
changed. P3 verdicts: Passed / Failed / Not Verifiable.

---

## 0. Answer

**Infrastructure: better. Trading outcome: not better. Record quality: worse
on one account.**

| Stage | A week ago | Now | Better? |
|---|---|---|---|
| Services | 6 up (one cpp-acct deploy failed 05-10, recovered) | 6 of 6 online, 0 crashed replicas, 0 pending work | same |
| Timeframe scanner native coverage | 0 of 690 profiles matched (07-10 04:01Z) | **690 of 690 matched** on …9908 (`bridge.timeframeCoverage: matched`) | **yes** |
| Tick scanner coverage | 2 silent demo tick feeds | demo tick feed now on …0949 with **no registered tick profile**: 509 `comparison_profile_unregistered`, 87,030 `reference_warmup_unknown`, 16,815 `native_expired`, 0 matched | no |
| Tick-level trail engine | off (every union refused until 07-10 03:55Z) | on both gateways: demo `amendsOk 5`, `alreadyTighter 3`, `failed 0`, no refusal | **yes** |
| Node stop amends | sent blind (two writers of one stop) | ratchet transactions: 8 of 8 `unchanged`, read-back 8 of 8 confirmed, 0 errors (since 13:44Z) | **yes** |
| Opportunities → fills, …7342 | 172 → 19 approved → 15 filled | 63 → 5 → 5 | fewer |
| Opportunities → fills, …0949 | 35 → 0 → 0 | 34 → 10 → 8 | more |
| Closed trades …7342 | 17, win 59 %, net +1.42 SGD, PF 1.04 | 7, win 29 %, net −20.40 SGD, PF 0.16 | **no** |
| Closed trades …0949 | 8, win 25 %, net −1,136 USD, PF 0.37 | 13, win 45 %, net −266 USD, PF 0.37 | smaller loss, same PF |
| Equity week change …7342 | −1.0 % (3,131 → 3,099) | −0.06 % (3,099 → 3,097) | drawdown slowed |
| Equity week change …0949 | −2.9 % (44,320 → 43,030) | −0.3 % (43,030 → 42,901) | drawdown slowed |
| Refused setups that would have paid | 319 of 868 refusals, +711 R left on the table | 120 of 321, +23 R | fewer refused winners, because fewer setups reached the gate |
| Exit cause unverified, …0949 | 0 of 8 closes | **9 of 13 closes** | **worse** (principle 4) |
| Exit cause unverified, …7342 | 4 of 17 | 0 of 7 | better |
| Goal table | not retained | 1 on track · 19 off track · 4 not measurable · 4 proposed | Not Verifiable week-on-week |
| Go-live readiness (30 d, all accounts) | — | NO: PF 0.67 vs bar 1.68 on 307 trades | — |

---

## 1. The assumption, checked

**"All services are working": Passed.** Railway reports all six services
online with one running replica each, no crashed replica, no pending work;
the only failed deployment in seven days is cpp-acct on 05-10 14:42Z,
superseded. Two controllers are failing inside the healthy services (§4).

**"Only 2 accounts are active": Passed as stated, with five others still
in the loop.** `/state/account-traffic-lights` shows exactly two accounts
with scan and enter on: **43097342** (demo, SGD 3,097) and **47790949**
(demo, USD 42,921). The other five are enabled: …3489 (live, manage_only, 1
position), …0058 and …9908 (demo, manage_only, 2 positions each), …2148 and
…9009 (live, paused, flat). Their positions are managed and their scans
counted; the selected account every unscoped route reports on is …9908,
which is NOT one of the two active ones.

**"… and verified": Failed as the system defines it.** Every account's link
light reads `unknown` — "the recorded broker roster is stale, so membership
cannot be confirmed" (`rosterKnown true, rosterFresh false`). The balances
are fresh (every snapshot within its 15-minute limit), so the accounts are
reachable; what is stale is the roster that proves which accounts the
gateway session holds.

---

## 2. Scan stage

**2.1 Volume.** 407,874 scans in the last 7 days across the roster (scans
are market observations shared by every account). The prior week's count
is **Not Verifiable** from the routes: the scanner mirrors retain 7 days and
the scan routes return the latest rows only.

**2.2 Native timeframe scanner: the one clear improvement.** On 07-10 the
bridge read `matchingProfiles: 0` of 690 (the registry anchored the
timeframe profiles on …9908 while the scanner streamed another account).
Today it reads `status: matched, registeredProfiles 690, matchingProfiles
690` on …9908, and the mirror holds 27,407 `matched` comparison records
against 215 `delivery_failed` and 503 `input_refused`. The timeframe
candidates are flowing: 4,592 fib_confluence, 294 donchian, 86 rsi2 on
…9908 and 1,283 / 57 / 29 on …0058 within the retention window.

**2.3 Native tick scanner: still not aligned.** The demo tick feed streams
from …0949 (moved from …0058 between 07-10 04:01Z and 08-10 02:58Z; by whom
is Not Verifiable). The registry still anchors its demo tick profiles on
…9908 and …0058, so the tick comparison population is 0 matched: 87,030
`reference_warmup_unknown`, 16,815 `native_expired`, 259 `input_gap`, and
509 records rejected as `comparison_profile_unregistered`; the tick source
cursor shows 2,061 rejected and 8 gaps. The live tick feed on …3489
produced 1,465 tick_momentum_breakout candidates; the two demo tick anchors
produced 6 and 23. The re-anchor payload of 07-10 is stale for the same
reason (assessment of 08-10, A7) and must not be applied as written.

**2.4 Opportunities (per active account, `/state/opportunity-funnel`).**

| Account | Window | Opportunities | Approved | Ordered | Filled | Approval % |
|---|---|---|---|---|---|---|
| …7342 | last week | 172 | 19 | 15 | 15 | 11.0 |
| …7342 | this week | 63 | 5 | 5 | 5 | 7.9 |
| …0949 | last week | 35 | 0 | 0 | 0 | 0 |
| …0949 | this week | 34 | 10 | 8 | 8 | 29.4 |

…7342's opportunity count fell by 63 % and its approvals by 74 %. The
14-day veto breakdown names what removes them upstream of the gate: `bad_rr
<3` 7,046 skips, weekend quiet 5,230, `vwap_trend OFF` 4,810, unfundable at
min lot 2,588, `fib_confluence OFF` 2,056, `donchian OFF` 2,054. On …0949 the
first guard is `max_positions N/5` at 10,829 skips — the account is at its
position cap most of the time, so most of its opportunities never reach the
gate.

**2.5 Strategy liveness (7 d).** On …7342 no strategy is `trading`: five are
`signalling_not_trading` (ema_pullback 63,433 signals → 3,251 decisions →
3,251 vetoes; fvg_retrace 15,712 → 517 → 517; fib_618_fade; tsmom_long),
six are unarmed, two silent; rsi_meanrev opened and closed 5 while unarmed
(its pin changed inside the window). On …0949 two strategies are `trading`
(rsi2_reversion 5 opened / 5 closed, rsi_meanrev 2 / 1) and four signal
without trading.

**2.6 Gate decisions (selected-account scope, `/state/decisions-daily`).**
Approved 18 / vetoed 272 on 28-09 → 01-10, against approved 11 / vetoed 176
on 02-10 → 08-10. Three of the seven days this week approved nothing.

**2.7 Refusal cost (all accounts).** This week 321 refusals, 199 scored, 120
would have paid, net **+23.1 R** refused-winner cost (goal `refusal_cost`
off track at ≤ 0 R). The 14-day figure is 1,189 refusals / 965 scored / 439
would have paid / +734.5 R, so last week alone refused 319 winners worth
about +711 R, almost all under `bad_rr <3`. The gate is refusing fewer
winners now, but because fewer setups reach it, not because its rule
changed.

Verdict for the stage: **Passed** on native timeframe coverage (0 → 690),
**Failed** on tick coverage (0 matched, feed unregistered), **Failed** on
throughput for …7342 (−63 % opportunities), **Not Verifiable** on raw scan
volume week-on-week.

---

## 3. Trade stage

**3.1 Closed trades (per active account, `/state/perf-ledger` 1W and
2W−1W; cross-checked against the trade ledger, counts agree).**

| Account | Window | Trades | Win % | Net | PF | Stops | Manual/other | Avg planned R:R | Avg realised R |
|---|---|---|---|---|---|---|---|---|---|
| …7342 | last week | 17 | 59 | +1.42 SGD | 1.04 | 9 (+1 ambiguous) | 7 | 2.9 | — |
| …7342 | this week | 7 | 29 | −20.40 SGD | 0.16 | 2 | 5 time-cap | 2.6 | −0.42 |
| …0949 | last week | 8 | 25 | −1,136 USD | 0.37 | 3 | 4 rank exits, 1 TP | 2.4 | — |
| …0949 | this week | 13 | 45 | −266 USD | 0.37 | 4 | 9 broker-side / market-close | 1.7 | −0.13 |

…7342 went from break-even to a loss on a third of the volume; five of its
seven closes this week were `time_cap_expired`, none hit a target. …0949
lost a quarter of last week's money on more trades, at the same profit
factor; no close hit a target in either week on either account. Thirty-day
PF across all accounts is 0.67 on 307 trades (go-live verdict NO; record
integrity clean: 3.9 % flagged, 2.6 % unattributed).

**3.2 Equity (nightly `/state/equity-curve`).** …7342: 3,131 (25-09) →
3,099 (01-10) → 3,097 (07-10); …0949: 44,320 → 43,030 → 42,901. Both
accounts lost less this week than last, in money and in percent.

**3.3 Exits.** The stop policy controller's last 8 amends (since the 13:44Z
boot) were all ratchet transactions answered `unchanged`, read back
confirmed 8 of 8, 0 errors, 0 refused. The demo trail engine tracks 1
position with `amendsOk 5, amendsFailed 0, alreadyTighter 3` and no push
refusal; a week ago it was refusing every union. The exit chain on both
accounts is `INSUFFICIENT` (…7342: 150 considered, 38 stamped; …0949: 211,
34; floor 100), so no exit-rule verdict is measurable yet. The trail-rule
replay over 30 days reads PF 0.37 / WR 15.3 % on 85 trades (goal off
track).

**3.4 Record of each close (principle 4: "unknown must not happen").**

| Account | Window | Closes | Exit cause unverified |
|---|---|---|---|
| …7342 | last week | 17 | 4 ("closed at the broker … not yet verified" 3, "trigger leg ambiguous" 1) |
| …7342 | this week | 7 | 0 |
| …0949 | last week | 8 | 0 |
| …0949 | this week | 13 | **9** ("exit cause and initiating actor not yet verified" 4, "market close filled at the broker — initiating actor or rule not verified" 5) |

Nine of …0949's thirteen closes this week carry no verified cause. The
cross-account history of unknown-P&L rows is 22 (20 written off), with
nothing blocking today's daily-loss total.

Verdict for the stage: **Passed** on exit mechanics (ratchet confirmed, trail
engine live, no failed amends), **Failed** on outcome (both accounts
negative, …7342 from PF 1.04 to 0.16), **Failed** on close attribution for
…0949 (9 of 13 unverified).

---

## 4. Analysis stage

**4.1 Goal table (`/state/goal-table`, 28 goals).** 1 on track (`records
fresh` 14/14), 19 off track, 4 not measurable, 4 proposed. The off-track
rows that bear on this question: all four strategy families below PF 1.5
(mean reversion 0.69 / n 338, breakout 0.64 / 124, trend 0.30 / 80, momentum
0.58 / 56; tail shares 1–5 % against ≥ 20 %); `refusal_cost` +24 R; `trail
rule` PF 0.37; `close_completeness` 18 incomplete (17 labelled
unrecoverable); `trade_reasons` 253 violations over 372 trades (148
pre-contract); `plans_scored` 95.1 % (exits within rule 40.5 %);
`monitor_cadence` 64.5 % of fast-monitor ticks skipped (busy 71 % of the
window, max tick 9.3 s); `loop_latency` p95 69.3 s over 37 loops;
`account_horizon` 0 of 7 declared; `fundable_universe` 2 of 7 current;
`momentum_universe_tradable` 47.5 %. A week-ago goal table is not retained
by the route, so the week-on-week on these is **Not Verifiable**; the
04-10 handover's snapshot is the nearest prior reading.

**4.2 Position records.** Complete rows: …7342 29 of 246, …0949 33 of 456
(the rest refused: `broker_evidence_pending` dominates). Rows opened AFTER
the 11-09 writer contract and still missing `direction_reason` and `volume`:
18 on …7342 (14 `bot_pending_fill`, 2 adopted, 2 market dispatch) and 14 on
…0949 (11 adopted, 3 pending fill). These are writer gaps on rows the
contract says must be complete. **Failed.**

**4.3 Controllers.** 38 of 40 ok. `verify_watchdog` failed 3–5× in a row
nine times today (09:27Z → 14:02Z: "watchdog incident record unreported …
or busy"); `momentum_partial` failed 4× in a row at 13:48Z — `capped_hybrid
trade 1771: cTrader error INCORRECT_BOUNDARIES`, six minutes after the
Node deploy of #1269 (the capped hybrid profit-taking, 13:42Z). That is a
new failure introduced this week, in the hour it shipped.

**4.4 Slow reads.** Four state routes did not answer within 40 s on the
first pass (`decisions-daily`, `goal-table`, `strategy-liveness`,
`watchdog`); all answered within 120 s. Together with the 64.5 % skipped
monitor ticks and p95 loop 69 s this is the same event-loop pressure the
startup-window goal records (worst stall 19.9 s reconciling positions at
the 13:44Z boot).

Verdict for the stage: **Failed** on the goals that measure edge (0 of 4
families), **Failed** on record completeness post-contract, **Not
Verifiable** week-on-week for the goal table itself, **Passed** on controller
coverage (38/40) with two named failures.

---

## 5. What moved the needle, and what did not

Improved this week, by measurement: native timeframe coverage 0 → 690
profiles; the tick-level trail engine from refused to accepted and
amending; Node stop amends from blind writes to confirmed ratchets (8/8
read back); equity drawdown slowed on both active accounts (−1.0 % → −0.06
%, −2.9 % → −0.3 %); refused-winner cost 711 R → 23 R.

Not improved or worse: the tick scanner has no registered profile on the
feed it streams; …7342's opportunity flow fell 63 % and its closes went from
PF 1.04 to 0.16 with five of seven time-capped; …0949 is pinned at its
5-position cap (10,829 skips) and 9 of its 13 closes have no verified cause;
no close on either account hit a target in two weeks; every strategy family
is below PF 1; a controller introduced today is failing.

The honest reading: this week the machinery got safer (stops cannot be
widened, the engine trails, the timeframe scanner sees its profiles) and
the account lost less money, but it lost less mostly by trading less, and
nothing in the two weeks shows an edge. "Better than a week ago" is true of
the plumbing and not yet of the trading.

---

## 6. What to do next, in order

1. Register the tick profiles on the feed that actually streams (…0949
   demo) or point the feed back at the registered account — the owner's
   decision, then a fresh re-anchor payload (not the 07-10 one).
2. Trace the 9 unverified closes on …0949 this week to their broker deals
   and record the initiating actor (the close-cause verifier exists; it did
   not reach these rows).
3. `momentum_partial` INCORRECT_BOUNDARIES on trade 1771: fix in #1269's
   successor or disarm the capped hybrid until fixed.
4. …7342: the time-cap is the exit on 5 of 7 closes — either the cap is too
   short for its setups or the setups are not moving; score them against
   their plans before changing the cap.
5. Refresh the broker roster so the link lights can read green (the
   "verified" half of the owner's assumption).
6. Event-loop pressure (64.5 % skipped ticks, four routes over 40 s): the
   fast monitor is losing two of three ticks, which caps how often any exit
   rule can act.

---

## 7. Invariants (P3)

| Invariant | Verdict |
|---|---|
| These are real-world production readings, not replays or tests | Passed (routes and Railway, 14:22–14:27Z; sources named per table) |
| All six services were up during the reads | Passed |
| Exactly two accounts have scan and enter on | Passed (43097342, 47790949) |
| The two accounts are verified members of the gateway roster | Failed (roster stale on all 7) |
| Week-on-week figures come from the same source for both windows | Passed for funnel, perf-ledger, equity, refusal cost; Not Verifiable for scan volume and the goal table |
| Nothing in production was changed | Passed |

Conversation ref: ordered after № 12,272 · reported № 12,275
Effort: max
Session: https://claude.ai/code/session_01C1hz86KuE5JKVq6W2KtUE2
