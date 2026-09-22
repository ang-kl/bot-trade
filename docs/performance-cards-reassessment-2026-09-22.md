# Performance cards — re-assessment, storage/volume impact, and proposed changes

**Status: PLAN ONLY. Nothing built. Every step below awaits the owner's word.**

Written 22-09-2026 after the owner reported that four cards on
`/performance` do not reflect real data, on "all accounts" and on individual
accounts, and suspected that nothing is logged per minute to build a decent
result from.

Cards in question:

- "Showing all accounts" (the account-scope header and its figures)
- "Rolling 24 hours"
- "Today by market session"
- "Timeframe ledger"

---

## 1. The finding: they are starved of trades, not of samples

**The suspicion that the cards are empty is correct. The mechanism is not
per-minute logging, and that changes what the fix is.**

All four cards are built from **closed trades**. `src/pages/Performance.jsx:1288`
derives the whole Rolling-24h card from `scopedClosed`, filtered into 24
one-hour buckets by `rollingWindow(hourNow, 24)`; the session card and the
timeframe ledger use the same closed-trade list over different windows. There
is no per-minute series behind them. **Adding one would not fill these cards.**

Measured on production, `/state/trades` (630 rows returned):

| window | closed trades |
|---|---|
| last 24 h | **2** (both on …0058) |
| last 48 h | 2 |
| last 7 d | 29 |
| last 30 d | 77 |

Two closes across 24 hourly buckets means **22 of 24 rows are empty**. The
session card splits the same two trades across sessions. The ledger computes
carry-in/carry-out over noise. **The cards are working correctly and faithfully
reporting almost nothing.**

### And the rate is falling to zero by design

The 7-day strategy mix is `rsi2_reversion` 7, `vp_value` 6,
`donchian_breakout` 4, `rsi_meanrev` 3, `fvg_retrace` 2, `va_breakout` 2 —
every one a **retired intraday strategy**, winding down positions opened before
the 20-09 retirement. Only **one** `tsmom_long` close in seven days.

Going forward:

- the intraday producers are retired (`agent/lib/entry-producers.js:35`, `:58`)
- every intraday strategy is `_off` (`agent/config/strategy-pins.json`)
- the momentum book — the one armed family — supplies no TP1
  (`agent/services/momentum-book.js:318-325`, whose own synthesis string reads
  *"Entry remains blocked until an approved TP1 is supplied"*) and is therefore
  refused at `agent/lib/exec-engine.js:597` (`guard_no_target`). This is
  currently masked only by …0058 sitting at its 8-position cap, so no entry is
  attempted and the guard is never reached — confirmed by **zero**
  `guard_no_target` rows across 7 days, 445 distinct reasons, 17,760 refusals.

**These cards are about to have nothing at all to show. That is the finding; it
is not a display bug.**

---

## 2. Why individual-account selection is also wrong — a confirmed cause

Separate from the starvation, there is a real per-account scoping defect.

`GET /state/risk-full?account=X` takes `brokerBalance` from the **global**
`broker_snapshot_cache_json` (`agent/routes/state.js:3788`) while the resolved
account `acct` is in scope at `:3781`. Every account therefore reads the same
broker balance.

The correctly-scoped key **already exists and is already written for every
account** — `acct:<id>:broker_snapshot_cache_json` at
`agent/routes/actions.js:4525`, read correctly at `state.js:558` and `:3728`.
PR #993 built it and did not point this read at it.

This is the same defect class as the perf-card balance bleed fixed earlier, and
it is logged as **F-OBS-01 / NOT EXECUTED** in
`docs/plan-execution-audit-2026-09-11.md:32`, `:748`.

**Two sibling reads of the same global blob sit inside risk vetoes**, where the
consequence is trading, not display:

- `agent/services/risk.js:1782` — the `marginLevelFloorPct` veto inside
  `evaluateTrade`, whose message claims *"no new entries while **the account**
  is this close to stop-out"* while reading a possibly different account's
  margin level. It fails open, which makes it quieter, not safer.
- `agent/services/vpo-feeder.js:67` — the same floor, same global blob, in the
  VPO fire path, with no account scoping at all.

