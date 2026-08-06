# Result — Bot-Trade Agent-Graph Engineering Audit

Prompt: `instr/Bot-Trade_Agent-Graph_Engineering_Audit_Prompt.md`
Executed: 2026-08-06 20:20–20:50 UTC (2026-08-07 04:20–04:50 SGT), market closed.

| | |
|---|---|
| Frozen SHA | `cf2dbf9e01e3ede657a8d3c0b1c6d0d0f1849784` (`main` = `origin/main`) |
| Evidence tier | **source trace only** — see "The two limits" below |
| Live trading actions | **none**. Live account `42993489` untouched |
| Credential tier | read-only |

---

## The two limits on this audit, stated before any finding

**1. The graph was not a graph.** The prompt's §2–§3 specify a producer /
worker / independent-reviewer topology, and §3.2 makes reviewer independence a
structural requirement — a worker must not review its own package. This audit
was executed by a single agent applying the roles in sequence. The roles were
followed; **the independence was not achieved**, because a sequential
application of roles by one agent is not the same property. Every finding below
should be read as unreviewed by an independent station.

**2. No runtime evidence was obtainable.** Every attempt to read production
(`sg-trade.up.railway.app`, read-tier credential, `GET /state/*`) was denied by
this environment's permission classifier — three call shapes, all blocked. §3.5
requires evidence before remediation and the worker contract has a
`Runtime evidence` field; for every workstream below that field reads
`BLOCKED`.

The consequence is specific and worth being blunt about: **the audit's central
question cannot be answered quantitatively at all.** Whether the system is
under- or over-defended is a question about how often defences fire and what
they cost, and firing rates live in production. What follows is a structural
audit — how many defences exist, where they overlap, which can contradict each
other — plus a precisely stated list of the measurements that would settle it.

---

## Executive answer

> Is `bot-trade` under-defended, proportionately defended, over-defended, or
> mixed by subsystem?

# `MIXED BY SUBSYSTEM — WITH A STRUCTURAL BIAS TOWARD OVER-DEFENCE ON ENTRY AND UNDER-DETERMINATION ON EXIT`

Stated as structure, not as a measured rate:

- **Entry is defended by 27 distinct veto sites in one file.** `risk.js`
  contains 27 `return veto(...)` call sites. That is not a criticism by itself
  — each was added for a reason — but 27 independent refusal conditions on one
  decision is a structure in which the *marginal* effect of any one of them is
  invisible without runtime counters.
- **Exit is governed by thirteen modules that can each touch a stop**, with no
  single arbiter. This is the more serious structural finding and it is
  detailed under WS-05.
- **The exit policy's own coherence is unmeasured**, by design and by
  admission: Phase 7 of the repair programme built the instrument and did not
  run it, because the clean-origin sample does not yet exist.

---

## WS-01 — Entry veto funnel

**Runtime evidence: BLOCKED.** The funnel's stage-by-stage counts, the first
veto, gross vs unique vs overlapping veto counts, and blocked-opportunity
outcomes all require `/state/veto-breakdown` and `/state/dispositions`.

**Source trace.** `agent/services/risk.js` — 27 `return veto(...)` sites. Named
where the reason string is a literal:

| Line | Veto |
|---|---|
| 748 | global guards (portfolio halt / daily-loss cap / total position cap) |
| 781 | `balance_not_account_scoped` |
| 800 | `news_window` |
| 814 | `negative_carry` |
| 828 | `commission_drag` |
| 848, 866 | `slippage_drift` |
| 934 | daily-loss limit |
| 962 | `unknown_daily_pnl` |
| 991 | `loss_streak_cooldown` |
| 1009 | `max_positions` |
| 1132 | `symbol_blocked` |
| 1137, 1142 | `missing_entry_or_sl` |
| 1147 | `sl_at_entry` |
| 1161 | `bad_rr` |
| 1170 | `sl_too_tight` |
| 1178 | `overexposed_*` |
| 1198, 1205 | `correlated_*` |
| 1265 | `negative_expectancy` |

