<!-- Assessment plan presented as № 9,029 (25-09-2026 11:24 SGT). Codex ran out of tokens at 11:40 SGT; Claude Code completes it — see docs/claude-takeover-2026-09-25.md. P0 now means REBUILD, not review: Codex's local work was never pushed. -->

# Tick + time-frame trading in parallel — measure first, then find an edge, then combine

## Context

The owner asked for trading that places tick-based and time-frame-based trades
at the same time ("in parallel to maximize profit"). Acceptance: tests show a
sustainable rise in both win factor and win ratio. The same morning they chose
"Plumbing + find a profile": finish the dual-entry plumbing, keeping tick
BLOCKED until a profile passes, AND search for a tick profile that can pass.

Read-only audit, 25-09 02:25–03:20 UTC (two workflows, 27 agents; origin/main
`83c94e6`, which is what production runs):

- **The plumbing exists but nobody uses it.** One account *can* take both
  bases (`admittedBases`, PR #978; `entry-mode.js:64-69`). All 7 accounts are
  TIME_BASED with bar only. The website can't set both
  (`EngineStatusPanel.jsx:83-85`). Every mode switch clears `admittedBases`
  (`entry-mode.js:229`).
- **Neither side is trading.**
  - No new entry intent since 18-09. 0 of 2,857 recent decisions reached the
    risk gate (`/health`, 03:03Z).
  - Time side: only the two momentum producers are left, both send
    `tp1: null` (`momentum-book.js:313`), and the only armed account (…0058) is
    at its cap.
  - Tick side: all 7 accounts fail the four evidence checks.
- **Nothing combines the two.** The one link is a trend filter that withholds
  counter-trend tick sides (`tick-permits.js:315-321`). It is dormant and has
  never been measured.
- **Neither stream has an edge.**
  - Tick shadow: demo profit factor 0.333, and still only 0.414 with
    commission and slippage removed. Live side 0.233.
  - Momentum: PF 0.44 in R over 34 closes.
  - Mixing lands in between the two. Momentum's win rate is 26.5%; adding
    the tick stream gives a combined 18.9%.
- **The tick test is not representative, and the research path can't give an
  answer.**
  - The shadow book skips live filters: the 0.15% stop floor, the price bound,
    the trend filter, pending-signal expiry, and the live trailing exit.
  - The profile is compiled in (`cpp-exec/src/main.cpp:239`).
  - The only replay run: 199 of 200 trials made no trades.
- **The acceptance test can't be measured today.** Trades carry no basis
  column. PF and WR are defined differently across readers. There is no
  per-basis or per-account history, no win-rate interval and no A/B harness.
- **Combined-risk gaps would open the moment an account takes both bases.**
  1. The position cap is checked per push, not per fire.
  2. A withdrawn permit stays usable for up to 5 minutes.
  3. Tick skips the book-wide symbol limit and the 1/N split.
  4. Readiness is checked only when tick is first added.
  5. The permit is used up before the firer's own checks.

Intended outcome: a system that can *prove or disprove* the objective honestly.
Each stream earns its place alone before the two run together. None of the
owner's thresholds change.

## Owner decisions that gate later phases (none block Phases 1–2)

| # | Decision | Gates | Recommendation |
|---|---|---|---|
| D1 | **DECIDED 25-09 (owner: yes):** "win factor" = profit factor, in R | P8 verdict | — |
| D2 | **DECIDED 25-09 (owner: yes, reports in intervals):** win rate is reported with its interval (Wilson), NOT a pass/fail bar; #960's `edge-bars.test.js` stays | P8 verdict | — |
| D3 | **DECIDED 25-09 (owner):** "sustainable" means the computation for trading is consistent and does not get confused over time, so testing is essential. Implemented as: one frozen, versioned metric definition stamped on every report; closed windows are fixed in advance and never recomputed differently later (append-only); deterministic fixture tests pin exact PF / WR / interval / lower-bound values; a regression test fails if a closed window's figures change | P1, P8 | — |
| D4 | Filters lift PF+WR but add vetoes. Principle 7 trade-off | P3, P6 | Accept filters that shadow-match live |
| D5 | Making shadow match live changes the population SHADOW_PASSED judges **[ASK-FIRST]** | P3 | Approve: judge what live would trade |
| D6 | Judge replay pooled across the carried symbols, as shadow is, instead of one symbol per trial. Threshold numbers unchanged **[ASK-FIRST]** | P4 | Pooled |
| D7 | Gateway redeploy for a runtime tick profile **[ASK-FIRST]** | P5 | Approve with P6 in the same release |

Standing, not re-asked:
- Thresholds in `tick-validation.json` stay.
- The position cap stays at 5 and the book at 8.
- TP1 stays mandatory. Codex's partial-TP work resolves momentum's
  `tp1: null`.
- The intraday strategies stay retired unless the owner says otherwise.

## Sequencing

One implementation session at a time (`docs/v3-handover-2026-09-24.md`).
Codex's local dual-entry build lands first and is reviewed read-only.
Phases 1–2 follow; they change no trading behaviour. Phases 3–7 take their
approvals first.

**P0 — Rebuild the dual-entry plumbing (CODE; Codex's local build was never pushed).** Implement the 8,991 order on `origin/main`, and check the result against the cross-reference
checklist (scanner `orderAuthority`, retirement fence, producer-derived basis,
`humanOverride`, `sidecar-pins.test.js`, gateway-restart files touched), plus:
- `routes/actions.js:1212` must not drop `admittedBases` when `mode` is
  present.
- The auto-switch must not clear the bar side on promotion
  (`entry-mode-auto.js:230` → `entry-mode.js:229`), and demotion must reach
  dual accounts (`:199`).
- The website control for both bases.
- The PR body must say "manual review required", because it restarts
  gateways.

*P0 status, 25-09-2026 — WP-A (PR-2 "Dual admission", branch
`claude/pr1-dual-admission`, built, not merged).* Node-only: nothing under
`cpp-exec/**` or `agent/lib/exec-engine.*` is touched, so this PR restarts no
gateway. What it does:
- One `POST /actions/entry-mode {mode:'TIME_BASED', admittedBases:['bar','tick']}`
  sets "Time + tick" and takes the ack protocol (epoch, WARMING, echo,
  STABLE). The route no longer drops `admittedBases` beside a mode.
- **Promotion adds tick next to bar** (`TIME_BASED` + `['bar','tick']`); it no
  longer replaces bar with tick. Demotion reaches every account whose
  requested bases include tick. A human's override records the bases chosen,
  and a human change of the admitted set now binds the automatic pass too.
- The readiness gate follows the TARGET bases; the evidence rules are asked
  on the record the ack will write; a set must hold its mode's own basis.
- `admitEntry` takes the basis from the registered producer; a caller naming
  another basis is refused `producer_basis_conflict`. The `basis: 'bar'`
  literals at `loop.js` (autoTrade's retired-producer ask) and
  `closed-market-limits.js` (the fence) are gone. Manual intents are recorded
  under their family (`manual` / `manual_assisted`), not `bar`.
- The website offers Stop / Time-based / Tick momentum / Time + tick, chosen
  by the requested bases; the tick half shows "tick BLOCKED — <checks>"
  while readiness is false.

Risks carried (named, not fixed): every add or remove of tick bumps the epoch,
so `releaseOldEpoch` releases every RESERVED intent of the old epoch — bar and
manual ones included — and bar entries pause through WARMING for the push
round trip. On an `auto` dual account a transient tick-readiness failure
therefore also pauses bar entries (principle 7). `producer_basis_conflict` has
no production caller that can trigger it today (every explicit caller matches
the registry); only the unit test fires it. The P6 combined-risk gaps stay open,
so dual admission remains ask-first per account. Today every Time + tick
request is refused `tick_not_ready` on all 7 accounts.

**P1 — Measurement (CODE, no behaviour change).**
- Record the entry basis on each closed trade (join `entry_intents`; reuse
  `tradedTickEvidence`, `tick-validation.js:88-113`).
- One definition: R units, win = net R > 0.
- A per-account, per-basis GET report giving trades, WR with a Wilson
  interval, PF, payoff, expectancy and its bootstrap lower bound. Reuse
  `portfolioStats` (`tick-shadow.js:79-121`) and `expectancyLowerR` /
  `blockExpectancyLowerR` (`tick-replay-sim.js:215-227, 302-318`).
- Fix `performance_snapshots` rows that carry a null `account_id`.
- Count tick trades in family reporting (`family-edge.js:142-144`).
- Under the sample minimums the report says "insufficient", not a number
  (principle 6).

**P2 — Counterfactual re-score (CODE, report only).** Re-score the last 30 days
of shadow trades with the stop floor (`stop_distance` is stored) and the
counter-trend filter (the `regimes` table keeps 30 days). Report PF and WR of
the trades kept and the trades removed, and the count removed (the veto cost).
This answers "can filtering lift both?" before anything goes live.

**P3 — Shadow = live (CODE, after D5).**
- Add to `ShadowBook` and the JS replayer together, kept in parity by
  `cpp-exec/src/tests/test_tick_shadow.cpp`: the stop floor, the price bound
  (store the signal price), the trend filter, pending-signal expiry, and the
  live trailing exit.
- Bind the replay sim to `tick-shadow-sim.json`: refuse a trial whose
  `targetR`, latency, hold caps or screen differ.
- The evidence window starts again, because it is a new population.

**P4 — Research path (CODE, after D6).**
- Add a newest-data or date-window segment selection with an untouched final
  holdout (`tick-research-run.js:66, :385`).
- Count `includeTest` openings per profile, as the multiple-testing record.
  PR-Q1 (#1092, merged) records every opening in `tick_test_openings`
  (keeper job, in-thread run, client import; a dry run and a stage-A grid are
  refused; a second opening of the same holdout is refused), and GET
  `/state/tick-research` counts them per profile over the whole ledger. The
  same PR fixes the withheld-summary leak (`statisticsVersion` v2; every
  earlier trial reads as consulted), records each trial's origin and segment
  digests, and adds GET `/state/tick-replay-parity`. Its checker's follow-up
  (branch `claude/v3-q1-replay-honesty`, not yet merged) closes four
  blockers: the gate counts every stored trial whose summary is not
  `train_validation` as consulted (a pre-v2 `includeTest` row did not count);
  every research door refuses `sim.blocks` other than 3 (`blocks: 1`
  withheld nothing and wrote no opening); the withheld test row no longer
  carries a `purged` count and the train/validation rows drop a trade that
  exits in the test block; and the parity report's ring reads are indexed and
  its profile form compares at most 20 trials per request. Whether the replay
  reproduces the shadow is NOT YET COMPARED until that report reads ok or
  mismatch on a comparable window; sidecar worker-queue drops are not
  recorded per window, so a mismatch cannot rule one out. Carrying the
  openings into the REPLAY_PASSED evidence stays PR-Q2.
- Pooled evaluation (D6).
- Clear the pin on a reset to UNVALIDATED, so a second candidate can be pinned
  (`tick-validation.js:270`).

**P5 — Runtime tick profile (CODE + deploy, after D7; ships with P6).**
`/config tickProfile` carries the 12 fields and a hash check against Node's
computed hash, and the permit carries the profile hash.

**P6 — Combined-risk gaps (CODE, ASK-FIRST before any account takes both).**
- Check the cap per fire, not per push.
- A push clears permits that are no longer listed.
- Use up the permit only after the firer's checks (`tick_firer.cpp:136`).
- Apply the book-wide symbol limit and the 1/N split to tick.
- Re-check readiness on every push.
- Test that a permit cannot be spent twice after a restart
  (`engine.cpp:801-808`).

**P7 — Evidence (calendar time).**
1. Run the predeclared search from `docs/tick-momentum/plan.md`: the stage-A
   grid, the listed local variants and the ablations, over all segments. Every
   trial is recorded.
2. Choose a stable region on train/validation, then open the test block once.
3. Owner imports REPLAY_PASSED, then shadow for ≥ 48 h, 200 signals and
   30 trades, then owner imports SHADOW_PASSED.
4. If v1 fails, report "no qualifying profile". A new hypothesis (v2) is a
   separate owner decision.

**P8 — Parallel A/B (evidence).** Only once each basis alone shows PF > 1 out
of sample:
- Run time-only against time + tick on accounts the owner picks, with free
  slots.
- Fix the windows in advance (D3) and count the trades each basis displaced.
- Expect about 360 trades per arm before a win-rate rise can be shown.

## Verification

- Full gate per CLAUDE.md for each PR: node --test, eslint, vitest, build,
  check:no-green, and CI clean.
- Mutation checks that are asserted as applied: `grep -c` before and after
  (failure modes #1 and #2).
- `tick-validation.test.js` stays green with unchanged values. That is the
  proof the thresholds were not touched.
- Production read-back after each merge (GET only):
  - The P1 report's tick figures reconcile with `/state/tick-shadow`, and its
    bar figures with `/state/family-edge`.
  - The P2 kept+removed counts sum to the original.
  - After P3, the shadow parity test and one day of shadow rows show the
    filters firing.
- An invariants report (Passed / Failed / Not Verifiable) with each reply.