---

## 3. Storage and volume — measured, not assumed

### Current write rate (two samples 120 s apart, 22-09 00:39–00:41 UTC)

| side | events | rate | bytes | projected |
|---|---|---|---|---|
| cpp_exec (live) | +5,672 | **47.27 ev/s** | +226,880 | **163.4 MB/day** |
| cpp_exec_demo | +5,524 | **46.03 ev/s** | +220,920 | **159.1 MB/day** |
| both | | | | **322.4 MB/day** |

**This is an instantaneous rate during an active window** (FX and crypto open),
**not a 24-hour average.** The only 24-hour measurement this repo holds is
12.353 ev/s → **42.7 MB/day** for 53 symbols on one side. The truth over a full
day lies between the two; plan against the higher one.

Records are a fixed 40 bytes (`queue.recordBytes: 40`); `bytesWritten` is
exactly `events × 40`, so the two figures cannot drift.

### Disk — there is no pressure, and no volume is needed

| side | total | available | usage | reserve (20%) | warn / stop |
|---|---|---|---|---|---|
| cpp_exec | 2,363.88 GiB | **839.89 GiB** | 64% | 472.78 GiB | 70% / 85% |
| cpp_exec_demo | 45.53 GiB | **44.68 GiB** | 1% | 9.11 GiB | 70% / 85% |

`disk_reserve_clear` requires available > reserve. **It clears on both sides
with a wide margin** (840 vs 473 GiB live; 44.7 vs 9.1 GiB demo).

**This corrects a prediction in the §1 runbook**
(`docs/tick-momentum/option-2-observation-rollout.md`). That document expected
`PAUSED_RESERVE` as the likeliest steady state on the assumption of a small
container filesystem, and said a volume *may* be needed before arming because
the reserve must clear. Measured: the live host carries a 2.3 TiB disk, the
reserve clears, and the recorder reports `RECORDING`. **No volume is needed for
shadow, and none is needed for arming either** on the disk currently attached.
The runbook's conditional should be updated to the measurement.

The live side's 64% usage is the **host** filesystem, not this service's data.
The recorder self-caps at a compiled-in **2 GiB spool** per side
(`spoolCapBytes: 2147483648`), so its own footprint cannot grow beyond that
regardless of rate.

### Retention

At the 2 GiB cap: **≈ 13 days per side** at the measured active rate
(163 MB/day), **≈ 50 days** at the 24-hour average (42.7 MB/day). Older
segments are retired, not accumulated.

`agent/config/.../storage-capacity.csv` (0.83 / 3.3 / 16.6 GB/day) is a
**scenario table** — every row stamped `SCENARIO_NOT_MEASURED`, assuming 20
symbols at 5/20/100 events/s. It is 5–100× above what this recorder actually
writes and should not be planned against.

### A reporting defect found while measuring (small, real)

At 00:19–00:21 UTC both sidecars reported `state: RECORDING` with
`generation: 0`, `perSymbol: []`, `events.total: 0`, `bytesWritten: 0` and
`disk: {totalBytes: 0, usagePct: -1}`. By 00:39 they read `generation: 1`,
53 symbols, ~24.9k events and a readable disk.

**That was a post-restart window, not a regression** — the configure lands
shortly after boot. But during it, `/state/tick-recorder` and
`/state/tick-readiness` both reported `RECORDING` for a recorder with **no
symbols attached and nothing being written**, and the disk read that feeds the
`disk_reserve_clear` PAUSE_CHECK returned `-1`. A recorder with zero symbols is
not recording, and a failed disk read should not present as a percentage.

**The storage impact on the Performance cards themselves is negligible** either
way: they read closed trades, of which there are 77 in 30 days.

---

## 4. Trading impact in the next 24 hours

**Every proposal in §5 is observability-only: no risk limit, no arming, no
order path, no broker call. Trading impact is exactly zero.**

What *would* change trading in the next 24 hours, and neither is in this plan:

1. Unblocking the momentum book — a TP1 policy that does not cap a
   weeks-horizon position at 1.5R. This is the same tension §4-P addressed and
   is an owner decision.
