# Result — Algorithmic Decision Integrity Audit, PART 2: the blocked sections, unblocked

**Continues:** `instr/Result_Bot-Trade_Algorithmic_Decision_Integrity_Audit_2026-08-06.md`
**Run:** 2026-08-06 03:52–04:00 UTC · **SHA at run:** `8cebc92` (`main`)
**Mode:** READ-ONLY RUNTIME. No order placed, amended, cancelled or closed. No credential,
account mode, risk limit or environment variable changed. Every number below was read
through the read-tier credential over `GET /state/*`; the raw payloads are in
`audit/algo-integrity-2026-08-06/evidence/part2/`.

---

## 0. Why this part exists

Part 1 reported **7 of 18 hypotheses BLOCKED** and marked §9–§15 unavailable, for one
stated reason: *"this environment has no agent DB and holds a read-tier credential by
design."* Part 1's §7 then listed, per blocked deliverable, the exact evidence that
would complete it.

That reasoning was correct about the database and **wrong about the credential**. The
read-tier credential is not a barrier to reading — it is the thing that grants reading.
Every blocked item in §7 named data that production already exposes on an authenticated
read route. Part 1 concluded "no production data" from the absence of a local DB file
without checking whether the same rows were reachable over HTTP. They were.

Two further changes since Part 1 removed the remaining obstacles:

