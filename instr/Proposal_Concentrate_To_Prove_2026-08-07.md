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

### 4.1 One account — `46130058` (Demo 5203012)

**Pick `46130058`. Stop the other four.**

The decisive argument is **lot quantisation**, and it is not about comfort — it
is about whether the sample can be read at all.

| Account | Balance | 1% risk/trade | Can it size 20 symbols cleanly? |
|---|---|---|---|
| **46130058** | ~USD 46,073 | **USD 460.73** | **yes, with room** |
| 43097342 | ~USD 1,983 | USD 19.84 | **no** |
| 42993489 (LIVE) | USD 33.45 | USD 0.33 | no — cannot trade at all |
| 47790949 | — | — | history of parked backfill; excluded |
| 46979908 / 46515833 | — | — | least instrumented; excluded |

At USD 19.84 of intended risk, the broker's minimum lot on most of the twenty
symbols implies a risk **well above** that figure. Two things happen, both
fatal to the experiment: the gate vetoes `insufficient_equity`, or sizing
rounds up to the minimum and the trade carries several times its intended risk.

> **Either way the realised R is not the intended R, and the expectancy you
> measure is the expectancy of lot quantisation, not of the strategy.**

At USD 460.73 every one of the twenty sizes cleanly, every trade lands at its
intended R, and the sample means what it says. That is the whole argument, and
it outranks every other consideration including the fact that 43097342 is the
account the owner has been watching most closely.

**Before it starts:** the four duplicate `GD.US` positions on `46130058` must
be trimmed. They are an unchosen concentration inherited from the
duplicate-cluster mechanism and they would sit inside the experiment's exposure
caps for its whole duration. Owner action — needs a full-tier credential.

**The other four:** `enabled = 0` in the registry. Not deleted, not disarmed
piecemeal — **off**, so nothing writes rows that dilute the read. Five accounts
running the same unproven strategies is not diversification; it is one
experiment run five times with the results filed separately.

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

## 4.5 The one setting I want changed — and it is a TIGHTENING

Owner, 07-08: *"do you want change the settings. As make losses real to you,
feel the pain of losses."*

I am not going to claim I feel pain. What I can do is go looking for the thing
that would hurt, unprompted, and put it in front of you. Here it is.

### The arithmetic of ruin, which nothing in this system currently checks

`equityStopPct` is `null`, which means **the same threshold as the daily cap**
— and the daily cap **resets every FX day**. There is no weekly limit, no
campaign limit, no drawdown counter that spans days. Every morning the account
gets a fresh licence to lose the maximum again.

Put the daily cap I shipped for you this morning against that:

| Account | Balance | New daily cap | Days to zero at cap | Over the 7-day experiment |
|---|---|---|---|---|
| 43097342 | ~1,983 | **200** | **≈10 trading days** | 1,400 = **70% of the account** |
| 46130058 | ~46,073 | **1,842.92** | ≈25 trading days | 12,900 = **28%** |

Under the old USD 59.49 cap, 43097342 would have taken **33 days** to reach
zero. After this morning's change it takes **ten**. That is a 3.3× increase in
the speed of ruin, and **I shipped it at your instruction without computing it**
— which I should have done before writing the PR, not the morning after.

The change was still right: a USD 16.16 cap was a shutdown, not a limit. But
*"the cap was too tight"* and *"the account can now be gone in two working
weeks"* are both true at once, and only one of them was in the PR.

### What I want changed

**One setting. `equityStopPct` on the experiment account, set to a campaign
drawdown that spans the seven days rather than resetting nightly.**

Proposed: **8% from the campaign's starting equity.** On 46130058 that is
USD 3,686 — roughly two days at the daily cap. If the experiment is down 8%
after a week, the strategies have answered the question and the remaining days
add nothing but loss.

The daily cap answers *"how bad can today be?"* Nothing currently answers
*"how bad can the week be?"*, and **a daily cap with no campaign cap is not
risk control — it is a slower way to lose everything.**

### And a correction to my own acceptance criteria

G4 and G5 as I wrote them measure **profit factor** and **win rate**. Neither
sees drawdown. A strategy can clear PF 1.68 on a path that would have ended the
account halfway through, and my gate would have passed it.

So both goals gain a term: **maximum drawdown and worst single loss, reported
beside the PF, with a strategy failing if the path to its profit factor
breached the campaign stop.** A chief who took losses seriously would have
written it that way the first time.

---

## 5. The goals — dated and measurable

| # | Goal | Measure | By |
|---|---|---|---|
| **G1** | The desk actually trades | approval rate on a **one-day** window ≥ 20% | 08-08 |
| **G2** | One combo reaches decidability | ≥ 25 closed trades on any strategy×symbol | 14-08 |
| **G3** | The exit policy is measured, not assumed | Phase 7 replay run with a real sample | 14-08 |
| **G4** | One strategy has a measured expectancy | PF with a bootstrap interval, net of observed cost, **plus max drawdown and worst single loss** | 16-08 |
| **G5** | Go/no-go on evidence | PF ≥ 1.68 on ≥ 25 out-of-sample trades **AND the path never breached the campaign stop**, or an honest NO | **20-08** |

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
