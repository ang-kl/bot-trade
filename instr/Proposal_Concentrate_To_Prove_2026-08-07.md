# Proposal — concentrate to prove, then scale

Owner, 2026-08-07: *"step back think first, what are the outstanding
work-to-be-done… we don't have enough trades per day, how do we change… if we
are to pivot to this goal what needs to stop."*

Written 2026-08-07 01:20 UTC at `f3ceb3b`. **Proposal. Nothing here is
implemented; the freeze in §3 begins only if you say so.**

---

## 1. The fact everything else follows from

**The go-live gate is dated 2026-08-12** (`goal-tracker.js:79`). That is five
days away.

**Phase 7's exit replay — the only instrument that can say whether the exit
policy helps or hurts — cannot produce data until ~2026-08-13**, because it
needs seven days of clean-origin rows and those began accumulating when #673
merged on 06-08.

> **The evidence arrives the day after the decision.**

So 12-08 is not a date on which the edge will be proven or disproven. It is a
date on which you will choose to go live **without** proof, or move the date.
I recommend moving it to **2026-08-20**, for reasons that are arithmetic rather
than caution — see §4.

---

## 2. Why there aren't enough trades — the arithmetic, not a theory

The arming bar (`edge-bars.js`, `ARM_BAR`) requires **25 trades per
strategy × symbol × timeframe combo**. Count what the trade flow is currently
divided across:

**12 strategies × 5 accounts × ~1,900 symbols × several timeframes.**

That is tens of thousands of buckets. Even a healthy trade rate, spread that
thin, never fills a single one to 25. The result is exactly what the audits
keep reporting: twelve strategies, all `EDGE UNPROVEN` — **not failing,
unmeasured**.

**The insight worth acting on: you do not need more trades to prove an edge.
You need the trades you already get to land in fewer buckets.**

| | Now | Proposed | Evidence per bucket |
|---|---|---|---|
| Accounts | 5 | **1** | ×5 |
| Strategies | 12 (10 default-on) | **3** | ×4 |
| Symbols | ~1,900 available | **20** | large |
| Timeframes | several | **1 per strategy** | ×2–3 |

Same trade flow, roughly **20–30× faster accumulation per combo**. That is the
whole proposal.

---

## 3. What to STOP — the list, plainly

Asked for directly, so answered directly.

**Stop building instruments.** The exit replay, veto breakdown, disposition
tracker, decision log, perf ledger, position events, cockpit snapshot, shadow
trim — **every one is either unrun or unread**. The tenth will not help.

**Stop running audits.** Three in the last week. All three concluded *the
evidence is not reachable*. A fourth concludes it again.

**Stop adding strategies.** Twelve unproven is strictly worse than three
unproven: four times the dilution, zero extra information.

**Stop chasing the 1,900-symbol universe.** Breadth is the direct enemy of
per-combo sample.

**Stop tightening defences by reflex.** ~147 of ~690 commits since 01-07 added
or tightened a restraint. The two that mattered most this week —
`unknown_daily_pnl` and the USD 16.16 cap — were **defences that had become
malfunctions**. That is the tell.

**Stop trusting the merge gate.** GitHub Actions has run nothing on this repo
since 2026-08-06 14:07Z, across #681–#685. Every merge since has been by hand,
several within two minutes. That is not review. **Fixing CI is worth more than
any feature on the backlog**, because it is the only thing standing between a
bad change and production.

**And a change in my own behaviour, since I have been part of the pattern.**
Five PRs from me on 07-08, three of them documents or shadow instruments. Under
this proposal I stop shipping features and only measure.

---

## 4. The proposal — one account, three strategies, twenty symbols, seven days

### 4.1 One account

**A demo account with a working balance** — not live `42993489`, which holds
USD 33.45 and cannot produce a meaningful sample at any position size.

Five accounts running the same unproven strategies is not diversification. It
is one experiment run five times with the results filed separately.

The others: `enabled = 0` in the registry. Not deleted, not disarmed
piecemeal — off, so nothing writes rows that dilute the read.

### 4.2 Three strategies

Chosen on evidence and on **frequency**, and deliberately spanning different
edge families so they cannot all fail in one regime:

| Strategy | Why | minBars | Family |
|---|---|---|---|
| `donchian_breakout` | one of only two with a **harness + repo** positive control | 40 | trend |
| `rsi2_reversion` | the other **harness + repo** control; has its own seed bar | 104 | mean-reversion |
| `vwap_trend` | **lowest minBars of any strategy (30)** — the highest-frequency signal source, and frequency is the scarce resource | 30 | intraday |

The other nine: off. `cup_handle` / `inv_cup_handle` (minBars 210) and
`ema_pullback` (450) are excluded specifically **because** they are
low-frequency — good strategies possibly, but they cannot reach 25 trades in a
week and so cannot contribute to the decision this experiment exists to make.

### 4.3 Twenty symbols

Liquid, tight-spread, and as close to 24-hour as possible, so session windows
do not throttle the sample:

```
EURUSD GBPUSD USDJPY AUDUSD USDCAD USDCHF NZDUSD EURJPY GBPJPY EURGBP
XAUUSD XAGUSD US500 NAS100 GER40 UK100 US30 JPN225 USOIL BTCUSD
```

**Deliberately no Hong Kong or US single-name equities.** They are
session-limited, they carry the duplicate-cluster history (nine `0066.HK`, six
`0005.HK`, four `GD.US`), and cleaning up after them has consumed more owner
attention than any other single thing this month.

### 4.4 Seven days untouched

**No new features. No new gates. No threshold tuning. No strategy changes.**

A tuned experiment measures the tuning, not the edge. If something is
obviously broken it gets fixed and the clock restarts — but "obviously broken"
means the loop stopped, not that a number looks disappointing.

---

## 5. The goals — dated and measurable

| # | Goal | Measure | By |
|---|---|---|---|
| **G1** | The desk actually trades | approval rate on a **one-day** window ≥ 20% | 08-08 |
| **G2** | One combo reaches decidability | ≥ 25 closed trades on any strategy×symbol | 14-08 |
| **G3** | The exit policy is measured, not assumed | Phase 7 replay run with a real sample | 14-08 |
| **G4** | One strategy has a measured expectancy | PF with a bootstrap interval, net of observed cost | 16-08 |
| **G5** | Go/no-go on evidence | PF ≥ 1.68 on ≥ 25 out-of-sample trades, or an honest NO | **20-08** |

**G1 is the leading indicator.** If it fails, nothing downstream can happen and
the cause is a gate, not a strategy — measurable the next morning.

**G5 replaces 12-08.** Same bar, eight days later, with evidence instead of
hope behind it.

**What success is NOT:** more features shipped, more audits written, more
strategies armed, a greener dashboard.

---

## 6. What I will do while you are not watching

Stated as commitments, so the absence of any of them is a failure you can point
at.

### I WILL

1. **Measure, and report only what I measured.** Windows labelled on every
   figure. No multi-day aggregate restated as current behaviour — the error
   that has bitten this work five times.
2. **Read the two blocked reads the moment access allows** —
   `GET /state/dispositions?days=7` and a **one-day** `/state/veto-breakdown`.
   Both are currently denied by this environment's permission classifier, and
   I will keep saying so rather than quietly substituting older numbers.
3. **Run Phase 7's replay on or after 13-08** and report whatever it says,
   including a result that contradicts the case for early trimming.
4. **Report the daily numbers against G1–G5**, including when they are bad,
   and say plainly when a goal has slipped rather than re-describing it.
5. **Fix outright breakage** — the loop stopped, a route 500s, CI stays dead —
   and say so.

### I WILL NOT

6. **Ship features during the freeze.** This is the commitment that matters,
   because it is the one I have been breaking. No new instruments, no new
   panels, no new strategies, no "small improvements".
7. **Change any risk limit, threshold or strategy arming** without you saying
   so in that message. Not `minRR`, not the cooldowns, not the daily cap, not
   the new floor.
8. **Touch live account `42993489`** in any way.
9. **Run `sweepUnresolvable --dryRun false` or `exec-parity.js --order`.**
10. **Merge anything that changes behaviour** without CI green **and** your
    word. Documents and read-only analysis may auto-merge on a green gate;
    nothing that moves money may.
11. **Present an inference as a measurement.** If the replay has not run, the
    answer is that it has not run.

---

## 7. Outstanding work, honestly sorted

**Blocked on you, and blocking everything else:**

- Accept or reject this concentration plan. Until then the dilution continues.
- **Fix GitHub Actions.** Nothing has run since 06-08 14:07Z.
- Grant the read for `/state/dispositions`, or run it and paste the JSON.
- `minRR` effective 4.5–6.16 against a configured 1.5 — **the single biggest
  entry unlock, and it is drift to correct rather than a limit to loosen.**
- Clear `symbolCooldownMinutes` = 5 (default is now 60).
- Trim the `0005.HK` and `GD.US` clusters — needs a full-tier credential.

**Waiting on time, nobody's action:**

- Phase 7 replay, ~13-08.
- The early-trim shadow record (#685), which writes nothing until
  `early_trim_json` → `{"enabled": true}`.

**Deliberately parked under this proposal:**

- Risk-page simplification (the four changes in `Proposal_Risk_Page_…`).
- T3, add-on-trend — needs the duplicate-detector question settled first.
- The Agent-Graph audit's AG-05: thirteen stop authorities, no arbiter. Real,
  and **not urgent enough to break the freeze for**.

---

## 8. The honest summary

The codebase is good. Test coverage is real, the modules refuse rather than
guess, and the commit history records why. **Quality is not the constraint.**

What has been missing is not capability but **concentration**. Twelve
strategies, five accounts and 1,900 symbols is a configuration that cannot
produce a decidable answer no matter how well each part is built — and every
audit that says "the evidence is not reachable" is measuring that, not a
shortage of engineering.

**Three strategies, one account, twenty symbols, seven quiet days.** That is
the fastest path to a proven edge, and it is fastest precisely because it stops
building.