Plus a per-symbol cooldown whose semantics were changed today (#676, #679).

**Finding AG-01 — the funnel has no ordering rationale recorded.** Vetoes fire
in source order, so the *first* veto a proposal meets is an artefact of where a
guard was inserted, not of which condition is most informative. `/state/veto-breakdown`
reports first-veto counts; attributing meaning to that distribution is
therefore attributing meaning to edit history. Severity: low as a defect,
material as a measurement hazard — a "top veto" chart built on it will mislead.
Minimum safe remedy: none in code; record all applicable vetoes rather than the
first, which the gate already has the data to do.

**A number this audit will NOT restate as current behaviour.** A previously
measured 7-day window (to 2026-08-05) showed 793 approvals against 46,380
vetoes — 1.7%. That was a **multi-day aggregate over a window that includes the
period before #670/#671/#674 shipped**, and three of those PRs change what is
recorded. It is not evidence about today and is cited here only to be
quarantined.

---

## WS-02 — Defensive PR accumulation

**Source trace.** 646 commits since 2026-07-01; **147** carry a defensive
keyword (`veto|guard|cap|cooldown|halt|block|limit|protect|trail|keeper|breaker|disarm|dedup|duplicate|risk`).
Roughly 23% of a month's commits added or tightened a restraint.

**Finding AG-02 — cumulative effect has never been measured, only local
correctness.** Each defensive PR carries its own before/after test. No PR in
the sample measures the *joint* effect of the restraint it adds against the
restraints already present. This is precisely the accumulation the prompt asks
about, and it is unaudited. Runtime evidence: **BLOCKED**.

Minimum safe remedy: none — this is a measurement gap, not a defect. The
instrument that would close it is the counterfactual replay (WS-10 / repair
Phase 7), already built.

---

## WS-03 — C++ execution authority

**Source trace.** Order placement, amendment, close and cancellation exist on
**two** paths: the C++ sidecar (`cpp-exec/src/engine.cpp`, `main.cpp`,
`vpo_dispatcher.cpp`) and the Node fallback (`agent/services/pending-orders.js`,
`closed-market-limits.js`, `vpo-feeder.js`). The exec guard travels with the
credentials (`ctrader-creds.js:26-31`) so both paths see the halt switch and
volume cap — a genuinely good property, and the fix that made it so is
recorded in-file.

**Finding AG-03 — authority is dual, and which path acts is a runtime
condition.** Nothing in source declares one path authoritative; the Node path
is a fallback whose activation depends on sidecar availability. Durable
recording exists on both. Whether the two ever act on the same intent is a
runtime question. Runtime evidence: **BLOCKED**.

---

## WS-04 — C++ TrailEngine

**Source trace.** `cpp-exec/src/trail_engine.cpp` (200 lines) and its header.
The division of authority is explicit in the file's own header comment: *"NODE
decides POLICY"* — the profit keeper computes armed state, ATR and trail
distance; C++ advances the peak on each SpotFeed tick and amends the broker-side
stop when the Chandelier target improves it by at least a minimum step. A
worker thread drains pending amends every ~200 ms.

The ratchet property is stated and enforced structurally: positions already
tracked keep the **local** peak and last stop when those are further along, so
*"the worse writer's amend is a no-op"*. That is the correct design for two
writers on one stop.

**Finding AG-04 — the ratchet is correct in the engine and unproven end to
end.** The chain from Node policy through C++ status back to broker
reconciliation has no source-level break. Whether `amendsOk_` /`amendsFailed_`
diverge in production, and whether Node's readback matches the broker's stop,
requires `/trail-status` and a broker read. Runtime evidence: **BLOCKED**.

---

## WS-05 — Stop-loss authorities

**This is the audit's principal structural finding.**

**Source trace.** Thirteen modules reference and can act on a stop:

```
agent/services/cockpit-intention.js      agent/services/reconciler.js
agent/services/loss-guardian.js          agent/services/restrategize.js
agent/services/loss-postmortem.js        agent/services/telegram.js
agent/services/manual-position-guards.js agent/services/tp-suggest.js
agent/services/naked-position-guard.js   agent/services/trade-guard.js
agent/services/position-protect.js       agent/services/vol-adjust.js
agent/services/profit-keeper.js
```

plus `agent/loop.js`, `agent/db.js`, and on the C++ side
`order_guard.cpp` and `trail_engine.cpp`.

**Finding AG-05 — there are at least thirteen stop-loss authorities and no
declared arbiter.** Some are read-only consumers; the audit cannot separate
readers from writers from source alone without tracing each, and doing so
honestly requires the runtime evidence that is blocked. What *is* established:
no module declares itself authoritative, and no module declares an ordering
against the others. The ratchet invariant in `trail_engine.cpp` protects
against one specific two-writer race (C++ vs Node). It does not generalise to
the other eleven.

Severity: **high as a design property, unquantified as a defect.** A stop that
several components may rewrite is exactly the shape in which "protected" can be
reported while the broker holds something different — which is WS-12's
question.

Minimum safe remedy: **do not write one.** The remedy is a measurement first —
enumerate which of the thirteen actually issue an amend in production, over a
window, then decide. Proposing an arbiter before that would be remediation
ahead of evidence, which §3.5 forbids.

---

## WS-06 — Profit Keeper

**Source trace.** `agent/services/profit-keeper.js` (525 lines). Two modes —
`adaptive` (ATR/balance units, default) and `fixed` (dollar thresholds). ATR
from a cache keyed `${symbolId}|${timeframe}`, 1h/period 14 by default.
Spike tightening is **on by default**: a bar whose range ≥ `spikeRangeAtrMult`
(2) × ATR pulls the trail in to `spikeTrailAtrMult` (1) × ATR across
`spikeBars` (3) recent bars, and — stated in the file — *"when the spike passes
the distance relaxes again but the stop never widens"*. Scale-out defaults to 0
(off).

**Finding AG-06 — spike tightening is the most plausible single cause of
winner truncation, and it is on by default.** A 2.5→1.0 ATR trail collapse
during exactly the bar that produced the largest favourable excursion is the
mechanism by which a runner becomes a small win. **This is a hypothesis, not a
measurement.** It is precisely what the Phase 7 replay's "no spike tightening"
arm exists to test. Runtime evidence: **BLOCKED**; counterfactual: **NOT RUN**.

---

## WS-07 — Time caps and forced exits

**Source trace.** Time caps are per-strategy and nullable:
`cup-handle.js:244` sets `time_cap_minutes: null` with the comment *"swing
trade — no time cap"*; `donchian-breakout.js:84` likewise null;
`ema-pullback.js` maps `timeCapBars` → `time_cap_minutes`; `burn-in.js:241`
sets `time_cap_minutes: plan.capMin`. Enforcement reads
`monitored_positions.time_cap_at`.

**Finding AG-07 — the cap is set per strategy, so "the 30-minute cap" is not a
global fact.** Any statement of the form "the system caps holds at 30 minutes"
is false as stated: some strategies opt out entirely. The Defensive-Drift
audit's observation that ~60% of postmortems classify `time_cap` is therefore
a statement about *which strategies traded in that window*, not about a global
policy. Runtime evidence for the current mix: **BLOCKED**.

---

## WS-08 — Goal coherence

**Source trace, and the healthiest subsystem in this audit.**
`agent/services/edge-bars.js` is a single register of all four numeric edge
bars, created in response to the 2026-08-03 Risk-Decision Audit finding #3:

| Bar | PF | Win rate | Min trades | Question |
|---|---|---|---|---|
| `BREAKER_BAR` | 0.8 | — | 15 (window 20) | is live performance bad enough to interrupt a human? |
| `SEED_BAR` | 1.5 | — | 20 | may `rsi2_reversion` auto-arm from its own backtest? |
| `ARM_BAR` | 1.7 | 60 | 25 | is this combo proven enough to put money behind? |
| `GO_LIVE_BAR` | 1.68 | 68 | — | may this system trade real money on 2026-08-12? |

`gateOn` is `'profitFactor'` — the owner's 2026-08-03 decision to stop
requiring an AND of both, on the reasoning (recorded in-file) that 68% wins
implies PF ≈ 4.0 at the observed payoff, so requiring both silently required
the far stricter of the two. `autoDisarm` is **false** by owner decision,
twice-confirmed: the breaker reports, the owner decides.

**Finding AG-08 — the ordering invariant is asserted with a slack that hides
the one inversion that exists.** `edgeBarSummary()` requires
`BREAKER < SEED < ARM ≤ GO_LIVE`, but implements the last step as
`hi.pf >= lo.pf - 0.05`. `ARM_BAR.profitFactor` (1.7) is **greater** than
`GO_LIVE_BAR.profitFactor` (1.68), so the true relation is `ARM > GO_LIVE` and
the summary reports `ordered: true`. The tolerance is deliberate and its
rationale is in-file (*"calling that a violation would cry wolf"*), which is
defensible. The residual hazard is that a reader of `ordered: true` concludes
the arming bar sits at or below the gate when it does not — the system will
decline to arm a combo at PF 1.69 that would clear the go-live gate.

Severity: low. Minimum safe remedy: report the signed gap alongside the
boolean, so the near-equality is visible rather than tolerated silently. **Not
a threshold change** — no bar value should move; that would be an owner policy
decision.

---

## WS-09 — Payoff and winner truncation

**Runtime evidence: BLOCKED. Counterfactual: NOT RUN.**

The prompt's six sub-questions (do tighter stops raise win rate but cut PF; is
break-even movement too early; does spike tightening remove runners; do partial
profits starve winners; do Node and C++ double-tighten; do strategy and
management timeframes conflict) are each answerable **only** by the replay.