- **§13's blocker is gone.** It required *"a recent successful broker session, fresh
  tick, reconciled state"* and reported the sidecar unreachable. Both sidecars are now
  reachable and all five accounts are authorised and trading (#660–#666).
- **The four demo accounts are authorised.** Part 1's funnel had almost no post-gate
  rows to read because dispatch was short-circuited upstream. It no longer is.

So this part completes what it can and says plainly what still cannot be done.

**Headline: the central verdict changes.** Part 1 said `EDGE UNPROVEN` and left open
whether the edge was absent or merely unmeasured. With the funnel readable, a third
answer appears, and it is the one the evidence actually supports: **the system is not
failing to find edge — it is refusing almost everything it finds, against a payoff
threshold it has never once achieved.**

---

## 1. F-RR-01 — the R:R floor in force is 3–4× the configured one (CRITICAL)

### The measurement

`GET /state/risk-full?account=<id>`, all five accounts, 2026-08-06 03:56 UTC:

| Account | Effective `minRR` | Global default | Ratio | Side |
|---|---|---|---|---|
| 43097342 | **6.16** | 1.5 | 4.1× | demo |
| 46130058 | **6.00** | 1.5 | 4.0× | demo |
| 46979908 | **5.00** | 1.5 | 3.3× | demo |
| 47790949 | **4.68** | 1.5 | 3.1× | demo |
| 42993489 | **4.50** | 1.5 | 3.0× | **LIVE** |

Each value sits in that account's own overlay: `risk.overlayKeys` contains `minRR` and
`risk.overridden` lists it, scoped to the account. The global `risk_config_json` still
reads `minRR: 1.5`, which is why every previous look at this number — including mine
earlier in this session — reported 1.5. `GET /state/risk-full` takes `?account=`, not
`?accountId=`; an unrecognised query parameter is silently ignored and the **global**
config is returned. That is how a per-account risk limit stayed invisible.

### What it costs

`GET /state/veto-breakdown`, 7-day window, 60,989 vetoes across 266 distinct guards:

| Vetoes | Guard family |
|---:|---|
| 30,123 | `unknown_daily_pnl (account)` — **now cleared**, see §4 |
| **11,211** | **`bad_rr`** |
| 3,671 | `daily_loss_limit_hit` |
| 3,069 | `enabled in registry but not in the sidecar authorized roster` — fixed by #660–#666 |
| 2,353 | `strategy 'fib_confluence' is OFF` |
| 1,620 | `insufficient_equity … usd_per_lot_unknown` |

`bad_rr` splits by the floor it was tested against:

| Vetoes | Floor | Example |
|---:|---|---|
| 4,761 | 4.5 | `bad_rr 1.54<4.5` |
| 2,970 | 3.2 | `bad_rr 1.60<3.2` |
| 1,309 | 4.68 | `bad_rr 1.60<4.68` |
| 1,203 | 2.68 | `bad_rr 2.00<2.68` |
| 299 | 5 | `bad_rr 2.00<5` |
| 166 | 6.16 | `bad_rr 2.49<6.16` |
| 164 | 6 | `bad_rr 2.49<6` |
| **311** | **1.5** | `bad_rr 1.48<1.5` |

**Only 311 of 11,211 — 2.8% — were judged against the documented 1.5 floor.**

A 100-row sample of `risk_events` for 47790949 shows 93 of the last 100 proposals
vetoed as `bad_rr`, every one against 4.68, spread across seven different strategies
(`fib_618_fade`, `burnin`, `vp_value`, `fib_confluence`, `va_breakout`,
`donchian_breakout`, `vwap_trend`). Rejected R:R values: 1.48, 1.50, 1.54, 1.59, 1.60,
2.00, 2.49, 2.74. This is not one strategy proposing bad trades. It is every strategy
proposing ordinary trades into a gate calibrated for extraordinary ones.

### The finding that makes it a defect rather than a preference

`GET /state/postmortems` for 47790949 — 30 closed trades with `r_multiple`:

```
n=26 with an R multiple   mean +0.03R   median -0.01R   range -0.11R … +0.91R
wins 8 (30.8%)  avg +0.15R
losses 18       avg -0.03R
BEST REALISED R ON ANY WINNING TRADE:  +0.91R
```

**The entry gate demands 4.68R. The best outcome this account has ever realised is
0.91R.** The average winner returns 0.15R. The gate is not filtering for a payoff the
system sometimes achieves and sometimes misses — it is filtering for a payoff the
system has never once produced, by a factor of five.

Two readings are possible and they are not exclusive:

1. **The floor is mis-set.** Nothing at 4.68R survives contact with a real market on
   these instruments and timeframes, so the gate approves ~1% and the strategies never
   get to demonstrate anything.
2. **The exit engine truncates.** Trades that *are* approved at RR ≥ 4.68 still close
   at ≤ 0.91R, which means the profit keeper, the ratchet, the time cap or the trail is
   ending them long before the target the gate insisted on. The gate demands 4.68R of
   *planned* payoff and the exit engine delivers 0.15R of *realised* payoff on winners.

Either way the entry gate and the exit engine are calibrated against different
universes, and the R:R the gate enforces is not a quantity the rest of the system is
built to capture. **This, not strategy quality, is the dominant reason the edge is
unproven: the system takes 7 trades a day out of 1,802 opportunities.**

### What is NOT claimed here

I am not asserting the correct value of `minRR`, and I have not changed it. `minRR` is
a risk limit and CLAUDE.md reserves those for the owner. What is asserted, and
evidenced, is narrower and factual: **the enforced floor is not the configured floor,
it differs per account, it was not visible on the route built to show it, and it
exceeds every payoff the system has actually realised.**

### Provenance — an honest gap

`GET /state/config-proposals` shows **no open `minRR` proposal**. `config-controller.js:132`
does contain a rule `minRR_below_breakeven` that proposes *raising* `minRR` when the
realised payoff is below breakeven, and its output shape matches these values. But I
could not read an applied-proposal history that names the write, so **I cannot prove
these five values came from that rule rather than from a manual edit.** Recorded as
unknown rather than assumed. The evidence needed is the `action_log`/`bot_changes` rows
carrying the `acct:<id>:risk_config_json` write.

---

## 2. F-SIZE-01 — a single trade spent more than the whole day's risk budget (DANGER)

From `GET /state/config-proposals`, account 46130058, severity `danger`, raised by the
system's own controller and still open:

> *"A single trade lost 9,171.76 against a daily cap of 8,293.13. One trade spent more
> than the whole day's risk budget, so position sizing is not enforcing the per-trade
> risk it claims. Raising the daily cap would hide this, not fix it."*

This is Part 1's §11 (risk of ruin, capital fragility) — the deliverable that was
blocked for want of balances and positions. It is now answered, and the answer is that
**the per-trade risk control did not hold.** `perTradeRiskPct` is 0.01 and
`maxRiskCapPct` 0.015; a loss of 110% of the daily cap in one position is not
consistent with either.

Part 1 rated capital safety `MIXED` on the grounds that the *controls exist in code*.
They do. This is evidence that at least once they did not *bind*. That moves the §11
verdict from "controls present, sufficiency BLOCKED" to **"controls present, at least
one documented breach, sufficiency DISPROVED for that case."**

The controller's own recommendation is the right one and I endorse it without
qualification: **find why that trade was sized past its own stop before changing any
cap.** Owner decision; no change made.

---

## 3. F-PEND-01 — the pending-order engine armed a disabled strategy

**Correction, made before this document was merged.** An earlier draft of this section
asserted in the present tense that `fib_confluence` "is OFF". **It is not.** The registry
has carried `defaultOn: true` for `fib_confluence` since 2026-07-27, and
`GET /state/strategy-liveness` reads `armed: true` for it right now. The owner said so,
and the owner was right.

What the veto-breakdown actually shows is a **historical** window:

| Vetoes | Guard | Last occurrence |
|---:|---|---|
| 2,353 | `strategy 'fib_confluence' is OFF` | 2026-08-05 12:27:13 |
| 1,225 | `strategy 'vwap_trend' is OFF` | 2026-08-05 03:01:55 |

Both stopped roughly sixteen hours before this audit ran. Both strategies are armed now.
The 7-day veto window aggregates a period when they were toggled off in
`enabled_strategies_json` — a state override, never the code default — and I read a
cumulative count as a current condition. That is the same error Part 1 made in a
different key: **treating an aggregate over a window as a description of now.**

**SECOND CORRECTION, 2026-08-06 14:35 SGT — the residual finding does not survive
either.** The paragraph that stood here claimed *"nothing checked the strategy toggle
before arming a pending order, and nothing will stop it recurring"*. Both halves are
wrong:

- `pause-disposition.js:222` cancels any working pending order whose strategy is no
  longer armed, with an explicit `strategy_disarmed` signal and a reason string.
- `pending-orders.js:277-283` feeds it the live armed set on every pass.
- `pause-disposition.test.js:172` pins the behaviour.

The mechanism exists, is wired, and is tested. And `expired` is not `cancelled`: the
49 rows hit their own expiry deadline, which is what a resting order that was never
touched is supposed to do. Placed while the strategy was armed — which it was, by
default, throughout — and expired normally.

**There is no defect here.** What is left is an observation with no action attached:
`fib_confluence` accounts for 45 of 50 pending orders and 1 opened position, which is
a fill rate worth understanding but is not a bug in the lifecycle.

`GET /state/pending-orders`, account 47790949, 50 rows:

| Status | Count |
|---|---|
| `expired` | 49 |
| `working` | 1 |

| Strategy | Rows |
|---|---|
| `fib_confluence` | **45** |
| `vwap_trend` | 4 |
| `rsi2_reversion` | 1 |

`fib_confluence` is **OFF** — it accounts for 2,353 vetoes reading
`strategy 'fib_confluence' is OFF in Auto Trade & Open`. So the pending-order engine is
placing resting orders for a strategy the risk gate will refuse on sight, and 49 of 50
duly expired unfilled. All 50 carry an `order_id`, so these reached the broker.

This is Part 1's §14, previously blocked. The lifecycle itself is sound — orders are
placed, tracked, and expired correctly, with no leaked or orphaned rows. The defect is
upstream: **nothing checks the strategy toggle before arming a pending order.**

**Attribution gap, reported rather than smoothed over:** the route's own coverage block
says `total 507, attributable 117, unstamped 390, pct 23.1, complete: false`. **77% of
pending-order rows carry no account stamp**, so the per-account figures above describe
under a quarter of the population. The direction of the finding is not in doubt — 45 of
50 for a disabled strategy is not a sampling artefact — but the magnitude is not
established, and no rate computed from these rows should be treated as portfolio-wide.

---

## 3b. F-LIVE-01 — four armed strategies produced 22,966 signals and opened nothing

Re-reading `GET /state/strategy-liveness` to check §3's correction turned up a stronger
result than §3 itself. Seven days, decisions and opens scoped to 47790949, signals
across all accounts (scans are market observations):

| Strategy | Armed | Signals | Opened | System's own verdict |
|---|---|---:|---:|---|
| `fib_confluence` | ✔ | 26,409 | 1 | trading |
| `vwap_trend` | ✔ | 21,583 | **0** | **signalling_not_trading** |
| `rsi2_reversion` | ✔ | 6,044 | 3 | trading |
| `vp_value` | ✔ | 3,733 | 3 | trading |
| `donchian_breakout` | ✔ | 2,409 | 2 | trading |
| `va_breakout` | ✔ | 539 | **0** | **signalling_not_trading** |
| `ema_pullback` | ✔ | 521 | **0** | **signalling_not_trading** |
| `rsi_meanrev` | ✔ | 373 | 1 | trading |
| `fvg_retrace` | ✔ | 323 | **0** | **signalling_not_trading** |
| `fib_618_fade` | ✔ | 3 | 6 | trading |
| `cup_handle` | ✔ | **0** | 0 | **silent** |
| `inv_cup_handle` | ✔ | **0** | 0 | **silent** |
| **TOTAL** | | **61,937** | **16** | |

**Every strategy is armed.** Nothing is switched off. And yet:

- **Four strategies produced 22,966 signals in seven days and opened zero positions.**
  The system labels these `signalling_not_trading` itself — the verdict already existed,
  computed and served on a route, and nobody had read it.
- **Two strategies produced no signals at all in seven days.** `cup_handle` and
  `inv_cup_handle` are `silent`. Armed, scanned, and never once firing. That is a
  different failure from being vetoed and needs a different investigation — a detector
  that never signals is either mis-specified or starved of the bars it needs
  (`minBars: 210`, the highest in the registry after `ema_pullback`).
- **61,937 signals produced 16 opened positions**, a 0.026% conversion.
- `fib_618_fade` opened 6 positions on 3 signals — more opens than signals, which means
  those opens came from the pending-order path rather than live scan signals. Consistent
  with §3, and the only strategy where that inversion appears.

### A wrong inference I nearly published

The same payload shows `vetoes == decisions` exactly, for every strategy, all twelve
rows. That looks damning and **means nothing.** Part 1 §2 already established why:
`decision_log` only records skips and vetoes — *"nothing in the pipeline writes a row
when a dispatch SUCCEEDS (grep: no `decision: 'proceed'` anywhere), so a healthy,
busily-trading account produces NO decision rows."* The identity is a property of the
table's schema, not of the system's behaviour, and quoting it as evidence of a
100%-veto rate would have been exactly the kind of number this audit is supposed to
catch. **The honest column is `opened`.** Recorded here because the trap is well
disguised and the next reader deserves the warning.

---

## 3c. F-CUP-01 — the system diagnosed its own silent strategy, and nobody read it

§3b reported `cup_handle` and `inv_cup_handle` as `silent` — zero signals in seven
days — and guessed at the 210-bar `minBars`. The guess was unnecessary. **A
diagnostic for exactly this question already exists**, built 2026-08-05, writing to
`cup_handle_diagnostics` and served at `GET /state/cup-handle-funnel`. Its output:

```
window 7d · 1,137,570 traces · 218 symbols

scanned                     1,137,570   stopped 836,790
trend context holds           300,780
cup shape valid               300,780   stopped 274,403
handle length vs cup length    26,377   stopped  13,551
cup bottom is rounded          12,826   stopped   2,982
handle retrace within half      9,844   stopped     165
handle volume below the leg     9,679   stopped     589
price broke the rim             9,090   stopped   4,104
breakout volume confirms        4,986   stopped   3,209
reward:risk clears the floor    1,777   stopped       0

wouldHaveFired  1,777
deepestReached  cleared_every_gate
```

And its own verdict field, written by whoever built it:

> *"1777 trace(s) cleared every gate. If no signal was emitted for those, the
> diagnostic twin has drifted from the search it mirrors — that is a bug, not a
> market."*

**No signal was emitted for those.** `strategy-liveness` counts `signals` as rows in
the `scans` table grouped by strategy, and `cup_handle` has **zero** over the same
seven days. The two numbers are comparable in the way that matters: the twin mirrors
the search, the twin says 1,777 setups qualified, and the search recorded none.

So the antecedent of the diagnostic's own conditional is satisfied, and the conclusion
is its author's, not mine: **this is a bug, not a market.**

**What is NOT yet established.** Whether the drift is in the twin (too permissive) or
in the search (dropping qualifying setups). The twin was already tightened once for
exactly this class of error — `fib-strategy.js` carries a comment dated 05-08-2026
about the trace having been handed 450 bars where `computeCupHandleSignal` got 210,
*"a diagnostic that is more permissive than the thing it diagnoses is worse than
none"*. That fix may be incomplete, or the remaining gap may be elsewhere: the search
keeps only the BEST candidate per strategy per symbol (`bestByStrategy`), while the
trace counts every bar it examines. That alone could explain a large ratio — but not
a ratio of 1,777 to zero.

**This is the second finding today that the system had already computed and served on
a route that nobody had read** — the first being the `danger` sizing proposal in §2.
That pattern is worth more than either finding: the instrumentation is good and the
reading of it is not.

---

## 4. §10 — the opportunity and veto funnel, previously blocked

`GET /state/opportunity-funnel`, 1-day window:

```
opportunities   1,802
  approved         18   (1.0%)
  ordered          10   (55.6% of approved)
  filled            7   (38.9% of approved)

evaluations     8,237      re-evaluation ratio 4.6×
unkeyed           434      excluded from every count above
```

Three separate leaks, and only the first was previously known:

1. **1,802 → 18 (−98.9%)** the risk gate. §1 above is most of this.
2. **18 → 10 (−44%)** approval to order. **Eight approvals never became orders.** This
   loss is *after* every guard has already said yes, and Part 1 could not see it at all.
   It is the highest-yield thing on this list: whatever is dropping these has already
   passed every deliberate filter, so nothing is protecting the account by dropping them.
3. **10 → 7 (−30%)** order to fill. Consistent with limit orders not being reached; not
   in itself alarming, but it means the realised trade count is 39% of the approved count.

The 7-day `summary` gives `proposalsApproved 1,092`, `proposalsVetoed 52,409`,
`approvalRate 2%`, `upstreamSkips 8,646`, `distinctGuards 266`. The 434 unkeyed
evaluations predate `opportunity_key` and are correctly excluded rather than silently
folded in — the route says so itself, which is the behaviour Part 1's §21 asked for.

**H04 (strategy starvation) is now testable and the answer is yes, but not for the
reason the hypothesis proposed.** Strategies are not starved of setups — 1,802
opportunities in a day is not starvation. They are starved of *approvals*.

---

## 5. §12 — trade management and profit retention, previously blocked

`GET /state/postmortems`, account 47790949, 30 closed trades.

**Classification** (what the system says happened):

| Class | n |
|---|---|
| `stop_hunt` | 9 |
| `clean_win` | 8 |
| `chop` | 5 |
| `time_cap` | 5 |
| `thesis_wrong` | 2 |
| `gave_back` | 1 |

**Result** (what the money did):

| Result | n |
|---|---|
| `Miss` | 17 |
| `Partial` | 12 |
| `Win` | **1** |

**These two tables disagree, and the disagreement is the finding.** The classifier
records 8 `clean_win`; the result column records **one** `Win`. A "clean win" that
produces a `Partial` is a trade whose thesis worked and whose payoff did not — which is
the same truncation §1 inferred from the R multiples, arriving here independently from
a different table.

`stop_hunt` at 9 of 30 (30%) is the largest single class, and combined with `chop` (5)
and `time_cap` (5) it says 63% of closed trades ended for a reason unrelated to the
thesis being wrong — only 2 of 30 are `thesis_wrong`. **The strategies are not
primarily being beaten on direction. They are being beaten on stop placement, holding
time, and exit discipline.**

**`entry_quality` is `unknown` on all 30 rows — and the reason is not the one stated
here originally.** This section claimed the field was *"populated by nothing"*. That is
wrong. It is written at `loss-postmortem.js:528` from `entryQuality(t.confluence_count)`,
`trades.confluence_count` is written at `loop.js:721`, and
`loss-postmortem.test.js:305` pins `'Watch'` at a confluence count of 2. The chain is
intact.

`entryQuality` returns `'unknown'` when `confluence_count` is null, and on all 30 rows
it is. So is `confluence_tool_count`, and `setup_thesis` is the empty string on all 30.

**`loop.js:721` is the DISPATCH path** — the UPDATE that runs when the bot consciously
opens a position. Thirty closed trades with null confluence and no thesis did not go
through it. **They were adopted by the reconciler, not opened by a decision.**

That is a larger and more useful finding than a dead column, and it connects to the
duplicate-cluster incidents (tasks #179, #184) and to the 63% `other` attribution
noted below: **the postmortem corpus is mostly positions the bot found rather than
chose.** Entry-quality analysis has nothing to work with because there was no recorded
entry, and no amount of fixing the field will change that. The question to ask instead
is why so few closed trades carry a dispatch record.

The strategy label is `other` on 19 of 30 rows, so per-strategy attribution from this
table is weak: 63% of the sample is unattributed. Part 1's §21 rule applies — that is
`blocked`, not `passed`.

---

## 6. What cleared on its own

**`unknown_daily_pnl` is no longer blocking.** It is the largest guard in the 7-day
window at 30,123 vetoes (49% of all vetoes), and it was task #180's finding. As of
2026-08-06 03:52 UTC, `GET /state/unknown-pnl` returns:

```
blocking 0   unfillable 0   writtenOff 0
verdict: "nothing is blocking — the daily-loss total is complete"
```

The historical count stands as a record of what it cost. The condition is resolved and
needs no action. **The consequence matters: with `unknown_daily_pnl` cleared, `bad_rr`
becomes the single largest live constraint on the system — 11,211 vetoes and now the
top guard by a wide margin.** §1 is therefore not merely the most interesting finding
here; it is the binding one.

---

## 7. Hypothesis ledger — Part 1's blocked rows, resolved

| ID | Hypothesis | Part 1 | Part 2 |
|---|---|---|---|
| H03 | Live/backtest mismatch | blocked | **still blocked** — needs bar-level fixtures; no bar route |
| H04 | Strategy starvation | blocked | **CONFIRMED, redirected** — starved of approvals, not setups (§4) |
| H09 | Wrong trigger clock | blocked | **still blocked** — needs runtime event timing |
| H12 | P&L lineage defects | blocked | **RESOLVED** — `unknown-pnl` reports a complete daily total (§6) |
| H13 | Pending-order lifecycle gaps | blocked | **CONFIRMED** — arms a disabled strategy; 77% unstamped (§3) |
| H14 | Defensive drift / winner truncation | blocked | **CONFIRMED** — 8 `clean_win` → 1 `Win`; best-ever 0.91R (§1, §5) |
| H16 | Capital fragility | blocked | **CONFIRMED** — one trade > full daily cap (§2) |

**5 of 7 previously-blocked hypotheses are now decided. 2 remain blocked**, both for the
same honest reason: they need bar-level and event-level data that no read route exposes.
Neither is marked passed.

---

## 8. What is STILL blocked, and what would unblock it

| Deliverable | Blocker | Evidence needed |
|---|---|---|
| §9 backtest validity, walk-forward, bootstrap CIs, cost stress | no bar route | a read route serving stored bars per symbol/timeframe, or a DB copy |
| §10.2 marginal veto counterfactual replay | as above | vetoed rows **plus** the bars after each decision timestamp |
| §15 human awareness study | requires the operator | owner time; charts rendered to the decision timestamp only |
| Provenance of the five `minRR` overlay writes | no applied-change route surfaced it | `action_log` / `bot_changes` rows carrying the `acct:<id>:risk_config_json` write |
| Per-strategy postmortem attribution | 63% of rows labelled `other` | the strategy-label backfill applied to `trade_postmortems` |
| Portfolio-wide pending-order rates | 77% of rows unstamped | account stamping backfilled on `pending_orders` |

**None of these is marked passed.**

---

## 8b. Looked at and NOT raised

Recorded so the absence is a decision rather than an omission.

- **`sizing_failed: cTrader error: CH_ACCESS_TOKEN_INVALID`** — real, and exactly the
  shape of a token-expiry incident. **2 occurrences in 60,989 vetoes.** Two events is
  noise, not a pattern, and inflating it would make this document less trustworthy, not
  more. Worth watching only if the count grows.
- **`weekend quiet hours`, 1,240 vetoes** — working as designed and owner-approved
  (task #164, with the crypto exemption in #172). Not a defect.
- **`enabled in registry but not in the sidecar authorized roster`, 3,069 vetoes** —
  real and expensive, but this is the outage already diagnosed and fixed across
  #660–#666. Reported in Part 1 as F-CONN-01; not re-raised here.
- **`overexposed_*` and `max_positions` families, ~2,100 combined** — concentration
  guards doing their job against the duplicate-cluster mechanism (tasks #179, #184).
  Correct behaviour.

---

## 9. Revised verdict

Part 1: `BOUNDED SPECULATION` · defence `MIXED` · **`EDGE UNPROVEN`**.

Part 2 keeps all three labels and sharpens the third. `EDGE UNPROVEN` remains correct,
but it is no longer the whole answer, because the reason is now visible:

> The edge is unproven **because the system almost never trades.** 1,802 opportunities
> produced 7 fills in a day, and the dominant filter is an R:R floor of 4.5–6.16 —
> three to four times the documented 1.5, set per account, invisible on the route built
> to display it, and higher than any payoff the system has ever realised (best 0.91R,
> average winner 0.15R). A gate calibrated above the system's demonstrated ceiling
> cannot be satisfied by a good setup; it can only be satisfied by a mis-measured one.

On defence, one label does change. Part 1 rated capital safety `MIXED` because the
controls exist in code. §2 documents a case where a control did not bind — one trade
losing 110% of the daily cap. That is not a stronger `MIXED`; it is a specific,
evidenced failure, and the system's own controller flagged it as `danger` before this
audit did. **Credit where due: the machine caught this one itself. Nobody had read it.**

### The order I would fix them in, and why

1. **§1 `minRR`** — binding constraint; nothing downstream can be measured until the
   funnel passes more than 1%. **Owner decision: it is a risk limit.**
2. **§2 per-trade sizing** — the only finding here that can lose money faster than it
   is measured. **Owner decision: it is a risk limit.**
3. **§4 leak 2, approval → order** — 44% loss *after* every guard approved. Almost
   certainly a plain defect rather than a policy, and it needs no risk decision to
   investigate.
4. **§3 pending orders for disabled strategies** — cheap fix, removes 2,353 vetoes and
   49 wasted broker orders from the record.
5. **§3b the two `silent` detectors** — `cup_handle` and `inv_cup_handle` produced zero
   signals in seven days while armed. Either mis-specified or starved of their 210-bar
   history requirement; a detector that never fires is invisible in every veto table.
6. **§5 `entry_quality` always `unknown`** — a dead field silently degrading every
   analysis keyed on it.

Items 3–6 are ordinary defects I can take without a risk decision. Items 1–2 are yours.

---

## 10. Corrections to Part 1

Stated plainly, because an audit that will not correct itself is not an audit.

1. **"No production data" was wrong.** Part 1 inferred it from the absence of a local
   agent DB. The data was reachable the whole time over authenticated read routes, and
   Part 1's own §7 listed exactly which rows were needed without checking whether a
   route served them. Five of seven blocked hypotheses fell to a credential Part 1
   already held. **The lesson generalises: "I cannot read the database" is not the same
   claim as "the data is unavailable", and Part 1 treated them as one.**
2. **The read-tier credential was described as a limitation.** It is a limitation on
   *writing*. Framing it as a barrier to evidence-gathering is what produced (1).
3. **`minRR: 1.5` was reported as fact** in Part 1 and again by me earlier in this
   session, from an unscoped read. The scoped read gives 4.5–6.16. The number was never
   1.5 on any account that trades.

And one correction to an earlier draft of **this** document, kept rather than erased:

4. **§3 asserted `fib_confluence` "is OFF".** It is not, and the registry has carried
   `defaultOn: true` for it since 2026-07-27. The owner said so and was right. I had
   read a cumulative 7-day veto count as a current condition; the OFF vetoes stopped at
   2026-08-05 12:27. The same mistake in a different key as (1): **an aggregate over a
   window is not a description of now.** Chasing the correction is what produced §3b,
   which is a larger finding than the one it replaced.
5. **§3's residual claim — "nothing checks the strategy toggle" — was also wrong.**
   `pause-disposition.js:222` does exactly that, wired and tested. No defect remains in
   that section.
6. **§5 called `entry_quality` "populated by nothing".** It is populated, from
   `confluence_count`, with a test. The rows are `unknown` because the trades were
   adopted rather than dispatched — a different and larger finding, now stated there.

### The pattern behind 4, 5 and 6

All three failed the same way, and the shape is worth naming because it will recur:
**I read a seven-day aggregate and described it as current behaviour.** A veto count
is a record of what happened across a window, not a statement about the system as it
stands; a null column is evidence about the rows that produced it, not about the code
that fills it. In each case the check that would have caught it was cheap and specific
— `lastAt` on the veto row, a grep for the writer, a look at the test file — and in
each case I reached the conclusion before running it.

Of the four defects this audit proposed for repair, **one was real** (§4's
approval→order leak, which led to the housekeeping outage in PR #668 and was the
largest finding of the day). Two dissolved on inspection. One (§3c) was already
diagnosed by the system itself. That ratio is the honest measure of this document's
first draft, and it is recorded here rather than quietly edited away.

---

*No live action was taken in the production of this document. No order was placed,
amended, cancelled or closed. No credential, account mode, risk limit or environment
variable was changed. The two findings that call for a change to a risk limit — §1 and
§2 — are reported for the owner's decision and were not acted on.*