2. Re-arming any intraday strategy.

Until one of those happens, the expected 24-hour close count is **0–2**, and no
change to this page can make the cards fuller without lying.

---

## 5. Proposed changes

### P1 — Say "too few to judge"; never draw an empty grid

An empty 24-row grid reads as *measured, and flat*. The truthful reading is
*not enough events to say anything*. Owner principle 6 ("the website shows no
fake result") applies to emptiness as much as to invented values.

Each of the four cards gets an explicit **insufficient-evidence state** naming
the count and the window — "2 closed trades in the last 24 h — too few to
rank" — instead of a grid of dashes. The threshold is shown in the card, not
buried in code.

Files: `src/pages/Performance.jsx` (four card bodies) plus one shared helper.

### P2 — Fix the per-account scoping (display AND the two risk vetoes)

Point `state.js:3788`, `risk.js:1782` and `vpo-feeder.js:67` at
`acct:<id>:broker_snapshot_cache_json`. Where the per-account snapshot is
absent, **say so** rather than falling back to whichever account happened to be
selected — `state.js:3726-3733` already shows the correct pattern, re-checking
`snapshot.account.accountId === accountId` on the way out.

`risk.js` and `vpo-feeder.js` are a trading-correctness fix and should ride the
same PR as the display fix, since they share the root cause.

### P3 — Change what the page measures, not only how it draws

At 0–2 closes/day a P&L page cannot be informative however it is styled. The
system is producing plenty of evidence — **17,760 refusals across 445 distinct
reasons in 7 days** — it is simply not producing trades.

Add, beside the existing cards, a **"why nothing traded"** panel driven by
`/state/refusal-cost` and the pipeline verdict already on `/health`
(`topBlock: stage_matrix:strategy`; 65 of 73 decisions stopped upstream). This
uses data that already exists and needs no new logging.

Default the timeframe ledger to 7 d or 30 d, keeping 24 h as a sub-view, so the
default view is one that can contain something.

### P4 — Two small honesty fixes in the recorder's reporting

- Report `perSymbol: 0` as a **blocker** in `/state/tick-readiness` rather than
  letting `state: RECORDING` stand unqualified.
- Surface a failed disk read as "not read" instead of `usagePct: -1` flowing
  into the `disk_reserve_clear` PAUSE_CHECK.

### P5 — Correct the §1 runbook against the measurement

`docs/tick-momentum/option-2-observation-rollout.md` predicts `PAUSED_RESERVE`
and a possible volume requirement before arming. Measured reality: 2.3 TiB
disk, reserve clears, `RECORDING`, no volume needed. Update the document to the
measured outcome, and replace the scenario-table capacity note with the
measured 42.7–163 MB/day range and 13–50 day retention.

---

## 6. Verification

- **P1 / P3** — `npx vitest run`; seed a fixture with 2 closes and assert the
  insufficient-evidence copy renders and the empty grid does not.
- **P2** — `node --test`; mutation: point the read back at the global key and
  confirm a **named** test goes red. On production, verify two accounts return
  different `brokerBalance` from `/state/risk-full`.
- **P4** — mutation: force `perSymbol: 0` and confirm readiness reports blocked.
- **P5** — documentation only; no code.
- Full gate before any merge: `node --test` (agent), `npx eslint .`,
  `npx vitest run`, `npm run build`, `npm run check:no-green`.

Every mutation is counted `grep -cF` **present → absent** before running, and
restored afterwards. A mutation that was never applied proves nothing.

---

## 7. Suggested order

1. **P2** — a risk veto reading another account's margin level is the only item
   here with a trading consequence.
2. **P1** — stops the page implying "measured and flat" when it means "nothing
   happened".
3. **P4**, **P5** — small, cheap, both close gaps between a claim and a reading.
4. **P3** — the largest change, and the one that makes the page useful while the
   trade rate stays near zero.

**None of this addresses the underlying cause.** The cards are empty because
the system is barely trading, and the system is barely trading because the
intraday paths are retired and the momentum book is blocked on a mandatory TP1.
That decision is the owner's, and it is the only change that would make these
cards worth looking at.