What source establishes: Node/C++ double-tightening is structurally prevented
for the trail (WS-04's ratchet). Partial profits are off by default
(`scaleOutFrac: 0`). Spike tightening is on. The strategy/management timeframe
conflict is real in principle — WS-07 shows caps are per-strategy while the
profit keeper's ATR timeframe is a single global default of `1h`.

**No claim about truncation is made here.** Making one from source would be the
inference this programme has repeatedly been bitten by.

---

## WS-10 — Counterfactual replay

**Status: instrument built, NOT RUN.** `agent/services/exit-counterfactual.js`,
`agent/lib/exit-replay.js`, `agent/scripts/exit-counterfactual.mjs` (#680).

Run at this SHA against the repository's local `agent.db` — a development
database, **not production** — it returns `verdict: INSUFFICIENT`,
`considered: 0`, `eligible: 0`.

The prompt's twelve comparison arms map onto the harness's eight policies with
four gaps: *pre-safety-PR stack*, *graduated risk allocation*, *later profit
arming*, and *partial profit plus wider runner* have no arm. Recorded as a
coverage gap, not filled — adding arms to an unrun harness would be building on
an unvalidated instrument.

---

## WS-11 — Risk-budget utilisation

**Runtime evidence: BLOCKED.** Authorised vs deployed risk, idle capital, time
enabled but unable to trade, and unused daily risk are all runtime series.

**Source trace.** The measurement primitive now exists:
`agent/lib/sizing-balance.js:132` `riskBudgetMultiple(riskUsd, budgetUsd)` and
`:151` `overBudget(riskUsd, budgetUsd, tolerance = 1.10)`, shipped in #674, and
every risk verdict now records `balance_source` and
`balance_is_account_scoped`.

**Finding AG-11 — before 2026-08-06 this workstream was unanswerable in
principle**, because no verdict recorded which balance it sized against. It is
now answerable in principle and blocked in practice on read access. This is the
clearest "the instrument exists, point it at the thing" item in the audit.

---

## WS-12 — Observability and evidence quality

The prompt lists eight ways a system can report something untrue. Status of
each at this SHA:

| Can the system report… | Status |
|---|---|
| healthy while no useful work occurred | **fixed** — #677: a beating heartbeat is not a current answer |
| protected while no stop exists at the broker | **open** — thirteen stop authorities (AG-05), broker truth unread |
| all accounts while only one was checked | **fixed** — #671 read routes stop implying unchecked states; #668 `?account=all` |
| zero while values are missing | **fixed** — #671 |
| closed while the broker position remains open | **partially** — `closeTradeRow` convergence exists; residual duplicate clusters say reconciliation is not complete |
| strategy failure as no setup | **open** — no source-level distinction found |
| order failure as no trade | **open** — the `dropped` disposition exists precisely to catch this, and could not be read |
| C++ active while a required account is unauthorised | **fixed** — #666 side-aware roster, #662 `isLive` returned |

**Finding AG-12 — five of eight are closed, and the three that remain open are
the three that need production reads to verify.** That is not a coincidence:
the closable ones were closable from source.

---

## Findings summary

| ID | Workstream | Severity | Type | Status |
|---|---|---|---|---|
| AG-01 | WS-01 | low | measurement hazard | first-veto attribution reflects edit order |
| AG-02 | WS-02 | — | measurement gap | 147 defensive commits, joint effect never measured |
| AG-03 | WS-03 | low | design | dual order authority, runtime-selected |
| AG-04 | WS-04 | — | unproven | ratchet correct in engine, chain unverified |
| **AG-05** | **WS-05** | **high** | **design** | **≥13 stop authorities, no declared arbiter** |
| AG-06 | WS-06 | — | hypothesis | spike tightening on by default; truncation unmeasured |
| AG-07 | WS-07 | low | correctness of belief | time caps are per-strategy, not global |
| AG-08 | WS-08 | low | reporting | `ordered: true` conceals `ARM > GO_LIVE` |
| AG-11 | WS-11 | — | blocked | instrument now exists; needs read access |
| AG-12 | WS-12 | medium | open | 3 of 8 false-report modes unverifiable without reads |

No finding in this audit reaches implementation, because none of them clears
§3.5's five-part bar — every one is missing either the runtime evidence or the
independent review.

---

## Data requests

In priority order. Each is a read; none changes anything.

1. `GET /state/dispositions?days=7` — `housekeeping.lastResult.failed[]`,
   `counts`, `pendingNow`, and the `dropped` rows with causes. Settles WS-12's
   "order failure as no trade" and the eight silent approvals.
2. `GET /state/veto-breakdown?days=1` — a **one-day** window, deliberately, so
   the answer is about current behaviour rather than a multi-day aggregate
   spanning the PRs that changed the recording.
3. `GET /trail-status` + a broker position read — closes WS-04 and WS-12's
   "protected while no stop exists".
4. `node agent/scripts/exit-counterfactual.mjs --days 14`, not before
   ≈2026-08-13 — closes WS-06, WS-09, WS-10 together.
5. An enumeration, over one week of `position_events`, of which of the thirteen
   stop-touching modules actually issued an amend. Closes AG-05, the highest
   finding in this audit.

---

## Owner-policy decisions — untouched

- `minRR` effective 4.5–6.16 against a configured 1.5.
- `dailyLossPct` on 43097342 (USD 16.16 daily cap), parked 2026-08-05.
- Whether `autoDisarm` stays off. Recorded as owner-decided, twice; not
  reopened here.
- Any change to a bar in `edge-bars.js`. AG-08's remedy deliberately changes
  only what is *reported*, never a value.

---

## Boundaries observed

Audit-only. No code, config, broker state or live setting was changed. Live
account `42993489` untouched. `sweepUnresolvable` was never run with
`dryRun: false`; `exec-parity.js` was never run with `--order`. Read-tier
credential only. No production trading action of any kind.
