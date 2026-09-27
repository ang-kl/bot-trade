# bot-trade handover, appendix: every file, per PR and by area

Companion to [`handover-2026-09-27.md`](handover-2026-09-27.md). Snapshot: **27-09-2026 06:00 SGT = 26-09-2026 22:00Z**. `origin/main` = `b414a06` (#1160). Takeover base = `83c94e6` (#1084).

- **Appendix A** lists all 71 merged PRs (#1085–#1160), each with what it did and every file it added (A), modified (M) or deleted (D).
- **Appendix B** lists the 572 distinct files changed between `83c94e6` and `b414a06`, grouped by area.
- **Appendix C** lists the open draft PRs and the pushed branches without a PR, with their commits and files at the cutoff.

**How this appendix was produced.** The file lists, counts and line numbers are generated from git, not copied:

```
git log --first-parent --format="%H|%cI|%s" 83c94e6..b414a06     # the 71 squash commits
git show -M --name-status --format= <sha>                         # A / M / D per PR
git show -M --numstat --format= <sha>                             # + / − per file
git diff --name-status 83c94e6 b414a06                            # Appendix B
git diff --numstat 83c94e6 b414a06
git diff --name-status b414a06...<branch head>                    # Appendix C
```

The prose under each PR ("What it did", "Verification recorded", "Other records", "Notes") is taken from two fact sheets that four independent read-only agents built from the squash commit, its commit body and the PR body on GitHub, and that were checked against git. Account ids are shown by their last four digits (…0058). Colour words in the recorded test results are written as "failed" / "passed".

## Appendix A: every merged PR and every file it touched

**Totals, measured.** 71 PRs. 983 file changes summed over the PRs (A 210 · M 773 · D 0); +77,519 / −4,324 lines summed over the PRs. Across the whole range the net result is 572 distinct files (A 210 · M 362 · D 0), +76,028 / −2,833, because many files were changed by several PRs (Appendix B).

**Merged by.** GitHub `merged_by` reads `ang-kl` on all 71. The PR author is also `ang-kl`, because the implementing session acts through the owner's GitHub credential. So `merged_by` cannot tell the owner's merge from the session's. Where a document names the owner as the one who merged, it is quoted under that PR: #1085, #1095 and #1143.

**Services (inferred).** Which Railway services a merge redeploys is inferred from the paths and the `railway.json` watch patterns; Railway's deployment history was not read. Codes: **N** = Node agent + website (every merge: the root `railway.json` has no `watchPatterns`); **G** = both broker gateways, cpp-exec (demo) and cpp-acct (live) (`cpp-exec/**`, `agent/lib/exec-engine.*`); **V** = cpp-verify (`cpp-verify/**`, `cpp-exec/src/ws_client.*`, `cpp-exec/src/http_server.*`); **S** = both scanners. The scanners had no `watchPatterns` until #1112 added them at 25-09 22:11:34Z, so every merge up to and including #1112 is inferred to have redeployed them too (27 PRs).

**Times.** "Merged" is GitHub `merged_at`; the squash commit's committer time agrees to within 1 s for all 71. SGT = UTC+8.

**Jump to a PR:** [#1085](#pr-1085) · [#1086](#pr-1086) · [#1087](#pr-1087) · [#1088](#pr-1088) · [#1089](#pr-1089) · [#1090](#pr-1090) · [#1091](#pr-1091) · [#1092](#pr-1092) · [#1093](#pr-1093) · [#1094](#pr-1094) · [#1095](#pr-1095) · [#1096](#pr-1096) · [#1097](#pr-1097) · [#1098](#pr-1098) · [#1099](#pr-1099) · [#1100](#pr-1100) · [#1101](#pr-1101) · [#1102](#pr-1102) · [#1103](#pr-1103) · [#1104](#pr-1104) · [#1105](#pr-1105) · [#1106](#pr-1106) · [#1107](#pr-1107) · [#1108](#pr-1108) · [#1109](#pr-1109) · [#1110](#pr-1110) · [#1111](#pr-1111) · [#1112](#pr-1112) · [#1113](#pr-1113) · [#1114](#pr-1114) · [#1115](#pr-1115) · [#1116](#pr-1116) · [#1117](#pr-1117) · [#1118](#pr-1118) · [#1119](#pr-1119) · [#1120](#pr-1120) · [#1121](#pr-1121) · [#1122](#pr-1122) · [#1123](#pr-1123) · [#1124](#pr-1124) · [#1125](#pr-1125) · [#1126](#pr-1126) · [#1127](#pr-1127) · [#1128](#pr-1128) · [#1129](#pr-1129) · [#1130](#pr-1130) · [#1131](#pr-1131) · [#1132](#pr-1132) · [#1133](#pr-1133) · [#1134](#pr-1134) · [#1135](#pr-1135) · [#1136](#pr-1136) · [#1137](#pr-1137) · [#1138](#pr-1138) · [#1139](#pr-1139) · [#1140](#pr-1140) · [#1141](#pr-1141) · [#1142](#pr-1142) · [#1143](#pr-1143) · [#1144](#pr-1144) · [#1145](#pr-1145) · [#1147](#pr-1147) · [#1148](#pr-1148) · [#1149](#pr-1149) · [#1150](#pr-1150) · [#1151](#pr-1151) · [#1152](#pr-1152) · [#1153](#pr-1153) · [#1154](#pr-1154) · [#1157](#pr-1157) · [#1160](#pr-1160)

<a name="pr-1085"></a>

### #1085 — One account admits time and tick together (WP-A), plus the Codex → Claude takeover record

- **Squash commit** `1b54c1f` · **merged** 25-09 08:21:25Z = 25-09 16:21:25 SGT · **services (inferred)** N, S · **head branch** `claude/pr1-dual-admission` (5 commits)
- **Plan item:** Dual-environment plan **P0** (rebuild of the dual-entry plumbing), delivered as **WP-A**. The plan's own P0 status note (`docs/dual-environment-plan-2026-09-25.md`) names it `PR-2 "Dual admission"`, branch `claude/pr1-dual-admission`. `docs/v3-integrated-plan-2026-09-26.md` §2 (on main) lists WP-A under group **P5c**.

**What it did.** `requestEntryMode` now accepts `admittedBases`, so one `POST /actions/entry-mode {mode:'TIME_BASED', admittedBases:['bar','tick']}` sets "Time + tick" through the full ack protocol (epoch, WARMING, echo, STABLE); the set's shape is checked first, a set without the mode's own basis is refused, the readiness gate follows the target bases, and the evidence rules are asked on the record the ack will write. `admitEntry` takes the basis from the registered producer and refuses a mismatch as `producer_basis_conflict`; the hard-coded `'bar'` defaults in `ctrader-creds.js`, `entry-ledger.js`, `loop.js` (the autoTrade fence) and `closed-market-limits.js` are removed, and manual intents are recorded under their family. The automatic switch works on bases: promotion adds tick next to bar instead of replacing it (owner-approved 25-09), demotion reaches dual accounts, and the take-back clears the bases. `acknowledgeEntryEpochs` isolates each account so one bad ack record cannot block the others, and resetting tick evidence on an account that admits tick is the named refusal `tick_admitted` instead of a 500. The website offers Stop / Time / Tick / Time + tick, with the tick half shown BLOCKED with its failing checks. Docs: `docs/claude-takeover-2026-09-25.md`, `docs/dual-environment-plan-2026-09-25.md`, a dated amendment to `docs/tick-momentum/plan.md`, and the CLAUDE.md ledger line.

**Verification recorded** (PR or commit body).

- PR body, maker's local gate on `d114275`: node 5,557 tests, 5,553 pass, 0 fail, 4 skipped; eslint clean; vitest 99 files, 969 pass; build OK; check:no-green OK. Six mutation checks, each confirmed applied by `grep -c` (1 → 0), made their named tests fail.
- PR body: tick stays refused `tick_not_ready` on all 7 accounts until the owner's evidence stages pass; `tick-validation.json`, the caps (5 / 8) and mandatory TP1 unchanged.
- PR body, known limit: `producer_basis_conflict` has no production caller that triggers it; only the unit test fires it.
- No production read-back in the PR or commit body.

**Other records** (not the PR or commit body).

- CLAUDE.md ledger on main (line dated 2026-09-25 08:24 UTC): "#1085 (dual admission, WP-A) was merged by the owner at 08:21 UTC and read back: `1b54c1f` live, all 7 accounts TIME_BASED/STABLE/bar, 0 errors, 32 positions protected."

<!-- details: Files of #1085: 33 (A 3 · M 30 · D 0), +1,326 / −183 -->
**Files of #1085: 33** (A 3 · M 30 · D 0), +1,326 / −183

| St | File | + | − |
|:-:|---|---:|---:|
| M | `CLAUDE.md` | 14 | 0 |
| M | `agent/config/entry-mode-policy.json` | 1 | 1 |
| M | `agent/lib/ctrader-creds.js` | 6 | 3 |
| M | `agent/lib/entry-producers.js` | 14 | 0 |
| M | `agent/loop.js` | 4 | 1 |
| M | `agent/routes/actions.js` | 30 | 10 |
| M | `agent/services/closed-market-limits.js` | 3 | 1 |
| M | `agent/services/controller-runtime.js` | 1 | 1 |
| M | `agent/services/controller-runtime.test.js` | 3 | 0 |
| A | `agent/services/entry-basis-callers.test.js` | 70 | 0 |
| M | `agent/services/entry-ledger.js` | 9 | 3 |
| M | `agent/services/entry-mode-auto.js` | 36 | 15 |
| M | `agent/services/entry-mode-auto.test.js` | 101 | 24 |
| M | `agent/services/entry-mode-gateway.test.js` | 19 | 0 |
| M | `agent/services/entry-mode.js` | 162 | 68 |
| M | `agent/services/entry-mode.test.js` | 222 | 8 |
| M | `agent/services/producer-retirement.test.js` | 5 | 1 |
| M | `agent/services/tick-permits.test.js` | 6 | 4 |
| M | `agent/services/tick-readiness.js` | 4 | 2 |
| M | `agent/services/tick-readiness.test.js` | 14 | 0 |
| M | `agent/services/tick-validation.js` | 11 | 1 |
| M | `agent/services/tick-validation.test.js` | 25 | 0 |
| A | `docs/claude-takeover-2026-09-25.md` | 78 | 0 |
| A | `docs/dual-environment-plan-2026-09-25.md` | 208 | 0 |
| M | `docs/tick-momentum/plan.md` | 2 | 0 |
| M | `docs/ui-control-inventory.md` | 2 | 2 |
| M | `src/components/ControllerRuntime.jsx` | 1 | 1 |
| M | `src/components/EngineStatusPanel.jsx` | 47 | 30 |
| M | `src/components/EntryModePolicySwitch.jsx` | 1 | 1 |
| M | `src/components/engine-status-panel.test.jsx` | 45 | 0 |
| M | `src/lib/agent-api.test.js` | 21 | 0 |
| M | `src/lib/engine-status-view.js` | 101 | 5 |
| M | `src/lib/engine-status-view.test.js` | 60 | 1 |
<!-- /details -->

<a name="pr-1086"></a>

### #1086 — Performance by basis with intervals, and the shadow counterfactual (plan P1/P2)

- **Squash commit** `f1d9223` · **merged** 25-09 09:22:48Z = 25-09 17:22:48 SGT · **services (inferred)** N, S · **head branch** `claude/pr-measurement` (4 commits)
- **Plan item:** Dual-environment plan **P1/P2** (`docs/dual-environment-plan-2026-09-25.md`), under owner decisions D1–D3.

**What it did.** New `GET /state/basis-performance` (`agent/services/basis-performance.js`) reports per account and per entry basis (tick, bar, manual, external, pre-open): trades, win rate with its Wilson interval, PF in R, payoff, expectancy and its bootstrap lower bound, all stamped with the frozen definition `r-net-v1`; below the sample minimum each derived figure reads "insufficient", and unscorable closes (rr = 0 with non-zero money, suspect exit price) are counted separately. `agent/services/trade-basis.js` assigns the basis: a `tick` intent decides; otherwise trade evidence (source, then the MAN/PRE label) decides, then the producer (`closed_market_limits` → pre-open; `manual`/`manual_assisted` → manual), so pre-open and manual trades are never counted as bar. New `GET /state/tick-shadow-counterfactual` re-scores the last 30 days of tick shadow trades with the live stop floor and the counter-trend filter (kept + removed = original), reading the gate config once and one regime query per symbol, memoised 60 s and dropped on any state write. Performance snapshots are written per account as well as pooled (`agent/services/performance-snapshots.js`), `/metrics` and `/metrics/history` match the account strictly with the history cutoff no longer dropping its own day, and tick closes go in a separate `byBasis.tick` block of `/state/family-edge`.

**Verification recorded** (PR or commit body).

- PR body: independent checker FIX FIRST (3 blockers), all fixed in `98b65f9`; re-checker MERGE; its nit 1 (memo ignored state writes) fixed in `0dc9ae8`.
- PR body, full gate on `0dc9ae8` merged on main `ac54074`: node 5,599 tests, 5,596 pass, 0 fail, 3 skipped; eslint clean; vitest 972 pass; build OK; check:no-green OK. Mutation checks confirmed applied by `grep -c`, each made its named test fail.
- Commit body: counterfactual measured 1.56–1.59 s before, 0.83–0.92 s after, at 9,000 rows per side (local).
- PR body: 0 closed tick trades today, so tick rows read empty; a scoped `/metrics` read returns null until the first snapshot pass after deploy. No production read-back recorded.

**Notes.**

- Owner decision flagged in the PR body: momentum resting limits carrying the PRE label now read as **pre-open**, not bar (asked in owner update № 9,080).

<!-- details: Files of #1086: 21 (A 7 · M 14 · D 0), +1,633 / −59 -->
**Files of #1086: 21** (A 7 · M 14 · D 0), +1,633 / −59

| St | File | + | − |
|:-:|---|---:|---:|
| M | `CLAUDE.md` | 11 | 0 |
| M | `agent/lib/tick-replay-sim.js` | 19 | 0 |
| M | `agent/lib/tick-replay-sim.test.js` | 15 | 1 |
| M | `agent/loop.js` | 4 | 28 |
| M | `agent/routes/state.js` | 90 | 18 |
| A | `agent/services/basis-performance.js` | 248 | 0 |
| A | `agent/services/basis-performance.test.js` | 313 | 0 |
| M | `agent/services/daily-report.js` | 5 | 0 |
| M | `agent/services/daily-report.test.js` | 17 | 0 |
| M | `agent/services/direction-policy.js` | 11 | 1 |
| M | `agent/services/family-edge.js` | 16 | 3 |
| M | `agent/services/family-edge.test.js` | 19 | 0 |
| A | `agent/services/performance-snapshots.js` | 84 | 0 |
| A | `agent/services/performance-snapshots.test.js` | 111 | 0 |
| M | `agent/services/regime-gate.js` | 17 | 5 |
| M | `agent/services/regime-gate.test.js` | 18 | 0 |
| M | `agent/services/tick-shadow-accounts.js` | 1 | 1 |
| A | `agent/services/tick-shadow-counterfactual.js` | 243 | 0 |
| A | `agent/services/tick-shadow-counterfactual.test.js` | 244 | 0 |
| M | `agent/services/tick-shadow.js` | 7 | 2 |
| A | `agent/services/trade-basis.js` | 140 | 0 |
<!-- /details -->

<a name="pr-1087"></a>

### #1087 — WP-A checker follow-ups: reset corner, untested branches, honest labels, visible ack refusal

- **Squash commit** `ac54074` · **merged** 25-09 08:52:47Z = 25-09 16:52:47 SGT · **services (inferred)** N, S · **head branch** `claude/pr2b-wpa-followups` (2 commits)
- **Plan item:** Follow-up to **#1085** (WP-A): its independent checker's nits 1–9 (the checker returned MERGE, no blockers).

**What it did.** Resetting tick evidence on a `TICK_MOMENTUM` account whose overlay was narrowed to `['bar']` used to throw a 500; it is now refused by name as `tick_admitted`. The bulk "Time-based all" skip becomes a pure exported helper, `bulkSkips` (`engine-status-view.js`), so a Time + tick row is no longer skipped as "already requested"; the mode-less overlay branch of `POST /actions/entry-mode` gets behavioural tests (200 with unchanged epoch for `['bar']`, 400 `tick_not_ready` for `['bar','tick']` on an unevidenced account). The label falls back to the local `basesFor` mirror when `bases` is absent, and the "requested" text shows "Time + tick". A refused acknowledgement now writes an `action_log` `ACK_REFUSED` row with the contract's reason instead of only a `console.warn`. Also: `docs/ui-control-inventory.md` regenerated, stale comments reworded, and `eslint.config.js` ignores `.claude/worktrees`.

**Verification recorded** (PR or commit body).

- PR body, maker's gate on `a15ae8b`: node 5,560 tests, 5,556 pass, 0 fail, 4 skipped; eslint clean; vitest 972; build OK; no-green OK. On `51d8a52` `eslint .` also clean. Five mutation checks (nits 1, 2, 3a, 3b, 6), each confirmed applied by count and made its assertion fail.
- No production read-back recorded.

<!-- details: Files of #1087: 13 (A 0 · M 13 · D 0), +198 / −34 -->
**Files of #1087: 13** (A 0 · M 13 · D 0), +198 / −34

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/services/entry-mode.js` | 21 | 9 |
| M | `agent/services/entry-mode.test.js` | 57 | 0 |
| M | `agent/services/heartbeat.js` | 7 | 3 |
| M | `agent/services/tick-permits.js` | 8 | 2 |
| M | `agent/services/tick-validation.js` | 11 | 2 |
| M | `agent/services/tick-validation.test.js` | 30 | 0 |
| M | `docs/ui-control-inventory.md` | 1 | 1 |
| M | `eslint.config.js` | 1 | 1 |
| M | `src/components/EngineStatusPanel.jsx` | 3 | 3 |
| M | `src/components/engine-status-panel.test.jsx` | 1 | 0 |
| M | `src/lib/agent-api.test.js` | 10 | 5 |
| M | `src/lib/engine-status-view.js` | 21 | 7 |
| M | `src/lib/engine-status-view.test.js` | 27 | 1 |
<!-- /details -->

<a name="pr-1088"></a>

### #1088 — Scanners: one boot-started bridge with rebuild-on-exit, bounded comparison retention, auth before parse (PR-3)

- **Squash commit** `d4d648f` · **merged** 25-09 10:04:53Z = 25-09 18:04:53 SGT · **services (inferred)** N, S · **head branch** `claude/pr3-scanner-bridge` (2 commits)
- **Plan item:** Title and PR body: "**PR-3** of the dual-entry/scanner sequence (`docs/dual-environment-plan-2026-09-25.md`; **WP-B B1 + WP-E E1**)". V3-SEQUENCE §1 queue (scratchpad `V3-SEQUENCE.md`, not committed on main) item 2 is **C3**, "SEQUENCE PR-3 bridge and collector", group **P5c**; `docs/v3-integrated-plan-2026-09-26.md` §2 (on main) lists C3 as merged under P5c. Note: the string "PR-3" does not occur in the committed `docs/dual-environment-plan-2026-09-25.md` (grep).

**What it did.** `ensureScannerBridge` / `startScannerBridge` in `agent/services/scanner-feed.js` start one bridge worker per database from `startLoop` at boot and on a 60 s timer (not from `runLoop`, whose circuit-breaker early returns could stop it); the worker is rebuilt only after an `error`/`exit` or a construction throw, at most once per 30 s, and a failed `send()` is counted against its job, never rebuilt. Refused timeframe inputs are recorded as `input_refused` with sub-reasons (`bars_empty`, `last_bar_partial`, `bar_not_closed`, `ohlc_invalid`, `ttl_invalid`, `request_bound`, `reference_identity_conflict`). Comparison load: a per-page memo reads the registry and account maps once, oracle stream keys drop the feed epoch, and `retainComparisons` keeps 100k rows per source, deleting in 2,000-row chunks through a covering `(source, state, observed_ms)` index in place of the per-row COUNT trim; the 7-day age deletes are chunked too. The profile limit rises 512 → 1024 (`lib/scanner-bounds.js`) and the registration route gets a 512 KiB JSON parser mounted after `authMiddleware`, so an unauthenticated large body is refused before parsing. The refusal breakdown in `comparisonStatus` is bounded to the last hour (`inputRefusedLastHour`). Inert until `SCANNER_BRIDGE_ENABLED` and registered profiles exist; scanners keep `orderAuthority: false`.

**Verification recorded** (PR or commit body).

- PR body, gate on `4334d14` (maker): node 5,575 tests, 5,574 pass, 0 fail, 1 skipped; eslint clean; vitest 969; build OK; no-green OK; three native scanner integration tests ran and passed; 20 mutation checks, each applied (1 → 0) and caught by a failing test.
- PR body, gate on `bf72693` (fix round, rebased on main `f1d9223`): node 5,619 tests, 5,615 pass, 0 fail, 4 skipped; eslint clean; vitest 972 (99 files); build OK; no-green OK; 9 more mutation checks, all caught by failing tests.
- PR body, local measurement at 200,000 rows: status read 44 ms, breakdown 1.7 ms (unbounded query 108 ms here; the checker measured 270 ms). N1: 51 statements of at most 23 ms each where one statement took 558 ms.
- PR body, known limits: N4 (collector liveness watchdog) deferred to PR-4; a worker that hangs without exiting is never rebuilt. No production read-back recorded.

<!-- details: Files of #1088: 16 (A 6 · M 10 · D 0), +888 / −54 -->
**Files of #1088: 16** (A 6 · M 10 · D 0), +888 / −54

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/index.js` | 9 | 1 |
| A | `agent/lib/scanner-bounds.js` | 12 | 0 |
| M | `agent/loop.js` | 7 | 1 |
| A | `agent/routes/scanner-registration-body.js` | 20 | 0 |
| A | `agent/routes/scanner-registration-body.test.js` | 95 | 0 |
| A | `agent/services/scanner-bridge-start.test.js` | 155 | 0 |
| A | `agent/services/scanner-bridge-wiring.test.js` | 24 | 0 |
| M | `agent/services/scanner-candidates.js` | 9 | 3 |
| M | `agent/services/scanner-collector.js` | 10 | 2 |
| M | `agent/services/scanner-collector.test.js` | 27 | 0 |
| M | `agent/services/scanner-comparison.js` | 102 | 15 |
| A | `agent/services/scanner-comparison.test.js` | 196 | 0 |
| M | `agent/services/scanner-feed.js` | 130 | 28 |
| M | `agent/services/scanner-integration.test.js` | 42 | 1 |
| M | `agent/services/scanner-profile-registry.js` | 8 | 3 |
| M | `docs/v3-scanner-operator-2026-09-23.md` | 42 | 0 |
<!-- /details -->

<a name="pr-1089"></a>

### #1089 — Report failures are an explicit 503; /prices and /storage stop answering falsely (V3 M2, P1/P4)

- **Squash commit** `79b5785` · **merged** 25-09 10:43:10Z = 25-09 18:43:10 SGT · **services (inferred)** N, S · **head branch** `claude/v3-m2-report-503` (1 commit)
- **Plan item:** **V3 M2**, group **P1/P4** (title). V3-SEQUENCE §1 queue (scratchpad `V3-SEQUENCE.md`, not committed on main) item 4.

**What it did.** A report worker that missed its deadline, found no free slot or failed now rejects with a typed `ReportUnavailableError` (`agent/services/performance-populations.js`), and `sendReportUnavailable()` in `agent/routes/state.js` maps it to **HTTP 503** with a reason, `retryAfter` in the body and a `Retry-After` header (5 s capacity, 15 s worker exit, 30 s deadline/other). Routes covered: `/decisions-daily` (its 30,002 ms deadline was a 500), `/perf-ledger`, `/account-analytics`, `/cup-handle-funnel`, `/stage-matrix`, `/prices` (was 200 `{prices:{}, error}`) and `/storage`; a route's own post-processing error stays a 500, and the response cache copies `Retry-After` to requests coalesced behind the failing call. A new worker kind `storage` (`readStorageReport`) runs the dbstat walk — measured holding the event loop 20.99 s at 08:39Z — on its own reserved single slot with a 60 s bound, never taking one of the two shared slots. The Desk and Trade pages read prices through `loadLatestPrices()` and show "Latest prices unavailable (…)" instead of converting through an empty map.

**Verification recorded** (PR or commit body).

- PR body, maker's run on the final tree: node --test 5,612 pass, 0 fail, 4 skipped; eslint clean; vitest 980; build OK; check:no-green OK.
- PR body: six mutations, each confirmed applied (1 → 0) and restored byte-for-byte; failing-test counts 3, 9, 1, 2, 1, 1.
- No production read-back in the PR or commit body.

**Other records** (not the PR or commit body).

- #1096's PR body (later): production `/state/storage` "now exceeds its 60 s worker limit and answers 503, which is the honest behaviour since #1089".

<!-- details: Files of #1089: 11 (A 5 · M 6 · D 0), +486 / −35 -->
**Files of #1089: 11** (A 5 · M 6 · D 0), +486 / −35

| St | File | + | − |
|:-:|---|---:|---:|
| A | `agent/routes/report-unavailable.test.js` | 141 | 0 |
| M | `agent/routes/state.js` | 40 | 6 |
| M | `agent/services/performance-populations.js` | 53 | 9 |
| A | `agent/services/report-unavailable.test.js` | 104 | 0 |
| M | `agent/services/storage-report.js` | 3 | 1 |
| M | `docs/ui-control-inventory.md` | 15 | 15 |
| A | `src/components/LatestPricesNote.jsx` | 10 | 0 |
| A | `src/lib/latest-prices.js` | 36 | 0 |
| A | `src/lib/latest-prices.test.jsx` | 66 | 0 |
| M | `src/pages/Desk.jsx` | 9 | 2 |
| M | `src/pages/Trade.jsx` | 9 | 2 |
<!-- /details -->

<a name="pr-1090"></a>

### #1090 — Agent tests remove their temp directories; CI fails on any leak (V3 A1, P8a)

- **Squash commit** `1b65f36` · **merged** 25-09 10:56:17Z = 25-09 18:56:17 SGT · **services (inferred)** N, S · **head branch** `claude/v3-a1-test-tmp-cleanup` (1 commit)
- **Plan item:** **V3 A1**, group **P8a** (title). V3-SEQUENCE §1 queue (scratchpad `V3-SEQUENCE.md`, not committed on main) item 1 (P8).

**What it did.** New `agent/test-support/temp-dir.js` gives drop-in `mkdtempSync` / `mkdtemp` / `tempDir(prefix)` whose directories are removed with `rmSync` when the process exits (pass, fail or throw; not on a signal kill). New `agent/test-support/tmp-guard.js` provides `privateTmpDir`, `childTestEnv` (sets TMPDIR, drops `NODE_TEST_CONTEXT`), `leftovers`, `describeLeftovers` and `tapTotals`. `scripts/run-agent-tests.mjs` (the CI step) runs the whole suite under one private TMPDIR and fails the step, listing each leftover by name and size, if anything remains. 41 test files switch to the helper (the 37 that leaked on main plus 4 that cleaned up only on pass). On main one full run left 279 directories (190,865,902 B). Test files, helper and CI runner only; no production code.

**Verification recorded** (PR or commit body).

- PR body, `agent/test-hygiene.test.js` (6 tests) and four mutation checks, each confirmed present before/absent after and restored with matching checksums (e.g. removing the exit-cleanup line: "5 entries, 28,791,377 B").
- PR body: maker's run on `f1d9223` node 5,601 pass, 0 fail; eslint clean; vitest 972; build and no-green OK. Rebased onto `79b5785`: `node scripts/run-agent-tests.mjs` 5,608 tests, 5,604 pass, 0 fail, 4 skipped, "the private TMPDIR is empty after the full suite", exit 0.

<!-- details: Files of #1090: 45 (A 3 · M 42 · D 0), +393 / −65 -->
**Files of #1090: 45** (A 3 · M 42 · D 0), +393 / −65

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/db-path.test.js` | 3 | 2 |
| M | `agent/db.test.js` | 2 | 1 |
| M | `agent/lib/wal-open.test.js` | 2 | 1 |
| M | `agent/loop-phase-indexes.test.js` | 2 | 1 |
| M | `agent/routes/tick-readiness-routes.test.js` | 2 | 1 |
| M | `agent/services/account-horizon.test.js` | 2 | 1 |
| M | `agent/services/account-phases.test.js` | 1 | 1 |
| M | `agent/services/arming-log.test.js` | 1 | 1 |
| M | `agent/services/arming-ratchet.test.js` | 1 | 1 |
| M | `agent/services/cup-handle-funnel.test.js` | 2 | 2 |
| M | `agent/services/emergency-reclaim.test.js` | 5 | 4 |
| M | `agent/services/entry-ledger.test.js` | 1 | 1 |
| M | `agent/services/entry-mode.test.js` | 1 | 1 |
| M | `agent/services/error-log.test.js` | 2 | 2 |
| M | `agent/services/global-strategy-seed.test.js` | 2 | 1 |
| M | `agent/services/hand-pin-watch.test.js` | 2 | 1 |
| M | `agent/services/loss-postmortem.test.js` | 2 | 2 |
| M | `agent/services/momentum-account.test.js` | 3 | 2 |
| M | `agent/services/momentum-book.test.js` | 2 | 1 |
| M | `agent/services/naked-position-guard.test.js` | 2 | 1 |
| M | `agent/services/open-duplicates.test.js` | 2 | 1 |
| M | `agent/services/opportunity-funnel.test.js` | 2 | 2 |
| M | `agent/services/opportunity-identity.test.js` | 2 | 2 |
| M | `agent/services/phase-trace.test.js` | 2 | 2 |
| M | `agent/services/position-capture-backlog.test.js` | 2 | 1 |
| M | `agent/services/position-capture.test.js` | 2 | 1 |
| M | `agent/services/prune-scans.test.js` | 2 | 1 |
| M | `agent/services/reclassify-null-sl.test.js` | 3 | 2 |
| M | `agent/services/report-retention.test.js` | 2 | 1 |
| M | `agent/services/risk-config-seed.test.js` | 2 | 1 |
| M | `agent/services/risk-reassess.test.js` | 1 | 1 |
| M | `agent/services/runtime-manifest.test.js` | 2 | 1 |
| M | `agent/services/stage-matrix.test.js` | 2 | 1 |
| M | `agent/services/statement-import.test.js` | 2 | 1 |
| M | `agent/services/storage-report.test.js` | 2 | 2 |
| M | `agent/services/strategy-liveness.test.js` | 2 | 2 |
| M | `agent/services/telegram-chart.test.js` | 2 | 1 |
| M | `agent/services/vol-context-carry.test.js` | 2 | 1 |
| M | `agent/services/vol-gate.test.js` | 2 | 1 |
| M | `agent/services/watchlists.test.js` | 2 | 1 |
| M | `agent/state-stmt-cache.test.js` | 2 | 2 |
| A | `agent/test-hygiene.test.js` | 150 | 0 |
| A | `agent/test-support/temp-dir.js` | 64 | 0 |
| A | `agent/test-support/tmp-guard.js` | 62 | 0 |
| M | `scripts/run-agent-tests.mjs` | 35 | 9 |
<!-- /details -->

<a name="pr-1091"></a>

### #1091 — Momentum plan and bind arithmetic in ticks and integers; the timed quote waits for a fresh event (V3 T1, P0/P3)

- **Squash commit** `e87b125` · **merged** 25-09 11:34:28Z = 25-09 19:34:28 SGT · **services (inferred)** N, S · **head branch** `claude/v3-t1-plan-arithmetic` (1 commit)
- **Plan item:** **V3 T1**, group **P0/P3** (title). V3-SEQUENCE §1 queue (scratchpad `V3-SEQUENCE.md`, not committed on main) item 6.

**What it did.** The momentum entry contract stops comparing prices as floats: the fill-shifted bind stop snaps to the price grid in whole ticks (an off-grid multi-deal average rounds outward) and broker SL/TP are compared with the plan in ticks. Recorded lots must equal the plan's integer broker volume (float residue only, 1e-12 relative). `readPartialOwnership` takes the plan's digits, and one shared rule, `ownershipMatchesPlan`, serves the bind handover, the partial manager and the rank exit, whose broker-price checks also compare in ticks. The planner refuses `requiredRr` below the 3.0 floor instead of clamping, and refuses digits above 5. The timed quote skips stale events and keeps listening until its deadline, using the evidence decoder's freshness rule. No production behaviour changes yet: `recordedPlans` is 0 and no producer calls this path until T4.

**Verification recorded** (PR or commit body).

- PR body: measured on main by the new tests — 252 of 2,000 randomized fills refused on the stop; 32 of 1,000 FX sizes refused at lotSize 1e7.
- PR body: nine mutations (M1–M9), each present once before and absent after, restored byte-for-byte, all caught by failing tests.
- PR body: maker's run on `d4d648f` node 5,633 pass, 0 fail; eslint clean; vitest 972; build and no-green OK. Rebased onto `1b65f36`: `run-agent-tests.mjs` 5,622 pass, 0 fail, 4 skipped; private TMPDIR empty.

<!-- details: Files of #1091: 17 (A 1 · M 16 · D 0), +641 / −52 -->
**Files of #1091: 17** (A 1 · M 16 · D 0), +641 / −52

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/services/momentum-broker-evidence.js` | 4 | 1 |
| M | `agent/services/momentum-entry-contract.js` | 27 | 11 |
| M | `agent/services/momentum-partial-broker.js` | 7 | 4 |
| M | `agent/services/momentum-partial-broker.test.js` | 34 | 1 |
| M | `agent/services/momentum-partial-manager.js` | 9 | 10 |
| M | `agent/services/momentum-partial-manager.test.js` | 52 | 0 |
| M | `agent/services/momentum-partial-ownership.js` | 18 | 3 |
| M | `agent/services/momentum-partial-ownership.test.js` | 41 | 5 |
| A | `agent/services/momentum-plan-arithmetic.test.js` | 196 | 0 |
| M | `agent/services/momentum-rank-exit.js` | 6 | 8 |
| M | `agent/services/momentum-rank-exit.test.js` | 37 | 0 |
| M | `agent/services/momentum-target-policy.js` | 55 | 2 |
| M | `agent/services/momentum-target-policy.test.js` | 45 | 3 |
| M | `agent/services/momentum-timed-quote.js` | 11 | 3 |
| M | `agent/services/momentum-timed-quote.test.js` | 51 | 1 |
| M | `docs/v3-momentum-entry-contract-2026-09-25.md` | 26 | 0 |
| M | `docs/v3-momentum-target-policy-2026-09-24.md` | 22 | 0 |
<!-- /details -->

<a name="pr-1092"></a>

### #1092 — Replay honesty: leak fix, test-block opening ledger, provenance, parity report, caller as actor (V3 Q1, P6/P7)

- **Squash commit** `ed3d1da` · **merged** 25-09 11:42:05Z = 25-09 19:42:05 SGT · **services (inferred)** N, S · **head branch** `claude/v3-q1-replay-honesty` (1 commit)
- **Plan item:** **V3 Q1**, group **P6/P7** (title). V3-SEQUENCE §1 queue (scratchpad `V3-SEQUENCE.md`, not committed on main) item 12.

**What it did.** When the test block is withheld, the replay summary, diagnostics and rejected counts now cover only trades that entered and exited before it (`summary.scope`), and `statisticsVersion` moves to v2 so every earlier trial reads as consulted; `maxHoldEvents` 0 means 4N, as the C++ side reads it. A new table `tick_test_openings` records every test-block opening with its caller before the replay reads it; `includeTest` is refused on a dry run, on a stage-A grid, and unless `profileHash` names the one profile the params produce, and a second opening of the same holdout gets a 409 (also enforced by `scripts/tick-research.mjs --profile`). Each trial's manifest records per-file sha256 and bytes, the environments, the replayer commit and a sim hash; `/tick-trials` imports are stored as `client_import`, unverified. `queue_overflow` and `reserve_pause` gaps no longer reset the warm-up. New `GET /state/tick-replay-parity` (ok / mismatch / not_comparable) and `GET /state/tick-research?profile=&limit=all`. `/tick-validation`, `/entry-mode-policy`, `/tick-trials` and `/tick-research` record the actor from the server-stamped `req.authCredential` instead of the literal `'owner'`, and a request cannot claim the bot's own actors (`auto:`, `config/`, `tick-validation:`). `tick-validation.json`, `tick-validation.js` and its test are untouched.

**Verification recorded** (PR or commit body).

- PR body: 8 mutations, each confirmed 1 → 0 and restored (checked with `cmp`), all caught by failing tests.
- PR body: maker's run on `d4d648f` node 5,682 pass, 0 fail; eslint clean; vitest 972; build and no-green OK. Rebased onto `1b65f36`: `run-agent-tests.mjs` 5,671 pass, 0 fail, 4 skipped; TMPDIR empty. Rebased again onto `e87b125` for CI.

<!-- details: Files of #1092: 18 (A 5 · M 13 · D 0), +1,632 / −76 -->
**Files of #1092: 18** (A 5 · M 13 · D 0), +1,632 / −76

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/db.js` | 37 | 1 |
| M | `agent/index.js` | 4 | 0 |
| A | `agent/lib/request-actor.js` | 52 | 0 |
| A | `agent/lib/request-actor.test.js` | 104 | 0 |
| M | `agent/lib/tick-replay-sim.js` | 102 | 11 |
| M | `agent/lib/tick-replay-sim.test.js` | 71 | 1 |
| M | `agent/routes/actions.js` | 29 | 7 |
| M | `agent/routes/state.js` | 19 | 1 |
| A | `agent/services/tick-replay-honesty.test.js` | 231 | 0 |
| A | `agent/services/tick-replay-parity.js` | 300 | 0 |
| A | `agent/services/tick-replay-parity.test.js` | 219 | 0 |
| M | `agent/services/tick-research-run.js` | 195 | 27 |
| M | `agent/services/tick-research-run.test.js` | 15 | 7 |
| M | `agent/services/tick-research.js` | 198 | 17 |
| M | `agent/services/tick-research.test.js` | 30 | 1 |
| M | `agent/services/trading-coverage-followup.test.js` | 4 | 1 |
| M | `docs/dual-environment-plan-2026-09-25.md` | 10 | 0 |
| M | `scripts/tick-research.mjs` | 12 | 2 |
<!-- /details -->

<a name="pr-1093"></a>

### #1093 — Account history summarises the whole window, not the page (V3 B3, P5d-1)

- **Squash commit** `8b6241a` · **merged** 25-09 11:48:55Z = 25-09 19:48:55 SGT · **services (inferred)** N, S · **head branch** `claude/v3-b3-account-history` (1 commit)
- **Plan item:** **V3 B3**, **P5d-1** (title; group P5b/P5d in the PR body). V3-SEQUENCE §1 queue (scratchpad `V3-SEQUENCE.md`, not committed on main) item 14 (P5d).

**What it did.** `agent/services/account-history.js` computes equity change, cashflow coverage, adjusted change, reconciled span and drawdown over every retained observation in the requested window, whatever `limit` or `before` is; before, it used only the returned page (at most 2,000 rows), so a 24 h window at one reading a minute was always "incomplete". New response fields `summaryScope: 'full_window'`, `summaryObservations`, `summaryEquityObservations`, `bucketMs` and at most 400 UTC-aligned `buckets` (count; first/last/min/max equity; cashflow sums; null where cashflow is uncovered). `agent/db.js` adds covering index `idx_account_history_summary` with `json_valid` guards, so one malformed row cannot make index creation, and so boot, throw. `AccountHistory.jsx` asks for 240 rows instead of 2,000 (new `src/lib/account-history-request.js`) and says "across the whole window" only when the server declares it. A real cashflow hole is still reported as `cashflow_coverage_gap`.

**Verification recorded** (PR or commit body).

- PR body: six mutation checks, each present once before and absent after, the test failed, restored byte-for-byte.
- PR body: maker's run on `1b65f36` node 5,644 pass, 0 fail; eslint clean; vitest 984; build and no-green OK. `run-agent-tests.mjs` on `1b65f36` + B3: 5,610 pass, 0 fail, 4 skipped; TMPDIR empty.
- PR body, local synthetic cost (not production): first-boot index build 0.85 s on 86,400 rows; a 30-day summary read about 220 ms on the main thread (7 days about 50 ms).

<!-- details: Files of #1093: 9 (A 2 · M 7 · D 0), +455 / −41 -->
**Files of #1093: 9** (A 2 · M 7 · D 0), +455 / −41

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/db.js` | 16 | 0 |
| A | `agent/services/account-history-window.test.js` | 188 | 0 |
| M | `agent/services/account-history.js` | 98 | 25 |
| M | `agent/services/account-history.test.js` | 8 | 2 |
| M | `agent/services/cashflow-collector.test.js` | 3 | 1 |
| M | `docs/account-history-2026-09-22.md` | 40 | 1 |
| M | `src/components/AccountHistory.jsx` | 37 | 12 |
| M | `src/components/account-history.test.jsx` | 50 | 0 |
| A | `src/lib/account-history-request.js` | 15 | 0 |
<!-- /details -->

<a name="pr-1094"></a>

### #1094 — Bar-side qualification in R with intervals and reachability, report only (V3 Q4b, P6/P7)

- **Squash commit** `38c99d0` · **merged** 25-09 12:00:20Z = 25-09 20:00:20 SGT · **services (inferred)** N, S · **head branch** `claude/v3-q4b-bar-qualification` (1 commit)
- **Plan item:** **V3 Q4b**, group **P6/P7** (title). V3-SEQUENCE §1 queue (scratchpad `V3-SEQUENCE.md`, not committed on main) item 21.

**What it did.** New `agent/services/pf-metrics.js` holds the frozen metric labels `r-net-v1` (PF in R) and `usd-net-v0` (PF in money), `netRof` (moved unchanged from `basis-performance.js`), `summarizeR`, and `summarizeUsd` (the evidence gate's money arithmetic, character for character). New `GET /state/strategy-qualification` (`agent/services/strategy-qualification.js`) gives one row per strategy per enabled account over the gate's own population: closes against the bar, PF in R and in money, win rate with its Wilson interval, closes in the last 30 days with the ETA to 30 closes ("unreachable at current rate" when the 90-day window cannot reach it), "insufficient" under the bar, and a pooled row counting copies of one signal (same strategy, symbol and side within 15 min) once, frozen as `bar-qualification-v1`. Closed months go in a new append-only `qualification_windows` table whose triggers refuse UPDATE and DELETE; later differences are stored as restatements. `evidence-gate.js` is split into `evidenceRows` / `summarizeEvidence` / `evidenceRecord` and its record gains `profitFactorR`, while the gate still judges money; `family-edge.js` and `strategy-verdicts.js` show `profitFactorR` beside the money figures. Report only: nothing that gates reads the new figures.

**Verification recorded** (PR or commit body).

- PR body: 23 tests; 10 mutations (M1–M10), each counted once before and zero after, the test failed, restored byte-for-byte.
- PR body: maker's run on `1b65f36` node 5,661 pass, 0 fail; eslint clean; vitest 980; build and no-green OK. `run-agent-tests.mjs` on `ed3d1da` + Q4b: 5,712 pass, 0 fail, 4 skipped; TMPDIR empty.

**Notes.**

- Declined / owner decision H-P6-7 (PR body): gating or verdicts on R, counting since the pin, copies counted once in any gate. No heartbeat job seals the months.

<!-- details: Files of #1094: 12 (A 4 · M 8 · D 0), +1,218 / −47 -->
**Files of #1094: 12** (A 4 · M 8 · D 0), +1,218 / −47

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/routes/state.js` | 15 | 0 |
| M | `agent/services/basis-performance.js` | 1 | 16 |
| M | `agent/services/evidence-gate.js` | 59 | 23 |
| M | `agent/services/evidence-gate.test.js` | 42 | 0 |
| M | `agent/services/family-edge.js` | 25 | 4 |
| M | `agent/services/family-edge.test.js` | 27 | 0 |
| A | `agent/services/pf-metrics.js` | 112 | 0 |
| A | `agent/services/pf-metrics.test.js` | 54 | 0 |
| A | `agent/services/strategy-qualification.js` | 522 | 0 |
| A | `agent/services/strategy-qualification.test.js` | 325 | 0 |
| M | `agent/services/strategy-verdicts.js` | 13 | 4 |
| M | `agent/services/strategy-verdicts.test.js` | 23 | 0 |
<!-- /details -->

<a name="pr-1095"></a>

### #1095 — Order-lifecycle flags: GET /state/order-lifecycle, 35 versioned rules on the read-only worker (V3 L1)

- **Squash commit** `7562efe` · **merged** 25-09 13:09:31Z = 25-09 21:09:31 SGT · **services (inferred)** N, S · **head branch** `claude/v3-l1-order-lifecycle` (1 commit)
- **Plan item:** **V3 L1**, "added today at the owner's order (25-09 16:50 SGT)" (PR body). `docs/v3-integrated-plan-2026-09-26.md` §2 (on main) places L1–L2b in the **REC, WEB** row.

**What it did.** New `agent/services/order-lifecycle.js` holds 35 rules, each a versioned, cited data object: PRE-01..05 (pre-order), ORD-01..10 (order), CLS-01..09 (close), STK-01..11 (stuck). `GET /state/order-lifecycle` validates parameters on the main thread (400), builds the report on its own read-only worker slot in one transaction bounded at 512 KB, and answers `503 order_lifecycle_unavailable` with `lastSnapshotAt` and `no-store` on a failed build. `order-lifecycle-ticker.js`, started from `loop.js`, runs every 10 minutes, writes one snapshot row of at most 64 KB and beats heartbeat `order_lifecycle`. It adds four goal rows (`lifecycle_pre_order`, `lifecycle_order`, `lifecycle_close`, `lifecycle_stuck`; goal table 20 → 24), inspector findings, a daily-report section and a Reasons page entry; `agent/config/order-lifecycle.json` sets the acceptance start `2026-09-25T08:50:00Z` (proposed), and `agent/db.js` adds `idx_refusal_scores_scored`. Reporting only; it names writer gaps W1–W10 for later PRs.

**Verification recorded** (PR or commit body).

- PR body: `order-lifecycle.test.js` (61) with a failing and a passing fixture per rule and a meta-test; `order-lifecycle-route.test.js` (4) including a stall probe (worst event-loop delay 10.8 ms under the full gate; a deliberate 120 ms block is caught).
- PR body: 6 mutations, each present before and absent after, restored with sha256 matched, all caught by failing tests (M5, build moved to the main thread, held the loop 674–680 ms).
- PR body: maker's run on `1b65f36` node 5,703 pass, 0 fail; eslint clean; vitest 981; build and no-green OK. `run-agent-tests.mjs` on `38c99d0` + L1: 5,783 pass, 0 fail, 4 skipped; TMPDIR empty.

**Other records** (not the PR or commit body).

- CLAUDE.md ledger on main (line dated 2026-09-25 13:21 UTC): "L1 by the owner at 13:09 UTC with its three checker blockers open" (fixed by #1097).
- #1097's PR body (later): production on `7562efe`, read 13:14 UTC, `/state/order-lifecycle` counted 14 STK-03 `trade_inflight_unresolved` records as new although the newest is dated 07-09 (checker blocker B1 visible live).

<!-- details: Files of #1095: 21 (A 5 · M 16 · D 0), +2,578 / −17 -->
**Files of #1095: 21** (A 5 · M 16 · D 0), +2,578 / −17

| St | File | + | − |
|:-:|---|---:|---:|
| A | `agent/config/order-lifecycle.json` | 6 | 0 |
| M | `agent/db.js` | 4 | 0 |
| M | `agent/loop.js` | 6 | 0 |
| M | `agent/routes/goal-table-routes.test.js` | 3 | 3 |
| A | `agent/routes/order-lifecycle-route.test.js` | 213 | 0 |
| M | `agent/routes/state.js` | 27 | 1 |
| M | `agent/services/controller-groups.test.js` | 1 | 1 |
| M | `agent/services/daily-report.js` | 10 | 0 |
| M | `agent/services/daily-report.test.js` | 3 | 2 |
| M | `agent/services/goal-table.js` | 21 | 1 |
| M | `agent/services/goal-table.test.js` | 3 | 3 |
| M | `agent/services/heartbeat.js` | 6 | 0 |
| M | `agent/services/log-inspector.js` | 14 | 0 |
| A | `agent/services/order-lifecycle-ticker.js` | 69 | 0 |
| A | `agent/services/order-lifecycle.js` | 1,318 | 0 |
| A | `agent/services/order-lifecycle.test.js` | 831 | 0 |
| M | `agent/services/performance-populations.js` | 21 | 0 |
| M | `agent/shared/controller-groups.js` | 1 | 1 |
| M | `src/lib/reasons-view.js` | 3 | 0 |
| M | `src/pages/Reasons.jsx` | 1 | 1 |
| M | `src/pages/reasons.test.jsx` | 17 | 4 |
<!-- /details -->

<a name="pr-1096"></a>

### #1096 — Replay honesty follow-up: one consulted rule, fixed block cut, no test-block counts, indexed parity reads (V3 Q1b)

- **Squash commit** `ae72146` · **merged** 25-09 13:36:30Z = 25-09 21:36:30 SGT · **services (inferred)** N, S · **head branch** `claude/v3-q1-replay-honesty` (1 commit)
- **Plan item:** **V3 Q1b**, follow-up to **#1092 (Q1)**: its adversarial checker ran after the merge and returned FIX FIRST with four blockers.

**What it did.** B1: two indexes, `idx_cpp_decisions_side_ts (side, ts_ms)` and `idx_cpp_decisions_tick_signal (side, component, kind, symbol_id, ts_ms)`, and a 20-trial cap on the profile form of the parity report (was 60 by default, 200 max), with the reply stating `limit`, `trialsNotCompared` and `notComparedNote`; measured locally at 500k rows, 145.6 ms → 0.6 ms per trial. B2: one rule, `consultedScope`, is used by the gate, the ledger and the view (every scope except `train_validation` counts as consulted), so a held-out block cannot be opened twice. B3: any `sim.blocks` other than 3 is refused 400 `blocks_fixed` at all four doors and in the script, and `summaryScopeOf` reads the stored scope. B4: a withheld row has `purged: null` and train/validation rows are built only from trades exiting before the test block. Nits N3, N5, N6, N7, N9, N11 fixed (e.g. the opening is recorded before the worker starts). Trading untouched.

**Verification recorded** (PR or commit body).

- PR body: 12 new and 3 extended tests; EXPLAIN QUERY PLAN pins for both indexes; 13 mutations, all caught by failing tests, each confirmed present once before and absent after, restored byte-for-byte.
- PR body, builder's run on `38c99d0`: node 5,761 pass, 0 fail, 4 skipped; eslint clean; vitest 984; build and no-green OK.
- PR body, risk: boot cost of the two indexes **Not Verifiable** (about 1.0 s per 500k rows locally; production size of `cpp_decisions` unknown because `/state/storage` answers 503).

<!-- details: Files of #1096: 10 (A 0 · M 10 · D 0), +454 / −70 -->
**Files of #1096: 10** (A 0 · M 10 · D 0), +454 / −70

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/db.js` | 12 | 0 |
| M | `agent/lib/tick-replay-sim.js` | 16 | 3 |
| M | `agent/lib/tick-replay-sim.test.js` | 21 | 1 |
| M | `agent/services/tick-replay-honesty.test.js` | 156 | 2 |
| M | `agent/services/tick-replay-parity.js` | 43 | 7 |
| M | `agent/services/tick-replay-parity.test.js` | 46 | 1 |
| M | `agent/services/tick-research-run.js` | 42 | 15 |
| M | `agent/services/tick-research.js` | 94 | 29 |
| M | `docs/dual-environment-plan-2026-09-25.md` | 19 | 10 |
| M | `scripts/tick-research.mjs` | 5 | 2 |
<!-- /details -->

<a name="pr-1097"></a>

### #1097 — Order-lifecycle follow-up: stuck findings judged by persistence, partial stages never on-track, heartbeat-judged controllers (V3 L1b)

- **Squash commit** `2e80f39` · **merged** 25-09 13:36:40Z = 25-09 21:36:40 SGT · **services (inferred)** N, S · **head branch** `claude/v3-l1b-lifecycle-fixes` (1 commit)
- **Plan item:** **V3 L1b**, follow-up to **#1095 (L1)**, merged at 13:09 UTC with three checker blockers open; this PR fixes them and the checker's ten nits.

**What it did.** B1: stuck rules get a new falsifier, `lifecycle_rule_persists`, which needs a snapshot taken after the deadline minus 30 minutes (still violating → confirmed; 0 → falsified; otherwise expired), and `lifecycle_rule_recurs` returns null unless the snapshot postdates `sinceMs`; both are version-keyed. B2: each stage carries `unreadable[]` and `truncated[]`, and a partial stage can be off_track ("at least N") but never on_track — it becomes not_measurable; a rule whose `rows()` throws is reported unreadable instead of failing the report. B3: STK-11 (v2) judges every controller through `heartbeatView`, the view `/state/heartbeats` serves — stalled or 3+ consecutive failures is stuck, `record_stale`/`never_ran` listed not verifiable. Nits include distinct-record counts, a 10-minute grace on ORD-01 and STK-04, STK-07 ignoring from = to drains, and 107 re-anchored cites; rule versions ORD-01@2, STK-04@2, STK-07@2, STK-11@2, helpers@2. Carries the CLAUDE.md serial write-back. Report-only.

**Verification recorded** (PR or commit body).

- PR body, production evidence for B1 (on `7562efe`, read 13:14 UTC): `/state/order-lifecycle` counts 14 STK-03 records as new although the newest is dated 07-09.
- PR body, builder's gate on `7f360aa` (identical code; this branch adds only the ledger lines): node 5,841 tests, 5,837 pass, 0 fail, 4 skipped; eslint clean; vitest 986; build OK; no-green OK. 11 mutations, each `grep -c` 1 → 0, the test failed, restored byte-for-byte.
- PR body: Not Verifiable — above 50,000 approvals in a window the pre-order row reads not_measurable (truncated), by design.

<!-- details: Files of #1097: 7 (A 0 · M 7 · D 0), +738 / −106 -->
**Files of #1097: 7** (A 0 · M 7 · D 0), +738 / −106

| St | File | + | − |
|:-:|---|---:|---:|
| M | `CLAUDE.md` | 12 | 0 |
| M | `agent/services/log-inspector.js` | 15 | 5 |
| M | `agent/services/order-lifecycle.js` | 289 | 81 |
| M | `agent/services/order-lifecycle.test.js` | 384 | 13 |
| M | `src/lib/reasons-view.js` | 14 | 4 |
| M | `src/pages/Reasons.jsx` | 3 | 3 |
| M | `src/pages/reasons.test.jsx` | 21 | 0 |
<!-- /details -->

<a name="pr-1098"></a>

### #1098 — Boot record, lag tap, named startup phases, route status codes, first-protection stamps (V3 M1)

- **Squash commit** `65dd155` · **merged** 25-09 14:50:54Z = 25-09 22:50:54 SGT · **services (inferred)** N, S · **head branch** `claude/v3-m1-boot-record` (1 commit)
- **Plan item:** **V3 M1** (title). V3-SEQUENCE §1 queue (scratchpad `V3-SEQUENCE.md`, not committed on main) item 3, group **P1/P4**.

**What it did.** New `agent/services/boot-clock.js` fixes BOOT as process start (`performance.timeOrigin`), and new `agent/services/runtime-record.js` keeps a boot record: DB init timing, listening time, and the first of each of loop (with per-phase ms), fast tick, band, all-account Node audit, first clean audit, slow-monitor pass, equity stop, adaptive breaker and performance breaker, each written once with its outcome. It also records the startup window (HTTP status counts by route, the worst event-loop stall, budget overruns per 10 minutes) and latency windows (last 360 main-loop durations with p50/p95/p99/max; event-loop lag for 10 min, 2 h and since start). The record persists as `boot_record_json`, with the previous boot's record moved to `boot_record_prev_json` once per boot, at most one write per 30 s, and is served only on authenticated `/health` as `bootRecord` and `latencyWindows`. `route-timing.js` keys routes by mount + pattern with status classes (cap 120 → 256), `event-loop-lag.js` gains a tap, and `ctrader-ws.js` / `ctrader-session.js` gain a try/catch-wrapped token-wait callback.

**Verification recorded** (PR or commit body).

- PR body, builder's gate (the CI command): eslint 0 problems; latency group 28/28; hygiene group 6/6; remaining suite (482 files) 5,758 tests, 5,754 pass, 0 fail, 4 skipped; private TMPDIR empty; vitest 100 files, 984 passed; build ok; check:no-green OK. Mutations each counted once before and zero after, the test failed, restored (sha256); the table shows 5 rows before the body is truncated.
- PR body, independent check: MERGE, no blockers. On the merged tree with L1, 119 files / 1,995 tests passed; main's copies of the 8 modified test files against the branch: 104 of 105 pass (the one failure is the intended cap note). Local smoke boot twice: public `/health` keys unchanged.

**Other records** (not the PR or commit body).

- `docs/v3-integrated-plan-2026-09-26.md` §2 (on main): "M1 **Passed** (first loop 86,423 ms on `22bcd29`; harness row 04:13:36Z)".
- Scratchpad `V3-SEQUENCE.md` (uncommitted): "Overnight merges, 25-09 22:50–23:20 SGT: M1 #1098, WEB-6 #1100, C4 #1099, I1 #1101, WEB-2 #1102, WEB-10 #1105, WEB-7 #1104, WEB-9 #1103 … Production 66fa205 read back: 0 errors; pnl_reconcile ok (fails 0 after 1,801), unresolved 2→1." (`66fa205` is #1104's squash, so that read-back predates #1103's merge.)

<!-- details: Files of #1098: 20 (A 4 · M 16 · D 0), +1,897 / −37 -->
**Files of #1098: 20** (A 4 · M 16 · D 0), +1,897 / −37

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/health-exposure.test.js` | 27 | 0 |
| M | `agent/index.js` | 32 | 15 |
| M | `agent/lib/ctrader-session.js` | 14 | 0 |
| M | `agent/lib/ctrader-session.test.js` | 48 | 0 |
| M | `agent/lib/ctrader-ws.js` | 6 | 2 |
| M | `agent/loop-phase-indexes.test.js` | 78 | 4 |
| M | `agent/loop.js` | 43 | 3 |
| A | `agent/services/boot-clock.js` | 43 | 0 |
| M | `agent/services/event-loop-lag.js` | 146 | 0 |
| M | `agent/services/event-loop-lag.test.js` | 74 | 1 |
| M | `agent/services/fast-monitor-sidecar-quotes.test.js` | 100 | 0 |
| M | `agent/services/fast-monitor.js` | 96 | 4 |
| M | `agent/services/fast-monitor.test.js` | 55 | 0 |
| M | `agent/services/naked-position-guard.js` | 7 | 1 |
| M | `agent/services/protection-both-sides.test.js` | 7 | 0 |
| M | `agent/services/route-timing.js` | 115 | 5 |
| M | `agent/services/route-timing.test.js` | 145 | 2 |
| A | `agent/services/runtime-record.js` | 396 | 0 |
| A | `agent/services/runtime-record.test.js` | 235 | 0 |
| A | `docs/v3-p1p4-acceptance-2026-09-25.md` | 230 | 0 |
<!-- /details -->

<a name="pr-1099"></a>

### #1099 — Tick receipt and diagnostics: no_orders for tick accounts, tick refusals in the blocker report, report off the event loop (V3 C4)

- **Squash commit** `17fc57b` · **merged** 25-09 14:56:43Z = 25-09 22:56:43 SGT · **services (inferred)** N, S · **head branch** `claude/v3-c4-tick-receipt` (5 commits)
- **Plan item:** **V3 C4**; commit body "V3 C4, SEQUENCE PR-4". V3-SEQUENCE §1 queue (scratchpad `V3-SEQUENCE.md`, not committed on main) item 9, group **P5c**.

**What it did.** New `agent/services/tick-entry-work.js` keeps one per-side receipt, `tick_entry_work_json`, with full account ids, written by the heartbeat pass that did the work and deleted once no account on the side admits tick; tick-only and dual accounts now get `entry_activity` (and so `no_orders`) from it, the newest complete receipt per account and session winning, with the bar side's output unchanged apart from added fields. `blocker-report.js` adds the `tick_refusal` arm (16 columns), `byStage` and `tickEntryEvaluation`, and `GET /state/blocker-report` runs in the report worker instead of on the main event loop. The watchdog contract sends `blocker` as a string and carries `entryDiagnostics`, dropped first when the contract hits 256 KiB. Calendar demand for tick accounts is symbol-major and stops at the 512-identity limit (fix-round nit 1); the regime symbol set includes the tick source. The branch also carries the #1088 nits (`REFUSAL_WINDOW_MS`, `REFUSAL_ROW_LIMIT`) as a cherry-picked commit.

**Verification recorded** (PR or commit body).

- PR body, builder's final gate: eslint 0; node latency 28/28; hygiene 6/6; remaining suite 5,754 tests, 5,750 pass, 0 fail, TMPDIR empty; vitest chained after the node suite 1 failed / 984 passed (`src/pages/risk-anchors.test.js` 5 s timeout at 5,033 ms, load average 8.9 on 4 cores), vitest on its own 100 files 985/985; build ok; check:no-green ok. 12 mutations (M1–M12), each 1 → 0, the test failed, restored byte-for-byte.
- PR body, independent check: FIX FIRST (a conflicting import in `agent/routes/state.js` against main `2e80f39`, plus nits). Fix round `7749a8d` (merge commit `36d5744`, no force-push): 14 overlapping files, 222 tests, 219 pass, 0 fail, 3 skipped (native-binary tests); `watchdog-calendar-refresh.test.js` 15/15.
- PR body, owner question: a realistic contract fixture measured 248,860 B against the 262,144 B limit (95 %).

**Other records** (not the PR or commit body).

- Scratchpad `V3-SEQUENCE.md`: in the overnight read-back on `66fa205` (see #1098).

<!-- details: Files of #1099: 26 (A 6 · M 20 · D 0), +1,542 / −89 -->
**Files of #1099: 26** (A 6 · M 20 · D 0), +1,542 / −89

| St | File | + | − |
|:-:|---|---:|---:|
| A | `agent/loop-regime-symbols.test.js` | 42 | 0 |
| M | `agent/loop.js` | 9 | 3 |
| A | `agent/routes/blocker-report-isolation.test.js` | 79 | 0 |
| M | `agent/routes/state.js` | 23 | 6 |
| M | `agent/services/blocker-report.js` | 272 | 25 |
| M | `agent/services/blocker-report.test.js` | 163 | 3 |
| M | `agent/services/direction-policy.test.js` | 7 | 2 |
| M | `agent/services/heartbeat.js` | 9 | 0 |
| M | `agent/services/performance-populations.js` | 10 | 0 |
| M | `agent/services/regime.js` | 19 | 0 |
| M | `agent/services/regime.test.js` | 8 | 1 |
| M | `agent/services/scanner-comparison.js` | 16 | 2 |
| M | `agent/services/scanner-comparison.test.js` | 19 | 2 |
| M | `agent/services/scanner-integration.test.js` | 7 | 0 |
| A | `agent/services/scanner-work-tick.test.js` | 128 | 0 |
| M | `agent/services/scanner-work.js` | 109 | 39 |
| A | `agent/services/tick-entry-work.js` | 127 | 0 |
| A | `agent/services/tick-entry-work.test.js` | 125 | 0 |
| M | `agent/services/tick-permits.js` | 10 | 1 |
| M | `agent/services/watchdog-calendar-refresh.js` | 25 | 2 |
| M | `agent/services/watchdog-calendar-refresh.test.js` | 85 | 0 |
| A | `agent/services/watchdog-contract-entry-diagnostics.test.js` | 138 | 0 |
| M | `agent/services/watchdog-contract.js` | 13 | 2 |
| M | `docs/reporting-acceptance-2026-09-23.md` | 45 | 0 |
| M | `src/components/BlockerReport.jsx` | 27 | 1 |
| M | `src/components/blocker-report.test.jsx` | 27 | 0 |
<!-- /details -->

<a name="pr-1100"></a>

### #1100 — Session buckets from real exchange hours and DST (V3 WEB-6, 8,989-A row 6)

- **Squash commit** `cdb6711` · **merged** 25-09 14:51:46Z = 25-09 22:51:46 SGT · **services (inferred)** N, S · **head branch** `claude/v3-web6-sessions` (1 commit)
- **Commit subject:** "Session buckets from real exchange hours and DST (V3 WEB-6)" (the heading is the GitHub PR title)
- **Plan item:** **V3 WEB-6**; **8,989-A row 6** (GitHub title). `docs/v3-integrated-plan-2026-09-26.md` §2 (on main) places WEB-1..10 in the **REC, WEB** row.

**What it did.** New `agent/shared/report-sessions.js` holds one table of cash hours in each exchange's IANA zone (ASX 10:00–16:00 Australia/Sydney; SGX 09:00–17:00; HKEX 09:30–12:00 and 13:00–16:00; TSE 09:00–11:30 and 12:30–15:30; LSE 08:00–16:30; NYSE 09:30–16:00) and works out each session's UTC interval for the reported day, whether it is open now, and the tooltip text, so the rows stay correct through every DST change. `agent/services/performance-populations.js` sorts closes into sessions and OFF with those times and states `source: exchange_cash_hours_iana_dst` and `exceptions: holidays_and_early_closes_not_applied`. The fixed-UTC table in `agent/shared/performance-populations.js` is removed in favour of `sessionBuckets(report, accountId)`, and `src/pages/Performance.jsx` drops its private `STAT_SESSIONS`, captions the rule, and shows the "closed" badge from the report's open-now reading. The copy-to-text button no longer crashes on withheld cross-account money. Reporting only.

**Verification recorded** (PR or commit body).

- PR body, builder: node 22/22 (10 + 11 + 1); vitest 6/6; eslint clean on 7 files; a 5-minute sweep across all six clock changes against each exchange's local clock (133,056 checks). Two mutations (A: one season's offset → 10 tests failing; B: every row reads Sydney → 3 failing), restored and checked with `cmp`.
- PR body, independent check: MERGE, no blockers, 4 nits (tooltip dates, older-server tooltip wording, missing render test, report wording). No fix-round section in the PR body.

**Other records** (not the PR or commit body).

- Scratchpad `V3-SEQUENCE.md`: in the overnight read-back on `66fa205` (see #1098).

<!-- details: Files of #1100: 8 (A 2 · M 6 · D 0), +408 / −58 -->
**Files of #1100: 8** (A 2 · M 6 · D 0), +408 / −58

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/services/performance-populations.js` | 11 | 6 |
| M | `agent/services/performance-populations.test.js` | 67 | 1 |
| M | `agent/shared/performance-populations.js` | 28 | 8 |
| A | `agent/shared/report-sessions.js` | 108 | 0 |
| A | `agent/shared/report-sessions.test.js` | 141 | 0 |
| M | `docs/performance-populations-2026-09-22.md` | 7 | 2 |
| M | `src/components/performance-evidence.test.jsx` | 11 | 0 |
| M | `src/pages/Performance.jsx` | 35 | 41 |
<!-- /details -->

<a name="pr-1101"></a>

### #1101 — P&L reconcile can no longer stall on one trade: bounded attempts, terminal classification, truthful heartbeat (V3 I1)

- **Squash commit** `43ce227` · **merged** 25-09 14:56:56Z = 25-09 22:56:56 SGT · **services (inferred)** N, S · **head branch** `claude/v3-i1-pnl-reconcile` (3 commits)
- **Plan item:** **V3 I1** (title). `docs/v3-integrated-plan-2026-09-26.md` §2 (on main) places I1–I3 in the **REC, WEB** row.

**What it did.** The stall reproduced on production (13:43Z): `pnl_reconcile` in error with 1,776 consecutive failures since 21-09, for rows #774 AVY.US and #775 GEV.US on account …3489, whose duplicate-position refusal was recorded as `failed` without counting an attempt, so they stayed "never attempted" and could never be written off. Evidence-based refusals (the duplicate-row refusal, or a complete but unsettleable history, new code `POSITION_HISTORY_REFUSED`) now count as attempts, and after 6 attempts the row is written off as "unresolved: no broker evidence" with the evidence and a timestamp, `net_pnl` staying NULL and an `action_log` record written. A duplicate position can be settled row-scoped from the broker's complete position history only when no other row carries P&L, nothing else claims the position, and the broker's close falls inside the row's lifetime (R3); each written-off row gets one full-history re-read (R4, `position_pnl_reread:<acct>`, audit `PNL_WRITE_OFF_REREAD`). The heartbeat counts each account's outcome with `pnlPassSummary`, carries the other session's (live-side) repair result to the next beat through `pnlCrossSidePass`, and reads ok only when no account tried has failed. The false "7-day deal-history horizon" claim is removed from the write-off sweep.

**Verification recorded** (PR or commit body).

- PR body, builder: a scratch probe over the production shape printed `failed` on all 12 passes with main's code; the branch recovered #774 at 1.23 and made #775 terminal after 6 attempts, neverTriedOverdue 0. `pnl-reconcile-stall.test.js` 9/9; 18 covering files 482/482; eslint clean; 3 mutations, each caught by a failing test.
- PR body, independent check: FIX FIRST — B1: the new heartbeat never saw the live accounts' repair (account …3489 is `is_live=1`; the beat was built from the selected demo side only). Fix round `9cd0f5c`: B1, N1, N2, N3 fixed, N4 declined; targeted tests 368/368, eslint clean.

**Other records** (not the PR or commit body).

- Scratchpad `V3-SEQUENCE.md`: overnight read-back on `66fa205` — "pnl_reconcile ok (fails 0 after 1,801), unresolved 2→1".

<!-- details: Files of #1101: 7 (A 1 · M 6 · D 0), +978 / −62 -->
**Files of #1101: 7** (A 1 · M 6 · D 0), +978 / −62

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/lib/position-deal-history.js` | 23 | 6 |
| M | `agent/loop.js` | 53 | 20 |
| M | `agent/services/mark-unresolvable.js` | 30 | 2 |
| M | `agent/services/old-position-pnl.js` | 181 | 16 |
| M | `agent/services/pnl-backfill.js` | 214 | 8 |
| M | `agent/services/pnl-backfill.test.js` | 20 | 10 |
| A | `agent/services/pnl-reconcile-stall.test.js` | 457 | 0 |
<!-- /details -->

<a name="pr-1102"></a>

### #1102 — Account cards show the daily stop in force and loss-cap used (V3 WEB-2, 8,989-A row 4)

- **Squash commit** `8eac5d5` · **merged** 25-09 14:58:28Z = 25-09 22:58:28 SGT · **services (inferred)** N, S · **head branch** `claude/v3-web2-daily-stop-card` (2 commits)
- **Commit subject:** "Account cards show the daily stop in force and loss-cap used (V3 WEB-2)" (the heading is the GitHub PR title)
- **Plan item:** **V3 WEB-2**; **8,989-A row 4** (GitHub title), with row 11's Risk-controls line folded in.

**What it did.** New `agent/services/daily-stop-reading.js` makes the same three calls, in the same order, as the per-account pre-check before the risk gate, and returns the cap in the config's currency (USD), which rule sets it (the USD 200 floor or the 3 %/4 % tier), the engine's realised loss for the FX day, and loss-cap used = (realised loss + floating loss) ÷ cap, or "not read" / "not comparable" with a reason; it never throws. `/state/account-overview` rows gain a `dailyStop` field, and new `src/lib/daily-stop-display.js` turns it into card text without ever falling back to balance × %. The Performance cards, phone card, export, `PerfAccountScope.jsx`, `perf-aggregate.js` and the Data-feed Risk-controls line read the new field. The PR records that the item's premise was wrong: the engine does not enforce USD 150 on six accounts; `/state/risk-full` reports 150 because it omits the floor and tier settings.

**Verification recorded** (PR or commit body).

- PR body, production GET reads 25-09 13:37 UTC: engine caps 1,191.42 (…0058, 4 % tier, 17-09 record), 1,757.65 (…0949, 4 % tier), 200 floor for …9908, …3489, …7342 (SGD) and the two unfunded accounts (…2148, …9009; worked out from config).
- PR body, builder: node `daily-stop-reading.test.js` 12/12 plus 10/10 existing; vitest 5 files 42/42; eslint clean on 10 files; 3 mutations, each caught by a failing test (M1 removing floor and tiers: 8 of 12 node tests failing).
- PR body, independent check: MERGE, no blocker; node 22/22, vitest 42/42.

**Other records** (not the PR or commit body).

- Scratchpad `V3-SEQUENCE.md`: in the overnight read-back on `66fa205` (see #1098).

**Notes.**

- Left for later (PR body): the Risk page's "Daily stop-out" (`src/pages/Risk.jsx:550` via `src/lib/daily-cap-state.js`) uses the same floor-less formula; `/state/risk-full` `dailyPacing` still reports 150.

<!-- details: Files of #1102: 10 (A 4 · M 6 · D 0), +749 / −39 -->
**Files of #1102: 10** (A 4 · M 6 · D 0), +749 / −39

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/routes/state.js` | 10 | 1 |
| A | `agent/services/daily-stop-reading.js` | 178 | 0 |
| A | `agent/services/daily-stop-reading.test.js` | 207 | 0 |
| M | `src/components/PerfAccountScope.jsx` | 14 | 8 |
| M | `src/components/PerfMacroSections.jsx` | 5 | 4 |
| M | `src/components/perf-account-scope.test.jsx` | 2 | 1 |
| A | `src/lib/daily-stop-display.js` | 97 | 0 |
| A | `src/lib/daily-stop-display.test.jsx` | 161 | 0 |
| M | `src/lib/perf-aggregate.js` | 30 | 4 |
| M | `src/pages/Performance.jsx` | 45 | 21 |
<!-- /details -->

<a name="pr-1103"></a>

### #1103 — Data-feed card: measured latency, fees and swap, quote freshness, binding daily-loss line (V3 WEB-9, 8,989-A row 11)

- **Squash commit** `f9fc874` · **merged** 25-09 15:19:45Z = 25-09 23:19:45 SGT · **services (inferred)** N, S · **head branch** `claude/v3-web9-data-feed` (4 commits)
- **Commit subject:** "Data-feed card: measured latency, fees and swap, quote freshness; daily stop from the one engine reading (V3 WEB-9)" (the heading is the GitHub PR title)
- **Plan item:** **V3 WEB-9**; **8,989-A row 11** (GitHub title).

**What it did.** New read-only `agent/services/data-feed-report.js`: `executionCosts` over the latest N closes (default 300, max 1,000) gives entry-latency p50/p90/max with a measured-of-total count (null, never 0, when nothing is measured) and commission and swap summed per broker-verified deposit currency (`acct:<id>:deposit_currency_evidence_json`), with a separate "currency unverified" group; `quoteFreshness` reads the fast monitor's 10-minute sources from `fast_monitor_pass_json`; `NOT_MEASURED` names what nothing records. New `GET /state/data-feed?account=<id|all>&limit=N` adds `brokerDayOpenMs` from `fxDayOpenMs`, and `/state/risk-full` gains `dailyCapEnforced`, computed by the gate's own `dailyLossVerdict` with the pre-gate's inputs. The `DataFeed` card (`PerfMacroSections.jsx`, pure line builders in new `src/lib/data-feed.js`) shows latency with coverage, one fee/swap line per currency, quote freshness, the enforced cap and binding rule, daily bars labelled current or previous broker day, and the equity stop as "configured 15% · armed state not measured". The fix round adds `dataFeedCardScope`, so each value is shown only when its response belongs to the account on screen, names the guard blocking entries, and labels a daily bar within 2 h before the 17:00 New York day open "unverified".

**Verification recorded** (PR or commit body).

- PR body, builder: node 18/18 and 27/27; vitest 26/26; eslint clean; check:no-green OK; 2 mutations (M1 dropping tier and floor: 3 route tests failing; M2 collapsing the currency key: 2 failing), restored and `cmp` identical.
- PR body, independent check: FIX FIRST (the card showed the previous account's figures after an account switch). Fix round `c5fec73`: vitest 43/43 (8 new), including a render straight after an account switch and a comment-stripped wiring test of both card sites.
- Commit body: production 25-09 `dailyPacing` read "binding usd, cap 150" for …0058 (the figure `dailyCapEnforced` replaces).

**Other records** (not the PR or commit body).

- Scratchpad `V3-SEQUENCE.md`: #1103 merged "after a checked merge resolution: one daily-stop source, WEB-2's engine reading"; follow-up nit: word the Data-feed "left today" as "left today on realised P&L (floating not counted)" and fix the fixture (1130.17) — carried as F3 in the integrated plan.

**Notes.**

- The squash commit subject differs from the GitHub title (see the title check below).

<!-- details: Files of #1103: 11 (A 6 · M 5 · D 0), +1,191 / −24 -->
**Files of #1103: 11** (A 6 · M 5 · D 0), +1,191 / −24

| St | File | + | − |
|:-:|---|---:|---:|
| A | `agent/routes/data-feed-route.test.js` | 70 | 0 |
| M | `agent/routes/state.js` | 30 | 0 |
| A | `agent/services/data-feed-report.js` | 191 | 0 |
| A | `agent/services/data-feed-report.test.js` | 170 | 0 |
| M | `src/components/PerfMacroSections.jsx` | 49 | 13 |
| A | `src/components/data-feed-card.test.jsx` | 136 | 0 |
| M | `src/lib/daily-stop-display.js` | 78 | 1 |
| M | `src/lib/daily-stop-display.test.jsx` | 136 | 2 |
| A | `src/lib/data-feed.js` | 156 | 0 |
| A | `src/lib/data-feed.test.js` | 145 | 0 |
| M | `src/pages/Performance.jsx` | 30 | 8 |
<!-- /details -->

<a name="pr-1104"></a>

### #1104 — Partial money marked, gradients per currency, true "unavailable" reasons (V3 WEB-7, 8,989-A rows 7-9)

- **Squash commit** `66fa205` · **merged** 25-09 14:59:37Z = 25-09 22:59:37 SGT · **services (inferred)** N, S · **head branch** `claude/v3-web7-partial-money` (3 commits)
- **Commit subject:** "Partial money marked, gradients per currency, true "unavailable" reasons (V3 WEB-7)" (the heading is the GitHub PR title)
- **Plan item:** **V3 WEB-7**; **8,989-A rows 7–9** (GitHub title).

**What it did.** `populationStats` (`agent/shared/performance-populations.js`) takes optional `{currency, currencyOf}` and re-checks every contributing account; new `reportCurrency` and `reportCurrencyStats` pool money only within one recorded deposit currency. `agent/services/performance-populations.js` adds `depositCurrencies(db)`, and the report carries `currencyByAccount` (from broker asset-list evidence, only when it matches the account's own host) and `currencyPolicy`. New `src/lib/partial-money.js` (`pricedNote`, `partialTitle`, `moneyGap`, `ledgerMoneyNote`), and `src/lib/performance-gradients.js` builds per-currency Overall, strategy and asset-class groups with unique column ids and cells that carry `partial`, `why` and `text`. `Performance.jsx` labels partial sums "partial · n of m priced" (the "≥" glyph was declined as a false bound), shows each empty column's real reason, labels "Subtotal (overlapping)", and stops colouring a null net as a gain on the phone card. The fix round adds the `one-account-model.test.js` allowlist entry for the two `is_live` host-routing reads in `performance-populations.js`.

**Verification recorded** (PR or commit body).

- PR body, builder: node 20/20; vitest 7 files 65/65; eslint clean; check:no-green OK; replay on the saved 25-09 11:50Z production report: wide grid 23 → 38 columns, all unique, none empty in every row (was 11); ·489 30D Stocks −5.32 with "2 of 4 priced"; 30D Overall USD −4.9k, SGD +1.5k (58 of 60 priced). 5 mutations (M1–M5), 1 → 0, the test failed, `cmp` restored.
- PR body, independent check: FIX FIRST — the full gate failed on owner principle 1 (`agent/lib/one-account-model.test.js:236`: 2 `is_live` reads found, 0 allowed). Fix round `c22fc80`: one allowlist entry; 16/16 and 5/5; 3 mutations (M0–M2), each caught by a failing test.

**Other records** (not the PR or commit body).

- Scratchpad `V3-SEQUENCE.md`: in the overnight read-back on `66fa205` (see #1098; `66fa205` is this PR's squash).

<!-- details: Files of #1104: 10 (A 3 · M 7 · D 0), +570 / −81 -->
**Files of #1104: 10** (A 3 · M 7 · D 0), +570 / −81

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/lib/one-account-model.test.js` | 1 | 0 |
| M | `agent/services/performance-populations.js` | 24 | 0 |
| M | `agent/services/performance-populations.test.js` | 60 | 1 |
| M | `agent/shared/performance-populations.js` | 33 | 5 |
| A | `src/components/gradient-body.test.jsx` | 60 | 0 |
| A | `src/lib/partial-money.js` | 61 | 0 |
| A | `src/lib/partial-money.test.js` | 39 | 0 |
| M | `src/lib/performance-gradients.js` | 125 | 28 |
| M | `src/lib/performance-gradients.test.js` | 81 | 1 |
| M | `src/pages/Performance.jsx` | 86 | 46 |
<!-- /details -->

<a name="pr-1105"></a>

### #1105 — P&L chart: unpriced closes drawn as labelled gaps, a drawable default account (V3 WEB-10, 8,989-A row 13)

- **Squash commit** `7d68bf1` · **merged** 25-09 14:59:30Z = 25-09 22:59:30 SGT · **services (inferred)** N, S · **head branch** `claude/v3-web10-pnl-chart` (3 commits)
- **Commit subject:** "P&L chart: unpriced closes drawn as labelled gaps, a drawable default account (V3 WEB-10)" (the heading is the GitHub PR title)
- **Plan item:** **V3 WEB-10**; **8,989-A row 13** (GitHub title); owner default 25-09 21:30 SGT (commit body).

**What it did.** `src/lib/performance-curve.js` now draws a range that mixes priced and unpriced closes: each day holding an unpriced close starts a new stretch with a "no price" marker, the line is not connected into it, the level after the first break counts priced closes only, and drawdown is measured within each unbroken stretch. A range with no priced close, and pooled accounts, are still withheld. `defaultChartAccount` returns `{accountId, rank}` — first fully priced account, else one that draws with gaps, else one with no closes — and `defaultChartReason(rank)` gives a sentence only for ranks 0–2, so the All view never claims a reason it did not judge (the checker's blocker). `ReportChart.jsx` labels the decision bars as risk-engine decisions only, shows the distinct veto count, and draws no bar (instead of zero) for days older than the 90-day decision feed; `Performance.jsx` uses `DECISION_FEED_DAYS` for the URL and cache key. It reads evidence only, never `is_live`.

**Verification recorded** (PR or commit body).

- PR body, builder's production check (GET, 14:29Z): default account …7342; …3489 draws with gaps in all four ranges; …0058 (13 unpriced) and …0949 (5 unpriced) draw with gaps at 90D and All. main vs branch on the production report: identical on all 40 cells the old code drew; 16 intended withheld → gapped changes.
- PR body: vitest 17/17 (builder); 2 mutations, each caught by a failing test. Independent check FIX FIRST (the default-account sentence was false when the report was missing or no account drawable). Fix round `865d278`: vitest 26/26 across 5 files; `one-account-model` 5/5; eslint clean.

**Other records** (not the PR or commit body).

- Scratchpad `V3-SEQUENCE.md`: in the overnight read-back on `66fa205` (see #1098).

<!-- details: Files of #1105: 5 (A 2 · M 3 · D 0), +359 / −40 -->
**Files of #1105: 5** (A 2 · M 3 · D 0), +359 / −40

| St | File | + | − |
|:-:|---|---:|---:|
| M | `src/components/ReportChart.jsx` | 61 | 24 |
| A | `src/components/report-chart.test.jsx` | 88 | 0 |
| A | `src/lib/performance-curve-gaps.test.js` | 111 | 0 |
| M | `src/lib/performance-curve.js` | 96 | 14 |
| M | `src/pages/Performance.jsx` | 3 | 2 |
<!-- /details -->

<a name="pr-1106"></a>

### #1106 — better-sqlite3 bundling SQLite ≥ 3.51.3 before a second writing connection (V3 DEP-SQLITE)

- **Squash commit** `87620f3` · **merged** 25-09 15:33:18Z = 25-09 23:33:18 SGT · **services (inferred)** N, S · **head branch** `claude/v3-dep-sqlite-wal-fix` (1 commit)
- **Plan item:** **V3 DEP-SQLITE** (title). `docs/v3-integrated-plan-2026-09-26.md` §2 (on main) lists DEP-SQLITE under group **P5c**.

**What it did.** `agent/package.json` moves better-sqlite3 from `^11.0.0` to `^12.8.0` (lockfile updated), the lowest release bundling SQLite **3.51.3**, which fixes the WAL-reset bug (affected 3.7.0–3.51.2) before the scanner bridge adds a second writing connection. New `agent/lib/sqlite-wal-reset.js` provides `walResetFixed`, `readSqliteVersion` and `secondWriterRefusal`; `agent/services/scanner-feed.js` refuses to build the bridge on a runtime without the fix (fail-closed), and `agent/services/runtime-manifest.js` reports it. 12.8.0 supports Node 20.x and 22.x (both Dockerfiles use `FROM node:20`), and its compile defines and `binding.gyp` are identical to 11.10.0. `docs/tick-momentum/plan.md` gets a dated note.

**Verification recorded** (PR or commit body).

- PR body, production before the change (GET `/state/runtime-manifest`): Node v20.20.2, SQLite 3.49.2, binding 11.10.0, commit `2e80f39`.
- PR body, builder: `npm ci` on Node 20.20.2 and 22.22.2 both read `sqlite_version()` = 3.51.3; touched files 15/15; 26 DB-heavy/scanner files 175 tests, 172 pass, 0 fail, 3 skipped (native binaries absent); scanner-integration with locally built binaries 14/14; eslint clean. Mutation A (real downgrade to 11.10.0) applied and checked.
- PR body, independent check: MERGE, no blockers. Nit 1: the post-deploy read-back is still owed (`/state/runtime-manifest` must show `sqlite.version` 3.51.3 and `sqlite.walResetFixed` true); nit 2: local checkouts with 11.10.0 in `agent/node_modules` will see bridge tests fail until `npm ci`.
- No post-deploy read-back recorded in the PR or commit body.

<!-- details: Files of #1106: 9 (A 3 · M 6 · D 0), +382 / −13 -->
**Files of #1106: 9** (A 3 · M 6 · D 0), +382 / −13

| St | File | + | − |
|:-:|---|---:|---:|
| A | `agent/lib/sqlite-wal-reset.js` | 77 | 0 |
| A | `agent/lib/sqlite-wal-reset.test.js` | 134 | 0 |
| M | `agent/package-lock.json` | 7 | 4 |
| M | `agent/package.json` | 2 | 2 |
| M | `agent/services/runtime-manifest.js` | 16 | 4 |
| M | `agent/services/runtime-manifest.test.js` | 29 | 0 |
| A | `agent/services/scanner-bridge-sqlite-gate.test.js` | 92 | 0 |
| M | `agent/services/scanner-feed.js` | 23 | 3 |
| M | `docs/tick-momentum/plan.md` | 2 | 0 |
<!-- /details -->

<a name="pr-1107"></a>

### #1107 — Truthful controllers: autopilot heartbeat, non-ok records, position-history all-accounts false zero (V3 I2)

- **Squash commit** `a15b9b1` · **merged** 25-09 21:54:54Z = 26-09 05:54:54 SGT · **services (inferred)** N, S · **head branch** `claude/v3-i2-heartbeats` (1 commit)
- **Plan item:** **V3 I2** (title). `docs/v3-integrated-plan-2026-09-26.md` §2 (on main) places I1–I3 in the **REC, WEB** row.

**What it did.** Two readings disagreed: `/state/heartbeats` showed autopilot `record_stale` ("RECORD 26m OLD — past the 3m limit") while `action_log` showed a completed `AUTOPILOT /evaluate` every 10.0–11.0 min (busy) or 30.0–32.2 min (calm), 0 errors. New `agent/lib/autopilot-cadence.js` (functions moved from `strategy-autopilot.js`, which re-exports them) lets `agent/services/heartbeat.js` judge autopilot's record against its sweep cadence plus the grace window, taking the larger of the cadence when the stamp was written and now, so a hung sweep still reads stale. A new `dormantWhen` hook gives verdict `dormant` with a `dormant_reason` (e.g. `weekend_watch` while `LLM_DISABLED` is set), a stamp of 0 reads as no record, and `goal-table.js` `records_fresh` leaves dormant controllers out. `/position-history` takes its scope from `requestedAccount`, fixing the `?account=all` false zero (production 0/0 vs 53/1,255), and returns `scope`; `ControllerGroups.jsx` shows the dormant reason, and `getActiveSessions` in `agent/lib/sessions.js` takes an optional time.

**Verification recorded** (PR or commit body).

- PR body, builder's production reads (GET, 25-09 ~14:31 UTC): the cadence above; `pnl_reconcile` error with 1,792 consecutive failures (left to I1); `weekend_watch` never_ran with the LLM off.
- PR body, builder: 3 new files 15/15; 12 existing files 334/334; 6 route/view files 19/19; vitest 4/4; eslint clean. Mutation 1 reproduced the production text "RECORD 26m OLD — past the 3m limit"; mutation 2 reproduced the false zero (`0 !== 3`).
- PR body, independent check: MERGE, four nits; production re-checked 14:51 UTC (36 controllers; `pnl_reconcile` 1,798 failures); 46 node files 762/762.

<!-- details: Files of #1107: 12 (A 4 · M 8 · D 0), +541 / −66 -->
**Files of #1107: 12** (A 4 · M 8 · D 0), +541 / −66

| St | File | + | − |
|:-:|---|---:|---:|
| A | `agent/lib/autopilot-cadence.js` | 110 | 0 |
| A | `agent/lib/autopilot-cadence.test.js` | 63 | 0 |
| M | `agent/lib/sessions.js` | 5 | 2 |
| A | `agent/routes/position-history-scope-route.test.js` | 51 | 0 |
| M | `agent/routes/state.js` | 11 | 1 |
| M | `agent/services/goal-table.js` | 5 | 2 |
| A | `agent/services/heartbeat-cadence-dormant.test.js` | 167 | 0 |
| M | `agent/services/heartbeat.js` | 98 | 13 |
| M | `agent/services/order-lifecycle.js` | 3 | 3 |
| M | `agent/services/strategy-autopilot.js` | 6 | 43 |
| M | `src/components/ControllerGroups.jsx` | 2 | 2 |
| M | `src/components/controller-groups.test.jsx` | 20 | 0 |
<!-- /details -->

<a name="pr-1108"></a>

### #1108 — Stuck-record resolver: settle from broker evidence, else terminal "unresolved: no broker evidence" (V3 I3)

- **Squash commit** `169d337` · **merged** 25-09 22:08:48Z = 26-09 06:08:48 SGT · **services (inferred)** N, S · **head branch** `claude/v3-i3-stuck-resolver` (4 commits)
- **Plan item:** **V3 I3** (title). `docs/v3-integrated-plan-2026-09-26.md` §2 (on main) places I1–I3 in the **REC, WEB** row.

**What it did.** New `agent/services/stuck-resolver.js` (with `agent/lib/stuck-resolutions.js`) runs on the `order_lifecycle` ticker's 10-minute timer just before the snapshot, ends at most 25 records per kind per pass, and stores one verdict row per ended record in a new `stuck_resolutions` table (verdict, reason, evidence, prior state, timestamp); a record once ended is never judged again, nothing is deleted, and it never places, amends, cancels or closes an order. Stuck `submitting`/`unconfirmed` trades are settled from a matching broker closing deal, ended as the duplicate of a reconciler-adopted row, or written off after 24 h as "unresolved: no broker evidence" with no money written; resting orders become `filled`, `expired` or `unresolved` on evidence; gave-up captures are re-queued once or written off. For targetless positions (R7), a recovered target is written to `trades.tp_price` only when agent_state `stuck_resolver_target_write` is exactly `'true'` (default off, the checker's blocker, because target-restore would then send a broker amend). STK-01/03/06/09 go to v2, notice rule STK-12 names every write-off, helpers go to v3, and the per-symbol cap and tick position count stop counting ended trades; `stuck_resolver_enabled='false'` switches it off.

**Verification recorded** (PR or commit body).

- PR body, builder: `stuck-resolver.test.js` 16/16 on production shapes (#1398 0003.HK, #1395 TSLA.US, #1466 SUGAR, #1439 BTCUSD, the six STK-01 rows, #705 NATGAS, gave_up captures, #1687 ETHUSD / #1704 XRPUSD); `order-lifecycle.test.js` 82/82; 115/115; 95/95; eslint clean.
- PR body, independent check: FIX FIRST — B1: R7 wrote `trades.tp_price` and target-restore would amend at the broker. Fix round `b043958`: write gated behind `stuck_resolver_target_write`; the blocker and seven of eight nits fixed, NIT 6 only partly (passes still run over the 50 ms budget while the backlog clears), NIT 7 (R5 merge into the adopted row) needs the owner's decision. Conflicting count: brief says STK-03 ×14, maker expects 43 rows — not verifiable until deploy.

<!-- details: Files of #1108: 9 (A 3 · M 6 · D 0), +1,665 / −36 -->
**Files of #1108: 9** (A 3 · M 6 · D 0), +1,665 / −36

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/db.js` | 23 | 0 |
| A | `agent/lib/stuck-resolutions.js` | 63 | 0 |
| M | `agent/services/order-lifecycle-ticker.js` | 52 | 6 |
| M | `agent/services/order-lifecycle.js` | 149 | 19 |
| M | `agent/services/order-lifecycle.test.js` | 24 | 8 |
| A | `agent/services/stuck-resolver.js` | 754 | 0 |
| A | `agent/services/stuck-resolver.test.js` | 584 | 0 |
| M | `agent/services/symbol-position-cap.js` | 9 | 1 |
| M | `agent/services/tick-permits.js` | 7 | 2 |
<!-- /details -->

<a name="pr-1109"></a>

### #1109 — Every account's closes captured and verified; silent accounts cannot read healthy (V3 V1)

- **Squash commit** `b67bb96` · **merged** 25-09 22:35:54Z = 26-09 06:35:54 SGT · **services (inferred)** N · **head branch** `claude/v3-v1-capture-all-accounts` (4 commits)
- **Plan item:** **V3 V1** (title), including **LIFECYCLE-SPEC §7 W11** (commit body; so L2b skipped W11). `docs/v3-integrated-plan-2026-09-26.md` §2 (on main) places V1 in the **REC, WEB** row.

**What it did.** `closeTradeRow` in `agent/db.js` now queues a position capture whenever a row really moves open → closed (all five close writers go through it), and every reconcile path (selected account, other same-side accounts, the opposite side) queues its detected closes via `enqueueReconcileCloses`, deduplicated on (account, position). New `agent/services/position-capture-accounts.js` `runAllAccountCapture` drains every account once per reconcile cycle with its own credentials: a 7-day backfill (`POSITION_CAPTURE_BACKFILL_DAYS`, max 30), at most 10 queued and 5 drained per account per pass, a 60 s pass budget and a rotating start. `/state/position-capture` adds per-account counts and a status (`silent`, `stalled`, `verify_failing`, `ok`, `no_closes`), and a new `position_capture` heartbeat fails naming any silent, stalled or verifier-refused account. The verify client authorizes every account on a host in one connect and treats a 403 like a 409; after the fix round the client is built once per pass again and an `unverified` reply with `fetchComplete === false` (cpp-verify's "not connected") counts as skipped and is not stored. Deal names and `symbol_id` come from the account's own symbol list, and `persistDeals` keeps stored lots (W10).

**Verification recorded** (PR or commit body).

- Commit body, production 25-09 21:50 SGT: `/state/position-capture` read "pending 0, captured 45" while six of seven accounts, the other gateway side and every bot-made close never queued; no drain line since 22-09; cpp-verify `sessions=[]` since 23-09.
- PR body, builder: `position-capture-accounts.test.js` 27/27; 2,062 tests in the broad run; eslint clean; 4 mutations, each caught by a failing test.
- PR body, independent check: FIX FIRST — B1: the shared verifier never reconnected after its broker socket dropped and still read `ok` (reproduced: 5 passes, 1 connect, all records stored `unverified`). Fix round `a436763`: B1 fixed, nits 1–4 and 6–8 fixed (stalled judged on waiting time; threshold `max(30 min, 3 × pass period)`).

<!-- details: Files of #1109: 17 (A 3 · M 14 · D 0), +1,763 / −113 -->
**Files of #1109: 17** (A 3 · M 14 · D 0), +1,763 / −113

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/db.js` | 25 | 0 |
| M | `agent/lib/verify-client.js` | 58 | 11 |
| M | `agent/lib/verify-client.test.js` | 32 | 0 |
| M | `agent/loop.js` | 47 | 61 |
| M | `agent/routes/state.js` | 5 | 2 |
| M | `agent/services/broker-history-import.js` | 2 | 2 |
| A | `agent/services/close-capture.js` | 104 | 0 |
| M | `agent/services/controller-groups.test.js` | 1 | 1 |
| M | `agent/services/heartbeat.js` | 24 | 0 |
| M | `agent/services/order-lifecycle.js` | 6 | 6 |
| A | `agent/services/position-capture-accounts.js` | 613 | 0 |
| A | `agent/services/position-capture-accounts.test.js` | 713 | 0 |
| M | `agent/services/position-capture-backlog.test.js` | 21 | 11 |
| M | `agent/services/position-capture.js` | 42 | 9 |
| M | `agent/services/position-capture.test.js` | 19 | 4 |
| M | `agent/services/position-history.js` | 50 | 5 |
| M | `agent/shared/controller-groups.js` | 1 | 1 |
<!-- /details -->

<a name="pr-1110"></a>

### #1110 — Off-grid planned stops bind correctly; tick comparisons pinned (V3 T1b)

- **Squash commit** `ec4bc3c` · **merged** 25-09 21:55:09Z = 26-09 05:55:09 SGT · **services (inferred)** N, S · **head branch** `claude/v3-t1b-offgrid-stop` (1 commit)
- **Plan item:** **V3 T1b** (title), follow-up to T1 (#1091). `docs/v3-integrated-plan-2026-09-26.md` §2 (on main) lists T1b (#1110) under group **P0/P3**.

**What it did.** H1: `momentum-target-proposal.js` refuses an entry or stop more than 1e-6 ticks off the price grid with reason `price_off_grid` before anything is recorded or sent (the check sits in the proposal, so a bound plan with an averaged fill entry still works). A defect found while measuring: with the stop on grid, 1 in 16,000 fills still failed to bind because float noise in the cost reserve decided the tick; `planMomentumTargets` now computes the trigger and runner distances in whole ticks when the entry is on grid. N1: an averaged multi-deal fill whose bracket does not match now fails with its own reason ("entry fill off the price grid (multi-deal average): bracket not bound"), with the accept/refuse decision unchanged and the case carried to T2/T4. N2: new fixtures put broker prices a few units in the last place away from the plan's, so switching any of the five tick checks back to a float comparison makes a test fail. `docs/v3-momentum-entry-contract-2026-09-25.md` gains a T1b section; no production caller yet.

**Verification recorded** (PR or commit body).

- PR body, builder simulation: main after T1 refused 16,810 of 20,000 off-grid-stop fills at the bind (after the order was live); the branch refuses all 20,000 before sending, and stops built from `relativePoints` bind 20,000 of 20,000. Multi-deal averages: 0 of 20,000 bound when anchored to the average.
- PR body, builder: 7 affected files 70/70; 8 neighbour files 126/126; eslint clean; "each of the 8 fixes makes a named test fail when reverted" (the mutation table shows 6 rows before the body is truncated), sha256-restored.
- PR body, independent check: MERGE; 74/74 and 81/81; a 200,000-input differential of main's planner vs the branch: 199,152 identical, all 848 differences are reserves of a whole number of ticks plus ~1e-10.

<!-- details: Files of #1110: 9 (A 0 · M 9 · D 0), +480 / −10 -->
**Files of #1110: 9** (A 0 · M 9 · D 0), +480 / −10

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/services/momentum-entry-contract.js` | 10 | 2 |
| M | `agent/services/momentum-partial-manager.test.js` | 47 | 0 |
| M | `agent/services/momentum-plan-arithmetic.test.js` | 161 | 3 |
| M | `agent/services/momentum-rank-exit.test.js` | 18 | 0 |
| M | `agent/services/momentum-target-policy.js` | 54 | 3 |
| M | `agent/services/momentum-target-policy.test.js` | 82 | 1 |
| M | `agent/services/momentum-target-proposal.js` | 11 | 1 |
| M | `agent/services/momentum-target-proposal.test.js` | 27 | 0 |
| M | `docs/v3-momentum-entry-contract-2026-09-25.md` | 70 | 0 |
<!-- /details -->

<a name="pr-1111"></a>

### #1111 — Tick spool cap and reserve configurable from the environment; defaults unchanged (V3 GW-CAP)

- **Squash commit** `2dec514` · **merged** 25-09 22:18:24Z = 26-09 06:18:24 SGT · **services (inferred)** N, G · **head branch** `claude/v3-gwcap-spool-retention` (3 commits)
- **Plan item:** **V3 GW-CAP** (title), owner-approved 25-09 22:03 SGT ("ensure all cpp services passed"), to ship with X1 in the market-closed window. `docs/v3-integrated-plan-2026-09-26.md` §2 (on main) lists GW-CAP under group **P8**.

**What it did.** `cpp-exec/src/main.cpp` reads `TICK_SPOOL_CAP_BYTES` (at least one 64 MiB segment), `TICK_SPOOL_RESERVE_MIN_BYTES` and `TICK_SPOOL_RESERVE_PCT` (0–90) next to `TICK_SPOOL_PATH`, replacing the compiled-in 2 GiB cap (about 12 days of raw ticks); with no variable set nothing changes. Values are whole bytes or one binary unit (KiB, MiB, GiB, TiB); `GB`/`G` are refused as ambiguous, and a refused value keeps the default and logs a boot line naming the variable and reason, also shown in `/tick-status` `limits.refusals`. `/health` `tick.limits` and `/tick-status` `limits` report each limit, its source (`default`/`env`/`refused`), the reserve in bytes and `fitsMount` (counting the open segment's overshoot); boot lines name the largest cap that fits and flag a cap above 500 segments. In Node, `/state/tick-recorder` rate24h adds `spoolCapBytes` and `spoolHoursAtCap`, and two stale "2 GiB" comments are corrected; `cpp-exec/README.md` and `docs/tick-momentum/plan.md` document the variables. Planned values: cpp-exec 20 GiB, cpp-acct 5 GiB, set with `skipDeploys`.

**Verification recorded** (PR or commit body).

- PR body: `make -C cpp-exec test` 39/39 binaries; ThreadSanitizer 15/15, 0 warnings; `test_tick_recorder` 17 scenarios (6 new); cpp-verify "no order-writing symbols" clean; Node `tick-recorder-pull` 6/6 and related suites 155/155; 4 mutations, each caught by a failing test, restored byte-for-byte.
- PR body, independent check: MERGE, no blockers; nits: three docs still say the cap is fixed; rolling back to a smaller cap deletes sealed segments above it at the next boot; `fitsMount` can read false for up to 2 s near the boundary.
- Commit body, measured mounts (GET `/state/tick-recorder`, 14:40 UTC): demo 48.9 GB, 3 % used; at ~171–175 MB/day, 20 GiB ≈ 125 days and 5 GiB ≈ 30 days.

**Other records** (not the PR or commit body).

- Scratchpad `V3-SEQUENCE.md`, X1 window section: "Boots read back: cap [env] 20.00/5.00 GiB, telemetry on /data, 4/4 demo + 3/3 live, recording ON."
- `docs/v3-integrated-plan-2026-09-26.md` §2 (on main): "GW-CAP (**Passed**: 20 and 5 GiB, 04:59:21Z)".

**Notes.**

- Merge window: the PR body says merge only Fri 21:00–23:30 UTC; it merged Fri 25-09 22:18:24Z, inside the window.

<!-- details: Files of #1111: 11 (A 0 · M 11 · D 0), +807 / −16 -->
**Files of #1111: 11** (A 0 · M 11 · D 0), +807 / −16

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/routes/state.js` | 2 | 1 |
| M | `agent/services/heartbeat.js` | 15 | 3 |
| M | `agent/services/tick-readiness.js` | 3 | 2 |
| M | `agent/services/tick-recorder-pull.test.js` | 73 | 0 |
| M | `agent/services/tick-segments.js` | 8 | 1 |
| M | `cpp-exec/README.md` | 14 | 0 |
| M | `cpp-exec/src/main.cpp` | 35 | 3 |
| M | `cpp-exec/src/tests/test_tick_recorder.cpp` | 306 | 2 |
| M | `cpp-exec/src/tick_recorder.cpp` | 254 | 1 |
| M | `cpp-exec/src/tick_recorder.hpp` | 94 | 2 |
| M | `docs/tick-momentum/plan.md` | 3 | 1 |
<!-- /details -->

<a name="pr-1112"></a>

### #1112 — Scanner and cpp-verify relay; epoch-free scanner stream keys; scanner watchPatterns stop needless restarts (V3 CV-1)

- **Squash commit** `ac6bbb5` · **merged** 25-09 22:11:34Z = 26-09 06:11:34 SGT · **services (inferred)** N, V, S · **head branch** `claude/v3-cv1-verify-relay` (3 commits)
- **Plan item:** **V3 CV-1**; commit body "SEQUENCE PR-6"; PR body cites owner decision PR-6 (25-09 21:30 SGT: a change that restarts cpp-verify auto-merges once its gate passes). V3-SEQUENCE §1 queue (scratchpad `V3-SEQUENCE.md`, not committed on main) item 25, group **P5c**.

**What it did.** Both scanners (`cpp-scan-timeframe`, `cpp-scan-tick`) key streams without the feed epoch, so a new epoch or a Node restart rewarms the same stream instead of adding one; tables are bounded (timeframe 1024, tick 512) with stale eviction. This fixed the activation blocker reproduced with harness `chk/tfcap/cap.cpp` (690 cells: before, 512 admitted and 178 refused, then 0 admitted after a Node restart). The timeframe scanner's `/watchdog` now lists only cells with a job queued or running and counts idle cells in a `cells` block (1,574,543 B → 739 B at 1024 cells, under cpp-verify's 256 KiB limit). cpp-verify gains an entry-diagnostics relay (`src/entry_diagnostics.{hpp,cpp}`, stripped from the persisted watchdog state), Node adds a `scannerCollectorWork` item to the watchdog contract, and `ControllerRuntime.jsx` shows the relay table. Both scanner `railway.json` files gain `watchPatterns` (`cpp-scan-tick/**`, `cpp-scan-timeframe/**`) with a pin test, and `.github/workflows/cpp-scanners.yml` adds a ThreadSanitizer step.

**Verification recorded** (PR or commit body).

- PR body, builder: cpp-scan-tick `make all test` 3 binaries and `make tsan` clean; cpp-scan-timeframe 3 binaries; cpp-verify 8 binaries including `test_entry_diagnostics`; `nm` finds no order-writing symbols in the three binaries; Node 8 files 60/60; vitest 4/4; eslint clean; load script: tick 500 streams with no input lost, the next new stream refused at 512; timeframe 500 cells, the next refused at 1024. Six mutations (M1–M6), each applied by `grep -c` and caught by a failing test.
- PR body, independent check: MERGE; reproduced the harness "after" figures (690 admitted, 690 duplicates, 0 refused after a new epoch); `orderAuthority` stays false.

**Other records** (not the PR or commit body).

- Scratchpad `V3-SEQUENCE.md`, X1 window section: scanner activation, 796 profiles registered 22:31 (orderAuthority false); read back 22:35: bridge enabled, both sources reachable cross-region, timeframe cursor 15 (5 mirror, 10 no_signal), tick cursor 0 (market closed), controllers all ok, 26 positions.
- `docs/v3-integrated-plan-2026-09-26.md` §2 (on main): P5c row "CV-1 (**Passed**: `orderAuthority` false; tick cursor 0)".

<!-- details: Files of #1112: 36 (A 5 · M 31 · D 0), +1,199 / −88 -->
**Files of #1112: 36** (A 5 · M 31 · D 0), +1,199 / −88

| St | File | + | − |
|:-:|---|---:|---:|
| M | `.github/workflows/cpp-scanners.yml` | 2 | 0 |
| M | `agent/services/scanner-boundary.test.js` | 15 | 0 |
| A | `agent/services/scanner-collector-work.test.js` | 76 | 0 |
| M | `agent/services/scanner-integration.test.js` | 10 | 0 |
| M | `agent/services/scanner-work.js` | 38 | 0 |
| M | `agent/services/sidecar-pins.test.js` | 23 | 1 |
| M | `agent/services/watchdog-contract.js` | 4 | 2 |
| M | `cpp-scan-tick/Makefile` | 10 | 1 |
| M | `cpp-scan-tick/railway.json` | 5 | 1 |
| M | `cpp-scan-tick/src/scanner.cpp` | 87 | 17 |
| M | `cpp-scan-tick/src/scanner.hpp` | 20 | 3 |
| M | `cpp-scan-tick/src/scanner_contract.hpp` | 7 | 2 |
| M | `cpp-scan-tick/src/tests/test_scanner.cpp` | 91 | 2 |
| M | `cpp-scan-timeframe/railway.json` | 5 | 1 |
| M | `cpp-scan-timeframe/src/scanner.cpp` | 62 | 17 |
| M | `cpp-scan-timeframe/src/scanner.hpp` | 18 | 2 |
| M | `cpp-scan-timeframe/src/scanner_contract.hpp` | 7 | 2 |
| M | `cpp-scan-timeframe/src/tests/test_scanner.cpp` | 119 | 1 |
| M | `cpp-verify/README.md` | 48 | 6 |
| A | `cpp-verify/src/entry_diagnostics.cpp` | 125 | 0 |
| A | `cpp-verify/src/entry_diagnostics.hpp` | 24 | 0 |
| A | `cpp-verify/src/tests/fixtures/node-entry-activity.json` | 28 | 0 |
| A | `cpp-verify/src/tests/test_entry_diagnostics.cpp` | 105 | 0 |
| M | `cpp-verify/src/tests/test_watchdog.cpp` | 60 | 0 |
| M | `cpp-verify/src/tests/test_watchdog_http.cpp` | 14 | 1 |
| M | `cpp-verify/src/watchdog.cpp` | 12 | 4 |
| M | `cpp-verify/src/watchdog.hpp` | 16 | 0 |
| M | `cpp-verify/src/watchdog_state.cpp` | 22 | 3 |
| M | `docs/independent-watchdog-2026-09-22.md` | 7 | 0 |
| M | `docs/reporting-acceptance-2026-09-23.md` | 8 | 1 |
| M | `docs/shared-scanner-boundary-2026-09-22.md` | 26 | 11 |
| M | `docs/v3-acceptance-sequence-2026-09-23.md` | 5 | 0 |
| M | `docs/v3-scanner-operator-2026-09-23.md` | 11 | 0 |
| M | `scripts/v3-scanner-load-acceptance.mjs` | 20 | 9 |
| M | `src/components/ControllerRuntime.jsx` | 32 | 1 |
| M | `src/components/controller-groups.test.jsx` | 37 | 0 |
<!-- /details -->

<a name="pr-1113"></a>

### #1113 — Resting-order intents settle ACCEPTED, then on broker evidence; X1 record correction; symbol and bracket units (V3 X1)

- **Squash commit** `7986d6d` · **merged** 25-09 22:25:48Z = 26-09 06:25:48 SGT · **services (inferred)** N, G · **head branch** `claude/v3-x1-limit-intents` (4 commits)
- **Plan item:** **V3 X1** (W4, with W2 and W3 folded in), owner-approved for the market-closed window Fri 21:00–23:30 UTC. V3-SEQUENCE §1 queue (scratchpad `V3-SEQUENCE.md`, not committed on main) has a separate X1 section ("resting-order intents recorded FILLED at acceptance (found 25-09 10:25 UTC; gateway window)"). `docs/v3-integrated-plan-2026-09-26.md` §2 (on main) places X1 in the **REC, WEB** row.

**What it did.** New pure `agent/lib/order-answer.js` (`entryAnswerVerdict`) keeps the old rule for MARKET orders but settles a resting LIMIT/STOP/STOP_LIMIT intent as **ACCEPTED** ("placed, not filled") rather than FILLED — cTrader's ORDER_ACCEPTED for a resting order carries a pre-created position id, so every resting intent had been stored FILLED at placement; `exec-engine` `settleIntent` now takes the order type. The intent then settles only on broker evidence: an execution event for its order id (fill → FILLED, cancel → RELEASED, expiry → EXPIRED, reject → REJECTED), a tagged open position, or a bounded `ProtoOAOrderDetailsReq` read (new `wsGetOrderDetails`; at most 5 per account per pass, 6 per row), else it keeps ACCEPTED with the note "unresolved: no broker evidence" and stays out of exposure and money. A one-time correction (`services/intent-corrections.js`) moves the ~26 stored resting rows FILLED without fill evidence back to ACCEPTED, logging every step in new table `entry_intent_corrections` and deleting nothing; `GET /state/entry-intents` gains a `corrections` summary. W2 stores `symbolName` on every placeOrder payload (stripped before the wire); W3 stores `sl_units`/`tp_units` and `recordTradePlan` refuses a wrong-side or absurd-scale stop/target. Checker N2: an error event on an order the same pass's snapshot still lists is a failed cancel, not its outcome.

**Verification recorded** (PR or commit body).

- Commit body, defect evidence: `/state/order-lifecycle` ORD-04 at 15:00 UTC 25-09 — 25 rows FILLED with no fill evidence (e.g. `i7fgue8t2rgxx` CADJPY).
- PR body: independent check MERGE (no blockers); `entry-ledger.test.js` 33/33; the N2 test and its mutation (guard removed → named test failing). Known follow-ups N1, N4, N5 listed.
- Commit body: "Read back both gateways and every position afterwards." (an instruction; no result recorded in the body).

**Other records** (not the PR or commit body).

- Scratchpad `V3-SEQUENCE.md`, X1 window section: "#1113 X1 (22:26; + checker N2 fixed)"; boots read back "4/4 demo + 3/3 live, recording ON" (shared with GW-CAP).

**Notes.**

- **Contradiction on restarts.** The PR body says "No `cpp-*` files are touched, so there is no gateway restart. Node redeploys." The commit body says "agent/lib/exec-engine.js matches cpp-exec/railway.json watchPatterns, so this restarts BOTH broker gateways (cpp-exec demo and cpp-acct live), plus Node and (until CV-1) both scanners." The files confirm the commit body: `agent/lib/exec-engine.js` and `agent/lib/exec-engine.test.js` match the `agent/lib/exec-engine.*` watch pattern.
- Merge window: merged Fri 25-09 22:25:48Z, inside Fri 21:00–23:30 UTC.

<!-- details: Files of #1113: 19 (A 4 · M 15 · D 0), +1,401 / −27 -->
**Files of #1113: 19** (A 4 · M 15 · D 0), +1,401 / −27

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/db.js` | 34 | 0 |
| M | `agent/lib/ctrader-payload-types.js` | 5 | 0 |
| M | `agent/lib/ctrader-ws.js` | 23 | 1 |
| M | `agent/lib/exec-engine.js` | 37 | 9 |
| M | `agent/lib/exec-engine.test.js` | 85 | 0 |
| A | `agent/lib/order-answer.js` | 106 | 0 |
| A | `agent/lib/order-answer.test.js` | 88 | 0 |
| M | `agent/loop.js` | 37 | 0 |
| M | `agent/routes/actions.js` | 4 | 0 |
| M | `agent/services/closed-market-limits.js` | 9 | 6 |
| M | `agent/services/entry-ledger.js` | 255 | 9 |
| M | `agent/services/entry-ledger.test.js` | 214 | 0 |
| A | `agent/services/intent-corrections.js` | 195 | 0 |
| A | `agent/services/intent-corrections.test.js` | 166 | 0 |
| M | `agent/services/pending-orders.js` | 1 | 0 |
| M | `agent/services/reconciler.js` | 28 | 2 |
| M | `agent/services/reconciler.test.js` | 28 | 0 |
| M | `agent/services/trade-plans.js` | 51 | 0 |
| M | `agent/services/trade-plans.test.js` | 35 | 0 |
<!-- /details -->

<a name="pr-1114"></a>

### #1114 — Order writers record truthful lifecycle states (V3 L2a)

- **Squash commit** `d16355f` · **merged** 25-09 23:14:19Z = 26-09 07:14:19 SGT · **services (inferred)** N · **head branch** `claude/v3-l2a-order-writers` (6 commits)
- **Commit subject:** "Order writers record truthful lifecycle states; sweep never expires a ledger-FILLED row (V3 L2a)" (the heading is the GitHub PR title)
- **Plan item:** **V3 L2a** — LIFECYCLE-SPEC §7 writer fixes W5, W6, W7, W8, W9, W14 and the last W1 route (PR/commit body). `docs/v3-integrated-plan-2026-09-26.md` §2 (on main) places L1–L2b in the **REC, WEB** row.

**What it did.** W5: `reserveEntry` takes `riskEventId`, and a new `bindEntryIntent` wrapper puts the approval id on the intent and returns the intent id before the send (loop.js market dispatch, closed-market limit placement, pending placement); resting rows store the new `pending_orders.intent_id`, and the reconciler's approval lookup ignores case. W6: `trades.intent_id` is written on the write-ahead row before the send, on adopted fills (from the label tag) and on pending and linked limit fills. W7: a failed plan write leaves an `action_log` row `LEDGER /trade-plans/write-failed` instead of an empty catch. W8: `/actions/execute-trade` writes a `submitting` row with `account_id`, `strategy` and `risk_event_id` before sending, then promotes it or marks it `rejected` / `unconfirmed`. W9: a closed-market fill is linked to its trade by intent or position evidence only (the "first trade on this symbol since placement" rule is removed). W14: the engine status record gets `transitionSince`, which STK-07 v3 reads. A second commit (checker nit 1): the closed-market sweep no longer writes `expired` over a row whose intent the ledger settled FILLED from broker evidence (not from the placement answer alone). Node only; nothing in `agent/lib/exec-engine.*`.

**Verification recorded** (PR or commit body).

- PR body, builder: all 675 tests in touched and related files pass; eslint clean; every mutation caught by a failing test (table truncated in the PR body).
- PR body, independent check: MERGE, no blockers; two checker mutations, each caught by a failing test; 865 existing and new tests pass on the branch; no conflicts with `origin/main`.
- Commit body (second commit): probe on `61805fd` — intent FILLED (order_details, position 555), broker order gone, no trade → `{filled:0, expired:1}` before the fix; a test covers all three expiry paths plus the answer-only case, and its mutation (guard → false, grep 1 → 0) makes it fail.

**Notes.**

- The squash commit subject adds "; sweep never expires a ledger-FILLED row" to the GitHub title (see the title check below).

<!-- details: Files of #1114: 17 (A 1 · M 16 · D 0), +1,145 / −166 -->
**Files of #1114: 17** (A 1 · M 16 · D 0), +1,145 / −166

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/db.js` | 18 | 0 |
| M | `agent/lib/ctrader-creds.js` | 32 | 0 |
| M | `agent/lib/entry-contracts.js` | 9 | 0 |
| M | `agent/loop.js` | 28 | 6 |
| M | `agent/routes/actions.js` | 135 | 37 |
| M | `agent/services/closed-market-limits.js` | 197 | 67 |
| M | `agent/services/closed-market-limits.test.js` | 27 | 20 |
| M | `agent/services/entry-ledger.js` | 10 | 3 |
| M | `agent/services/entry-mode.js` | 30 | 1 |
| M | `agent/services/entry-mode.test.js` | 4 | 1 |
| M | `agent/services/order-lifecycle.js` | 14 | 7 |
| M | `agent/services/order-lifecycle.test.js` | 20 | 1 |
| A | `agent/services/order-writers-l2a.test.js` | 526 | 0 |
| M | `agent/services/pending-orders.js` | 21 | 8 |
| M | `agent/services/reconciler.js` | 41 | 13 |
| M | `agent/services/trade-plans.js` | 28 | 0 |
| M | `agent/services/trade-plans.test.js` | 5 | 2 |
<!-- /details -->

<a name="pr-1115"></a>

### #1115 — Stops attributed to their own account; roster-wide stops labelled separately (V3 WEB-1)

- **Squash commit** `666a26a` · **merged** 25-09 22:45:46Z = 26-09 06:45:46 SGT · **services (inferred)** N · **head branch** `claude/v3-web1-stop-attribution` (3 commits)
- **Plan item:** **V3 WEB-1**; **8,989-A row 2** (commit body).

**What it did.** `recordDecision` (`agent/services/decision-log.js`) no longer falls back to `getState('ctrader_account_id')`: a row that names no account is stored with NULL, and two lists separate account-independent stages (`ROSTER_ONLY_STAGES`: armed_scope_prefilter, cluster_conviction, horizon, regime_block, style_filter, watchlist_override, weekend_quiet; `ROSTER_STAGES` adds stage_matrix). A stage_matrix or lesson_decay row written with an account gets `detail.attribution='account'`, and `loop.js` now records the order's account on the lesson_decay skip. `blocker-report.js` classes every row `roster`, `unattributed` or `account`: an account's view counts only its own rows, roster-wide stops appear beside it as `rosterWide` without joining its totals, old stage_matrix/lesson_decay rows are flagged `unsplit`, and old rows are relabelled on read with `storedAccountId` kept (nothing stored is rewritten). `scanner-work.js` adds "roster-wide (every account): <stage> ×N of M" to the no-orders line, and `BlockerReport.jsx` shows a labelled roster-wide section, saying "not reported", never 0, when the agent sends none.

**Verification recorded** (PR or commit body).

- PR body, builder: touched tests 27/27; 11 existing files 173 tests, 169 pass, 1 fail (`scanner-integration.test.js` "600 registered profiles…", attributed to the shared `node_modules` still holding better-sqlite3 11.10.0 after #1106); 16 files 227/227; vitest 4/4; eslint clean.
- PR body, independent check: MERGE; every `recordDecision` call site that passes no account verified to be roster-level (line refs listed).

**Notes.**

- Departures from the roadmap row (PR body): lesson_decay is not roster-wide; regime_block is; old stage_matrix/lesson_decay rows cannot be split and stay under their stored account with a visible note.

<!-- details: Files of #1115: 9 (A 0 · M 9 · D 0), +368 / −46 -->
**Files of #1115: 9** (A 0 · M 9 · D 0), +368 / −46

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/loop.js` | 6 | 1 |
| M | `agent/routes/blocker-report-isolation.test.js` | 6 | 0 |
| M | `agent/services/blocker-report.js` | 117 | 29 |
| M | `agent/services/blocker-report.test.js` | 101 | 1 |
| M | `agent/services/decision-log.js` | 43 | 5 |
| M | `agent/services/decision-log.test.js` | 41 | 6 |
| M | `agent/services/scanner-work.js` | 8 | 2 |
| M | `src/components/BlockerReport.jsx` | 23 | 2 |
| M | `src/components/blocker-report.test.jsx` | 23 | 0 |
<!-- /details -->

<a name="pr-1116"></a>

### #1116 — Money written only from a complete lifecycle; partial closes carry their own volume (V3 B1)

- **Squash commit** `9cfb819` · **merged** 25-09 22:53:12Z = 26-09 06:53:12 SGT · **services (inferred)** N · **head branch** `claude/v3-b1-lifecycle-money` (4 commits)
- **Plan item:** **V3 B1** (title). V3-SEQUENCE §1 queue (scratchpad `V3-SEQUENCE.md`, not committed on main) item 5, group **P5b** (`docs/v3-integrated-plan-2026-09-26.md` §2 (on main): P5b/P5d).

**What it did.** (a) The 14-day window writes a position's money only when its opening deal is in the window and closed volume equals opened volume, otherwise it defers; (b) it writes only when exactly one closed row can hold the position, otherwise it reports the position ambiguous with its row ids; (c) the strict path ignores rejected or cancelled twins. (d) Deferred and ambiguous positions go to the per-position reader in the same pass, and an unpriced row closed more than 120 s before the broker's final closing deal is marked `rejected` with a `PNL_FALSE_CLOSE` audit row. (e) The money calculation moves to new `agent/lib/deal-money.js`; a bot FULL_EXIT writes its deal's money only if the deal closed everything opened, and NULL if any earlier partial is on record — including, after the fix round, a `position_events` row of kind `volume_reduced` that the reconciler now writes whenever the broker volume falls (manual partials in cTrader). (f) `POST /actions/broker-history` becomes display-only and reports `complete`, and `/reconcile-trades` pages its walk and rejects nothing unless it finished; (g) re-imports keep stored lots, the gross/swap split and a named symbol. The conversion fee stays out of net on both paths.

**Verification recorded** (PR or commit body).

- PR body, builder: new tests 24/24; 150/150 on touched files; 86/86 covering tests; vitest 10/10; UI inventory check up to date; eslint clean; six mutation checks per the builder (the table in the PR body is truncated after M5), each caught by a failing test, sha256-restored.
- PR body, independent check: FIX FIRST — a manual partial close in cTrader still let FULL_EXIT write partial-lifecycle money (the #714 defect). Fix round `b07fee4`: blocker and nits 1–5 fixed, nits 6–7 declined; identity check measured 79.0 → 0.8 ms (2,000 rows) and 916 → 5.4 ms (20,000 rows) on in-memory SQLite.

**Notes.**

- Declined N6/N7 are carried as follow-up F5 in `docs/v3-integrated-plan-2026-09-26.md`.

<!-- details: Files of #1116: 19 (A 3 · M 16 · D 0), +1,368 / −207 -->
**Files of #1116: 19** (A 3 · M 16 · D 0), +1,368 / −207

| St | File | + | − |
|:-:|---|---:|---:|
| A | `agent/lib/deal-money.js` | 130 | 0 |
| A | `agent/lib/deal-money.test.js` | 155 | 0 |
| M | `agent/lib/position-deal-history.js` | 68 | 3 |
| M | `agent/loop.js` | 19 | 6 |
| M | `agent/routes/actions.js` | 26 | 38 |
| M | `agent/services/broker-history-import.js` | 87 | 70 |
| M | `agent/services/broker-history-import.test.js` | 6 | 23 |
| M | `agent/services/cross-side-pnl.js` | 7 | 1 |
| M | `agent/services/cross-side-pnl.test.js` | 11 | 6 |
| M | `agent/services/old-position-pnl.js` | 44 | 11 |
| M | `agent/services/old-position-pnl.test.js` | 3 | 1 |
| M | `agent/services/pnl-backfill.js` | 221 | 23 |
| A | `agent/services/pnl-lifecycle-guard.test.js` | 517 | 0 |
| M | `agent/services/pnl-reconcile-stall.test.js` | 36 | 16 |
| M | `agent/services/reconciler.js` | 20 | 0 |
| M | `agent/services/trade-consistency.test.js` | 12 | 5 |
| M | `docs/ui-control-inventory.md` | 4 | 2 |
| M | `src/pages/Desk.jsx` | 1 | 1 |
| M | `src/pages/Trade.jsx` | 1 | 1 |
<!-- /details -->

<a name="pr-1117"></a>

### #1117 — Close writers record the cause they can prove (V3 L2b)

- **Squash commit** `f21531e` · **merged** 25-09 22:59:55Z = 26-09 06:59:55 SGT · **services (inferred)** N · **head branch** `claude/v3-l2b-close-writers` (4 commits)
- **Plan item:** **V3 L2b** — LIFECYCLE-SPEC writer fixes W10, W12, W13, W16, W17 (W11 left to V1 #1109; W15 awaits owner answer H-P5b-2). `docs/v3-integrated-plan-2026-09-26.md` §2 (on main) places L1–L2b in the **REC, WEB** row.

**What it did.** W10: a newer broker read no longer wipes values an earlier read stored — empty fields are filled from the stored row before the write and a `#<id>` placeholder never replaces a symbol name — and the P&L backfill and position capture store lots from the broker-declared lot size (`lib/lot-size-registry.js`), else NULL. W12: the close-cause reclassifier judges an exit against the latest stop on the newest monitored row ("stop loss hit … at a stop moved after entry", "locked" when moved to entry or beyond), and after the fix round "stopped beyond the SL" is judged against `loosestHeldStop`, the loosest stop the broker could have held. W13: the refusal scorer reads bars in both shapes (objects and arrays), and a loop pass `rescoreNoBarsRefusals` corrects stored `no_bars` rows in place (at most 2 bar reads per cycle, never at boot, keeping the original `scored_at`); after the fix round the fixed scorer marks its own rows `fetched …` so the pass never rewrites them. W16: one rule, `postmortemExemption` — a close with net P&L exactly 0 owes no postmortem (NULL is unknown, not flat), counted by `countFlatExemptCloses`. W17: the position record and the capture's deal window read the closed trade row first.

**Verification recorded** (PR or commit body).

- PR body, builder: `close-writers-l2b.test.js` 25/25; 29 covering test files 597/597; eslint clean; 10 mutations, each caught by a failing test, restored byte for byte.
- PR body, independent check: FIX FIRST — B1 (W13 pass rewrote rows the fixed scorer writes, with a false cause) and B2 (W12 judged against the manager's intended stop, not the broker's). Fix round `ae9d42b`: both blockers and four nits fixed; 581 tests in importing files pass; eslint clean.

<!-- details: Files of #1117: 15 (A 1 · M 14 · D 0), +951 / −38 -->
**Files of #1117: 15** (A 1 · M 14 · D 0), +951 / −38

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/lib/exit-replay.js` | 27 | 2 |
| M | `agent/lib/lot-size-registry.js` | 26 | 0 |
| M | `agent/loop.js` | 2 | 2 |
| M | `agent/services/broker-history-import.js` | 51 | 1 |
| M | `agent/services/close-completeness.js` | 26 | 1 |
| A | `agent/services/close-writers-l2b.test.js` | 516 | 0 |
| M | `agent/services/goal-table.js` | 4 | 4 |
| M | `agent/services/loss-postmortem.js` | 28 | 3 |
| M | `agent/services/order-lifecycle.js` | 4 | 4 |
| M | `agent/services/order-lifecycle.test.js` | 11 | 5 |
| M | `agent/services/pnl-backfill.js` | 4 | 1 |
| M | `agent/services/position-capture.js` | 3 | 3 |
| M | `agent/services/position-history.js` | 1 | 1 |
| M | `agent/services/reconciler.js` | 95 | 8 |
| M | `agent/services/refusal-ledger.js` | 153 | 3 |
<!-- /details -->

<a name="pr-1118"></a>

### #1118 — Server reads every account from the broker once a minute; pages stop polling (V3 WEB-4)

- **Squash commit** `4035a27` · **merged** 25-09 23:06:44Z = 26-09 07:06:44 SGT · **services (inferred)** N · **head branch** `claude/v3-web4-server-readings` (5 commits)
- **Plan item:** **V3 WEB-4**; **8,989-A rows 1 and 5** (commit body); owner default 25-09 (scratchpad `V3-SEQUENCE.md`: "WEB-4 server-side account readings every 60 s").

**What it did.** New `agent/services/broker-readings.js` runs a 60 s server timer, started from `startLoop`, that reads every account through the same read-only all-accounts builder the `/actions/broker-positions` route serves (moved byte-identical into a named function in `agent/routes/actions.js`) and through the route's shared cache, so a page read and a server read at once cost one broker round. At most one round runs at a time; the first waits for M1's first protection band or 3 minutes after boot; it does nothing on staging. Its record `broker_readings_last_json` moves `at` only when at least one account was read, naming failed or missing accounts with fixed reason words. A new controller `broker_readings` (35 → 36 controllers) expects a beat every 60 s with a 300 s record limit; `/state/account-overview` carries `serverReadings`; `src/lib/use-account-overview.js` only GETs the overview (no broker POST), and `CurrentAccountReadings.jsx` shows a caption and a notice when the server's reading failed, is partial or stale. `docs/v3-live-performance-2026-09-25.md`'s "no background broker scheduler" line is marked superseded.

**Verification recorded** (PR or commit body).

- PR body, defect live: a production GET of `/state/account-overview` at 16:29 UTC with no page open showed all 7 accounts `snapshot_stale`, last snapshot 13:30 UTC.
- PR body, builder: node 126/126 across 8 files; loop-wiring test 1/1; vitest 21/21; eslint clean; 3 mutations, each caught by a failing test (the page-poll mutation first kept passing under fake timers and the test was fixed to let real time pass).
- PR body, independent check: MERGE; `account_history` then holds one row per account per minute with no page open; keeping reads on the main thread is correct because `histBucket` (4/s historical limit) is one per process.

<!-- details: Files of #1118: 15 (A 6 · M 9 · D 0), +647 / −42 -->
**Files of #1118: 15** (A 6 · M 9 · D 0), +647 / −42

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/loop.js` | 6 | 0 |
| M | `agent/routes/actions.js` | 14 | 6 |
| M | `agent/services/account-overview.js` | 6 | 1 |
| A | `agent/services/broker-readings.js` | 218 | 0 |
| A | `agent/services/broker-readings.test.js` | 213 | 0 |
| M | `agent/services/controller-groups.test.js` | 1 | 1 |
| M | `agent/services/heartbeat.js` | 4 | 0 |
| M | `agent/shared/controller-groups.js` | 1 | 1 |
| M | `docs/v3-live-performance-2026-09-25.md` | 15 | 0 |
| M | `src/components/CurrentAccountReadings.jsx` | 4 | 2 |
| A | `src/components/current-account-readings.test.jsx` | 22 | 0 |
| A | `src/lib/server-readings.js` | 25 | 0 |
| A | `src/lib/server-readings.test.js` | 30 | 0 |
| M | `src/lib/use-account-overview.js` | 37 | 31 |
| A | `src/lib/use-account-overview.test.js` | 51 | 0 |
<!-- /details -->

<a name="pr-1119"></a>

### #1119 — Balance, carry and floating figures per recorded deposit currency (V3 WEB-3)

- **Squash commit** `7ec622e` · **merged** 25-09 22:27:45Z = 26-09 06:27:45 SGT · **services (inferred)** N · **head branch** `claude/v3-web3-balance-carry` (5 commits)
- **Plan item:** **V3 WEB-3**; **8,989-A rows 5 and 7** (commit body).

**What it did.** New `agent/services/balance-edges.js` gives the balance at an hour or window edge as the latest broker balance read at or before it and no more than 15 minutes older, with a real number, a stamped currency, no error and the account's registered host — never worked out from trade P&L — and otherwise a reason ("not stored before 22-09 17:26 UTC", "no broker read near edge", "not stored", or, after the last fix round, `observation_currency_mismatch` / "read not in SGD"). The hourly floating figure is the last floating reading stored in that hour. New `agent/shared/balance-carry.js` groups per recorded currency and gives a currency total only when every account in that currency has a reading, naming missing and unknown accounts; new `src/lib/balance-cells.js` and `Performance.jsx` fill Open bal / Close bal and the ledger's carry in / carry out. The merge-resolution round made WEB-7's recorded deposit currency the single source: `depositCurrencies` moved to new `agent/services/deposit-currencies.js` (re-exported), the balance reader and grouping key on it, and the live floating subtotal on All uses `liveFloatingByCurrency`. `agent/lib/one-account-model.test.js` gains the `balance-edges.js` host-routing allowlist entry and raises `Performance.jsx` to `isLive: 6`.

**Verification recorded** (PR or commit body).

- PR body, builder's production reads (GET, 24 h of balance history for …2148, …0058, …3489): 24 of 24 hourly edges had a reading, newest ≤ 3.0 min old; largest gap 7.4 min; floating readings in only 11–12 of 24 hours. Synthetic all-accounts hourly request 33–45 ms.
- PR body: first checker FIX FIRST (principle-1 test failing) → fix `efde63d`; merge-resolution round `a511456` (merge commit, no force-push); production check 15:42 UTC: all 7 accounts have a recorded currency (2 SGD, 5 USD); second checker FIX FIRST (B1 false "not stored" label; B2 untested live floating) → fix `969044d`: 30-day lookup 105 → 11 ms, All 196 → 54 ms (synthetic).
- PR body, targeted tests after the merge round: balance-edges 12/12, performance-populations 14/14, one-account-model 5/5, hourly-activity 3/3, report-unavailable 12/12, performance-calendar 4/4, vitest 12 files 79/79, eslint clean.

**Other records** (not the PR or commit body).

- Scratchpad `V3-SEQUENCE.md`, X1 window section lists #1119 WEB-3 among the window's merges.

<!-- details: Files of #1119: 16 (A 7 · M 9 · D 0), +1,207 / −70 -->
**Files of #1119: 16** (A 7 · M 9 · D 0), +1,207 / −70

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/lib/one-account-model.test.js` | 4 | 2 |
| A | `agent/services/balance-edges.js` | 228 | 0 |
| A | `agent/services/balance-edges.test.js` | 307 | 0 |
| A | `agent/services/deposit-currencies.js` | 33 | 0 |
| M | `agent/services/hourly-activity.js` | 15 | 1 |
| M | `agent/services/performance-populations.js` | 20 | 24 |
| A | `agent/shared/balance-carry.js` | 119 | 0 |
| M | `agent/shared/performance-populations.js` | 7 | 1 |
| A | `src/components/performance-balances.test.jsx` | 102 | 0 |
| A | `src/lib/balance-cells.js` | 73 | 0 |
| A | `src/lib/balance-cells.test.js` | 91 | 0 |
| M | `src/lib/current-account-totals.js` | 49 | 0 |
| M | `src/lib/current-account-totals.test.js` | 60 | 1 |
| M | `src/lib/hourly-activity.js` | 14 | 0 |
| M | `src/lib/hourly-order.js` | 7 | 6 |
| M | `src/pages/Performance.jsx` | 78 | 35 |
<!-- /details -->

<a name="pr-1120"></a>

### #1120 — veto-boundary fixture: the unknown-P&L close falls inside the current FX day (CI failed 21:00–23:00 UTC)

- **Squash commit** `74bb211` · **merged** 25-09 22:07:24Z = 26-09 06:07:24 SGT · **services (inferred)** N, S · **head branch** `claude/v3-fix-veto-fixture-fxday` (1 commit)
- **Commit subject:** "veto-boundary fixture: the unknown-P&L close falls inside the current FX day" (the heading is the GitHub PR title)
- **Plan item:** **Not stated.** A test-only CI fix; the PR body ties it to X1's CI (#1113) failing the same way.

**What it did.** The `(d) unknown_daily_pnl → redirected` fixture in `agent/services/veto-boundary.test.js` closed its trade 2 hours ago with a 1-minute grace. Because the FX day opens at 21:00/22:00 UTC, from then until 23:00 UTC that close fell into the previous day, the gate saw no unknown P&L today and approved the trade, so this test and the "list is exactly the guards" test after it failed on every CI run in that window. The fixture now closes the trade at `now` with `graceMin: 0`, so the close is always inside the current FX day. No product code changes.

**Verification recorded** (PR or commit body).

- PR body: measured 25-09 at 22:0x UTC, main fails it at `2e80f39`, `f9fc874`, `87620f3` and `ec4bc3c`. After the change `veto-boundary.test.js` 22/22 at 22:0x UTC (before: 20 pass, 2 fail).

**Notes.**

- The same change also sat on the branches of #1108, #1111 and #1112 (it appears in their GitHub file lists), and #1113's commit body carries it as a cherry-pick of `3baa796`; because #1120 merged first, none of those squash commits contains it.

<!-- details: Files of #1120: 1 (A 0 · M 1 · D 0), +5 / −2 -->
**Files of #1120: 1** (A 0 · M 1 · D 0), +5 / −2

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/services/veto-boundary.test.js` | 5 | 2 |
<!-- /details -->

<a name="pr-1121"></a>

### #1121 — Money per currency, never summed across currencies (V3 WEB-5)

- **Squash commit** `a23d234` · **merged** 25-09 23:03:36Z = 26-09 07:03:36 SGT · **services (inferred)** N · **head branch** `claude/v3-web5-per-currency` (4 commits)
- **Plan item:** **V3 WEB-5**; **8,989-A rows 5 and 7**, owner default 25-09 (commit body).

**What it did.** `agent/services/hourly-activity.js` stamps each account's recorded deposit currency on `moneyByAccount` (it was hard-coded null), using the same host-checked `depositCurrencies` as the populations report, and pools with `poolByCurrency` (exported from `agent/shared/performance-populations.js`) into `moneyByCurrency` and `unpooled` for the whole report and every hour; a currency with no priced close shows null, and an account with no recorded currency or a close with no account is counted unpooled. `reportLedger(report, 'all')` in `agent/shared/performance-populations.js` gives every window and market cell a `byCurrency` list and an `unpooled` count (grouped once per window after the fix round), with new exports `reportUnpooled`, `splitByCurrency` and `poolByCurrency` (the PR body also names a helper `reportCurrencies`, which does not occur in the squash commit's diff). New `src/lib/currency-money.js` (`validActivitySplit`, `currencyLines`, `activityCurrencyLines`, `currencyLinesText`, and `rollingSplits` from the fix round), and `src/lib/hourly-activity.js` `activityEvidence` rejects a split that does not add up exactly. `Performance.jsx` shows the rolling 24 hours and the timeframe ledger as one line per currency (e.g. "SGD −5.41 · USD −1.57"), each with its own "n of m priced" label and "n closes in no currency".

**Verification recorded** (PR or commit body).

- Commit/PR body, production report (GET `/state/performance-populations`, 15:17Z) run through the new `reportLedger`: Yesterday SGD −5.41, USD −1.57; 30D SGD +1,500.11, USD −4,989.88; last month SGD +228.07 (153 of 155 priced), USD −23,146.60 (696 of 711 priced); 3M 4 closes in no currency (rows with no account).
- PR body, builder: node 30/30; vitest 7 files 40/40; eslint clean; check-no-green OK; 3 mutations, each caught by a failing test, sha-restored.
- PR body, independent check: FIX FIRST (the rolling 24-hour card was not wired to the split). Fix round `622daf5`: output byte-identical on the production snapshot (sha256 `94b2b838…`); All-accounts median 24.0 → 13.8 ms.

<!-- details: Files of #1121: 10 (A 3 · M 7 · D 0), +932 / −40 -->
**Files of #1121: 10** (A 3 · M 7 · D 0), +932 / −40

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/services/balance-edges.test.js` | 50 | 0 |
| M | `agent/services/hourly-activity.js` | 32 | 7 |
| M | `agent/services/hourly-activity.test.js` | 167 | 0 |
| M | `agent/services/performance-populations.test.js` | 70 | 1 |
| M | `agent/shared/performance-populations.js` | 107 | 7 |
| A | `src/components/currency-lines.test.jsx` | 209 | 0 |
| A | `src/lib/currency-money.js` | 114 | 0 |
| A | `src/lib/currency-money.test.js` | 86 | 0 |
| M | `src/lib/hourly-activity.js` | 4 | 0 |
| M | `src/pages/Performance.jsx` | 93 | 25 |
<!-- /details -->

<a name="pr-1122"></a>

### #1122 — Data-feed card: bar receipts measured, not assumed (V3 WEB-9b)

- **Squash commit** `66a5318` · **merged** 25-09 22:42:42Z = 26-09 06:42:42 SGT · **services (inferred)** N · **head branch** `claude/v3-web9b-bar-receipts` (4 commits)
- **Plan item:** **V3 WEB-9b**; **8,989-A row 11** (commit body), with the row 10 wording fix.

**What it did.** New `agent/lib/feed-receipts.js` keeps a bounded in-memory record that never throws into its caller: per timeframe and per reader (strategy scan, pending scan, regime read, fast-monitor volume read, positions' daily bar, last-close read, other), the agent's receipt time, the newest bar's open time and whether it was still forming; and spot latency (agent receipt minus the broker's spot timestamp) per broker host over 10 minutes, treating the first event per subscription as a snapshot and counting unstamped and ±60 s events separately. New `agent/services/feed-receipts-record.js` reloads the record from agent_state `data_feed_receipts_json` at boot and saves it at most once a minute when changed. `ctrader-ws.js` records receipts in `wsGetTrendbarsBatch` (only windows that end now), `wsGetDailyOhlcv` (1D) and `wsGetLastCloses` (1m), with a new `opts.purpose` passed by `fib-strategy.js` and `fast-monitor.js`; `/stream-prices` subscribes with `timestamped: true` and frames carry `receivedAtMs` and `brokerAtMs`. `/state/data-feed` gains `barReceipts` and `feedLatency`, and `NOT_MEASURED` now lists only the gateways' tick-feed latency; the card's chips show receipt age and the quote tooltip reads "Agent receipt … · broker time …". The fix round keeps a 4,000-event list per host with truncation marking, and prints "stream open, 0 latency samples: …" instead of a false "no stream" reason.

**Verification recorded** (PR or commit body).

- PR body, builder: node 25/25 on new and touched files; 2 mutations, each caught by a failing test, restored byte-for-byte (one unrelated environment failure noted).
- PR body, independent check: FIX FIRST (the latency line could show a false reason). Fix round `d51f85a`: node 18/18; vitest 39/39; eslint clean.

<!-- details: Files of #1122: 19 (A 6 · M 13 · D 0), +1,251 / −22 -->
**Files of #1122: 19** (A 6 · M 13 · D 0), +1,251 / −22

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/index.js` | 4 | 0 |
| M | `agent/lib/ctrader-ws.js` | 17 | 4 |
| A | `agent/lib/feed-receipts-wiring.test.js` | 115 | 0 |
| A | `agent/lib/feed-receipts.js` | 352 | 0 |
| A | `agent/lib/feed-receipts.test.js` | 183 | 0 |
| M | `agent/routes/actions.js` | 22 | 3 |
| M | `agent/routes/data-feed-route.test.js` | 27 | 1 |
| M | `agent/routes/state.js` | 10 | 0 |
| A | `agent/routes/stream-prices-feed-latency.test.js` | 94 | 0 |
| M | `agent/services/data-feed-report.js` | 8 | 2 |
| M | `agent/services/fast-monitor.js` | 1 | 1 |
| A | `agent/services/feed-receipts-record.js` | 68 | 0 |
| A | `agent/services/feed-receipts-record.test.js` | 40 | 0 |
| M | `agent/services/fib-strategy.js` | 5 | 3 |
| M | `src/components/PerfMacroSections.jsx` | 10 | 5 |
| M | `src/components/data-feed-card.test.jsx` | 35 | 0 |
| M | `src/lib/data-feed.js` | 143 | 0 |
| M | `src/lib/data-feed.test.js` | 115 | 1 |
| M | `src/pages/Performance.jsx` | 2 | 2 |
<!-- /details -->

<a name="pr-1123"></a>

### #1123 — Report follow-ups from the M2 check (V3 M2b)

- **Squash commit** `db119ef` · **merged** 25-09 23:05:55Z = 26-09 07:05:55 SGT · **services (inferred)** N
- **Plan item:** V3 M2b. The commit body says: "Follow-ups to M2 (#1089) and A1 (#1090), from their checker reports" (M2 nits 1–6, 8, 9; A1 nits 1–2). M2 is V3-SEQUENCE §1 item 4 and A1 is item 1. The integrated plan's §2 lists M2b under group P1/P4.

**What it did.**

- Report-worker failures with no named code now put the driver's message in the 503 body as `detail` (bounded to 300 chars) and are logged at most once a minute per route and message.
- Fixed `*_bound` reasons are marked not retryable: no Retry-After, `retryable: false`.
- Five older routes (`/watchdog`, `/postmortems`, `/account-engineering`, `/performance-populations`, `/blocker-report`) now go through the same typed 503 form (`sendReportUnavailable`).
- `/state/storage` now answers inside its 50 s deadline with a `partial` body: unmeasured figures are null and named. The walk keeps going (bounded at 180 s) and is served from a 5-minute cache. It stops through a shared cooperative flag, never `Worker.terminate()`, which was shown to abort the process inside better-sqlite3.
- The agent test gate moved into `scripts/agent-gate.mjs` with a canary child: a gate whose children do not inherit the private TMPDIR fails as "BLIND".
- `count-interactions.test.js` stopped leaking 11 temp directories per run.

**Verification recorded** (PR or commit body).

- Builder: `node --test` 8 files 51/51; order-lifecycle-route and stage-matrix 36/36; vitest 4 files 37/37.
- Mutations: the partial answer disabled (2 deadline tests failing); `detail` dropped (13 route tests failing); `env` dropped from the gate spawn (3 of 5 gate tests failing, "BLIND").
- Independent check: **MERGE**, node 18 files 150/150.
- No post-merge production read-back is recorded in the commit or PR.

<!-- details: Files of #1123: 20 (A 3 · M 17 · D 0), +1,154 / −147 -->
**Files of #1123: 20** (A 3 · M 17 · D 0), +1,154 / −147

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/routes/account-engineering-isolation.test.js` | 4 | 1 |
| M | `agent/routes/actions.js` | 17 | 3 |
| M | `agent/routes/blocker-report-isolation.test.js` | 9 | 2 |
| M | `agent/routes/postmortem-isolation.test.js` | 4 | 1 |
| M | `agent/routes/report-unavailable.test.js` | 126 | 22 |
| M | `agent/routes/state.js` | 48 | 10 |
| A | `agent/routes/storage-purge.test.js` | 61 | 0 |
| M | `agent/routes/watchdog-isolation.test.js` | 6 | 0 |
| M | `agent/services/performance-populations.js` | 211 | 28 |
| M | `agent/services/report-unavailable.test.js` | 152 | 15 |
| M | `agent/services/storage-report.js` | 143 | 42 |
| M | `agent/services/storage-report.test.js` | 87 | 0 |
| A | `scripts/agent-gate.mjs` | 66 | 0 |
| A | `scripts/agent-gate.test.js` | 94 | 0 |
| M | `scripts/count-interactions.test.js` | 13 | 1 |
| M | `scripts/run-agent-tests.mjs` | 7 | 18 |
| M | `src/lib/agent-api.js` | 11 | 2 |
| M | `src/lib/agent-api.test.js` | 37 | 0 |
| M | `src/lib/latest-prices.js` | 27 | 2 |
| M | `src/lib/latest-prices.test.jsx` | 31 | 0 |
<!-- /details -->

<a name="pr-1124"></a>

### #1124 — Close recovery for momentum partial and rank-exit closes (V3 T2)

- **Squash commit** `f352751` · **merged** 25-09 22:35:56Z = 26-09 06:35:56 SGT · **services (inferred)** N
- **Plan item:** V3 T2 (commit: "V3 T2, P0-1b"). This is V3-SEQUENCE §1 item 7, group P0/P3.

**What it did.**

- The momentum partial manager and the rank exit no longer stop at AMBIGUOUS when a close is answered ORDER_ACCEPTED with no deal. They store the broker order id on the SENDING / RANK_SENDING row and resolve the attempt from the position's deal history.
- A deal counts only with a strict match: the same order id, account, position and symbol, the opposite side, the entry in ticks, the exact volume, a time at or after `attempted_at − 2 s`, `hasMore` false, and exactly one qualifying deal.
- NOT_EXECUTED is declared only after a 50 s transport horizon (20 s gateway + 20 s JS fallback + 10 s grace), from a full-volume read taken after it.
- Failed closes are classified: not sent returns the row to ARMED; a broker error code is REJECTED; an absence read gives CLOSED_EXTERNALLY; an external partial is VOLUME_CHANGED.
- A new `momentum-exit-coordination.js` has the loss cap and the profit-ratchet flatten defer only while a SENDING / RANK_SENDING claim is under 50 s old (fix-round B1). `/position-close` and `/position-reverse` answer 409 while SENDING, AMBIGUOUS or RANK_SENDING.
- The fake broker gained deal history, ORDER_ACCEPTED-with-dropped-fill and gateway-timeout modes.

**Verification recorded** (PR or commit body).

- A test written first fails on main with `{"state":"AMBIGUOUS","reason":"closing_deal_unconfirmed"}` and passes with T2.
- Stated production effect: none. `GET /state/momentum-targets?all=1` read `recordedPlans: 0` at 25-09 15:20 UTC.
- Builder: 9 momentum files 83/83; callers 194/194.
- Independent check: **FIX FIRST** (the protective deferral had no time bound, so it could defer indefinitely), then a fix round (`ee63c7f`) fixed it plus N1–N6.
- Also diagnosed: the 24-09 21:05 UTC "KO.US: close failed — MARKET_CLOSED" comes from `momentum-account.js exitDroppedHoldings`. It is recorded in the doc, not changed.
- No post-merge read-back in the commit or PR.

<!-- details: Files of #1124: 16 (A 3 · M 13 · D 0), +2,062 / −97 -->
**Files of #1124: 16** (A 3 · M 13 · D 0), +2,062 / −97

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/lib/ctrader-ws.js` | 5 | 0 |
| M | `agent/lib/ctrader-ws.test.js` | 50 | 0 |
| M | `agent/routes/actions.js` | 8 | 0 |
| M | `agent/services/loss-cap.js` | 7 | 0 |
| M | `agent/services/momentum-broker-evidence.js` | 149 | 1 |
| M | `agent/services/momentum-broker-evidence.test.js` | 96 | 2 |
| A | `agent/services/momentum-close-recovery.test.js` | 609 | 0 |
| A | `agent/services/momentum-exit-coordination.js` | 78 | 0 |
| A | `agent/services/momentum-exit-coordination.test.js` | 239 | 0 |
| M | `agent/services/momentum-partial-broker.js` | 37 | 10 |
| M | `agent/services/momentum-partial-manager.js` | 225 | 35 |
| M | `agent/services/momentum-rank-exit.js` | 195 | 33 |
| M | `agent/services/momentum-rank-exit.test.js` | 4 | 0 |
| M | `agent/services/profit-ratchet.js` | 7 | 0 |
| M | `agent/test-support/fake-broker.js` | 160 | 16 |
| M | `docs/v3-momentum-exit-coordination-2026-09-25.md` | 193 | 0 |
<!-- /details -->

<a name="pr-1125"></a>

### #1125 — Stuck headline counts every violation: unattributed rows beside a scoped account, controllers on their own line (V3 L1c)

- **Squash commit** `534ae6c` · **merged** 25-09 22:27:29Z = 26-09 06:27:29 SGT · **services (inferred)** N
- **Plan item:** V3 L1c, a follow-up to the order-lifecycle report (L1 #1095 / L1b #1097). It was rebuilt on main after I3 (#1108). It is not an item row in the V3-SEQUENCE §1 table. The integrated plan's §2 groups it under "REC, WEB: L1–L2b".

**What it did.**

- In a report scoped to one account, `runRule` used to drop every no-account violation before `summarise` saw it. A stalled controller (STK-11, e.g. `pnl_reconcile`) or an unattributed outbox row therefore never reached the stuck headline: 19 scoped against 60 for all accounts.
- `runRule` now keeps those violations "beside" the account. It still never credits them to the account.
- `summarise` counts them in every stage headline, split into `records`, `unattributed` and `controllers` (with `controllerNames`), and `accounts[]` gains a `controllers` line.
- The notes, goal row and daily line read e.g. "20 stuck — 19 account record(s) · controllers: 1 stalled (pnl_reconcile: error)".
- `HELPERS_VERSION` went 3 → 4, re-pinned at `758feead1efec1bd`. No rule hash moved.

**Verification recorded** (PR or commit body).

- Production symptom quoted: the scoped report read `summary.stuck.new = 19` while STK-11 held `pnl_reconcile` and STK-08 held an outbox.
- Differential: 320 checks over 5 scopes × 3 fixtures; `rules[]`, `stages[]` and the old all-accounts summary fields are identical.
- `order-lifecycle.test.js` 87/87. Independent check: **MERGE**.
- No post-merge read-back in the commit or PR.

<!-- details: Files of #1125: 2 (A 0 · M 2 · D 0), +266 / −25 -->
**Files of #1125: 2** (A 0 · M 2 · D 0), +266 / −25

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/services/order-lifecycle.js` | 116 | 23 |
| M | `agent/services/order-lifecycle.test.js` | 150 | 2 |
<!-- /details -->

<a name="pr-1126"></a>

### #1126 — Goal rows marked proposed and a read-only acceptance harness (V3 M3)

- **Squash commit** `fee2ce6` · **merged** 25-09 23:26:49Z = 26-09 07:26:49 SGT · **services (inferred)** N
- **Plan item:** V3 M3 (commit: "V3 M3, P1/P4-3"). This is V3-SEQUENCE §1 item 17, group P1/P4.

**What it did.**

- Four new goal rows: `startup_window`, `event_loop_lag`, `protection_freshness` and `loop_latency`. They are graded from the persisted boot record and the raw audit and verifier timestamps, never from a heartbeat verdict.
- Until the owner stamps `p1p4LimitsConfirmedAt`, these rows read `proposed`, with a `proposedVerdict`, and are counted in `summary.proposed`, not in off_track.
- A new pure grader (`p1p4-grade.js`) gives Passed, Failed or Not Verifiable per criterion for the startup window, the 300 s recovery and the steady state.
- A new GET-only harness (`scripts/v3-p1p4-acceptance.mjs`) uses the read token only and refuses the write token.
- Fix rounds:
  - recovery grades only this boot's readings;
  - p99 is graded strictly below the limit from the histogram bound;
  - `endedBefore()` names a boot that the next restart replaced;
  - the harness doc moved to its own file, to avoid a conflict with M5.

**Verification recorded** (PR or commit body).

- First production round (87620f3 boot): startup lag 14,701 ms Failed; fast-monitor skip 19.5 % and tick max 6,491 ms Failed; no visible tab.
- Harness running record: boot stalls of 15,663 ms (ec4bc3c), 7,041 ms (74bb211), 61,593 ms (169d337, #1108) and 26,894 ms (ac6bbb5), all Failed.
- One `/state/goal-table` read took 12,520 ms, so the harness reads `/health` instead by default.
- Mutations A–C failed.
- Independent check: **FIX FIRST**. Recovery could pass on readings from before the restart. Fixed.
- Harness state: PID 10750, started 22:05:53Z with `--hours 72`.
- The integrated plan's §2, a later document, records "M3's harness is not running" after the ~04:56Z container restart (last record 04:48:32Z).

<!-- details: Files of #1126: 10 (A 4 · M 6 · D 0), +3,191 / −13 -->
**Files of #1126: 10** (A 4 · M 6 · D 0), +3,191 / −13

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/routes/goal-table-routes.test.js` | 39 | 4 |
| M | `agent/services/daily-report.js` | 10 | 1 |
| M | `agent/services/daily-report.test.js` | 23 | 1 |
| M | `agent/services/goal-table.js` | 225 | 3 |
| M | `agent/services/goal-table.test.js` | 185 | 4 |
| A | `agent/services/p1p4-grade.js` | 1,095 | 0 |
| A | `agent/services/p1p4-grade.test.js` | 898 | 0 |
| M | `docs/v3-p1p4-acceptance-2026-09-25.md` | 5 | 0 |
| A | `docs/v3-p1p4-harness-2026-09-25.md` | 367 | 0 |
| A | `scripts/v3-p1p4-acceptance.mjs` | 344 | 0 |
<!-- /details -->

<a name="pr-1127"></a>

### #1127 — Shadow restart-loss count can fire, read from the old boot's open count (V3 Q0)

- **Squash commit** `bb73568` · **merged** 25-09 23:26:51Z = 26-09 07:26:51 SGT · **services (inferred)** N
- **Plan item:** V3 Q0. This is V3-SEQUENCE §1 item 10 ("§1 item 10", in the checker's words), group P6/P7.

**What it did.**

- The heartbeat probe runs `pullTickStatus` before `pullTickShadow`. On the probe that first sees a sidecar restart, the stored status already belonged to the new boot (open 0), so the shadow wrote 0 `lost_restart` rows every time. The SHADOW_PASSED "resets ≤ 20 %" check could therefore never fail.
- `pullTickStatus` now keeps `shadowOpenByBoot`: the last observed open count per shadow-ledger `bootId`, for up to 8 boots, seeded from the previous record.
- `pullTickShadow` writes lost rows from the old boot's last observed count.
- A boot whose count was never observed writes nothing and logs UNKNOWN (`restart.lost` null), never a silent 0.
- Trades the old boot closed after the reading are reported as `closedAfterObservation`, not netted.

**Verification recorded** (PR or commit body).

- Production before the fix (GET, 25-09 16:52 UTC): `/state/tick-shadow` showed 100 demo boots and 35 live boots, lost 0, `resetSharePct` 0.
- The new test drives the real `probeOneSidecar`. 3 open trades give 3 `lost_restart` rows and a 42.9 % reset share.
- Tests: 14/14 and 126/126. Mutations A/B/C failed.
- Independent check: **MERGE**, no blockers.
- The integrated plan's §2 records Q0 as "not verifiable until a sidecar restart".

<!-- details: Files of #1127: 3 (A 1 · M 2 · D 0), +273 / −6 -->
**Files of #1127: 3** (A 1 · M 2 · D 0), +273 / −6

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/services/heartbeat.js` | 77 | 4 |
| A | `agent/services/tick-shadow-restart-loss.test.js` | 192 | 0 |
| M | `agent/services/tick-shadow.test.js` | 4 | 2 |
<!-- /details -->

<a name="pr-1128"></a>

### #1128 — Tick replayer models the four live entry filters, firer or book model (V3 Q3)

- **Squash commit** `f38bf59` · **merged** 25-09 23:27:42Z = 26-09 07:27:42 SGT · **services (inferred)** N
- **Plan item:** V3 Q3 (commit: "V3 Q3, P6/P7"). This is V3-SEQUENCE §1 item 20, group P6/P7.

**What it did.**

- The tick replayer models the four live entry filters:
  - the stop floor, `llround(minStopFraction × entry)`;
  - the price bound, `floor(overshootFraction × stop)` against the signal's own quote;
  - the counter-trend veto, using the regime reading as of the signal time;
  - an optional signal TTL.
- Values come only from `loadTickEntryConfig` and the regime gate. A research request can only switch filters on; any value it sends is refused with a 400.
- The filter block is part of the trial id and the sim hash, and the regime rows are pinned by digest.
- Two stamped models:
  - `firer` (default): the book fills, the firer refuses;
  - `book`: a refused signal frees the book.
- A filtered trial cannot pass the replay rung while `tick-shadow-sim.json` carries no matching block.
- Fix round: regime rows are read in 500-row pages that yield to the event loop, which fixes checker blocker B2 (an event-loop stall). `liveFilters: true` turns on only the three filters the gateway runs.

**Verification recorded** (PR or commit body).

- Builder: Q3 files 34/34 and existing tests 141/141. Checker: 240/240.
- Fix round, re-measured on a synthetic table shaped like production (565k regime rows, 85 symbols, 53 tick symbols): longest loop turn 8–20 ms, p99 under 8 ms.
- The "Independent check" in the PR body is of the earlier r1 build (`37f725e`), verdict **MERGE**.
- The fix-round section then fixes "both blockers" from a check of r2: B1, an allowlist entry, and B2, the event-loop stall.
- No production read-back.

<!-- details: Files of #1128: 9 (A 1 · M 8 · D 0), +1,436 / −54 -->
**Files of #1128: 9** (A 1 · M 8 · D 0), +1,436 / −54

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/lib/one-account-model.test.js` | 1 | 0 |
| M | `agent/lib/tick-replay-sim.js` | 283 | 15 |
| M | `agent/lib/tick-replay-sim.test.js` | 235 | 0 |
| A | `agent/services/tick-replay-live-filters.test.js` | 426 | 0 |
| M | `agent/services/tick-replay-parity.js` | 9 | 1 |
| M | `agent/services/tick-research-run.js` | 393 | 20 |
| M | `agent/services/tick-shadow-counterfactual.js` | 57 | 14 |
| M | `agent/services/tick-validation.js` | 27 | 2 |
| M | `scripts/tick-research.mjs` | 5 | 2 |
<!-- /details -->

<a name="pr-1129"></a>

### #1129 — Calendar coverage per account: tiered demand, each calendar carried once (V3 K1)

- **Squash commit** `6d2aca7` · **merged** 25-09 23:31:45Z = 26-09 07:31:45 SGT · **services (inferred)** N
- **Plan item:** V3 K1. This is V3-SEQUENCE §1 item 11, group P2.

**What it did.**

- The watchdog calendar demand is now tiered, so the 512-identity cap bites in priority order: gateway feeds, then every held position (paused and external included), then the bar scan's instruments, then scope. Scope is each account's own map, merged name by name with the tick receipts.
- A calendar already in the contract's `calendars` export is carried once. The work item drops its copy (`calendarIn: 'calendars'`), and cpp-verify fills it in by account, host and symbol id.
- `calendarsComplete` keeps its meaning; `demandComplete` and `exportComplete` are added beside it.
- The old holiday reason is split into `holiday_bounds_omitted` and `holiday_bounds_invalid`.
- New `GET /state/calendar-coverage`, served by the report worker; `/state/market-calendar` adds `unresolvedHolidays` (at most 366).
- Skipped collector passes persist their reason and since-when.

**Verification recorded** (PR or commit body).

- Contract size:

  | Load | origin/main | K1 |
  |---|---|---|
  | C4's realistic load | 248,860 B | 164,037 B |
  | K1's realistic load (413 identities) | over 256 KiB, `work` emptied | 223,426 B, `work` intact, 112/112 feed calendars exported |

- Tests: 94 run, 90 pass, 3 skip, 1 fail. The failure is the known better-sqlite3 11.10 environment test, "600 registered profiles…".
- Checker: 133 run, 129 pass. Verdict **MERGE**.
- The integrated plan's §2 records K1, K1b, K1c and K2 as **Passed**: 136 of 136 calendars; 7 of 7 maps; 05:04Z.

<!-- details: Files of #1129: 14 (A 2 · M 12 · D 0), +1,135 / −70 -->
**Files of #1129: 14** (A 2 · M 12 · D 0), +1,135 / −70

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/lib/calendar-intervals.js` | 20 | 0 |
| M | `agent/lib/one-account-model.test.js` | 1 | 1 |
| M | `agent/routes/state.js` | 22 | 3 |
| A | `agent/services/calendar-coverage.js` | 206 | 0 |
| A | `agent/services/calendar-coverage.test.js` | 384 | 0 |
| M | `agent/services/market-calendar.js` | 90 | 5 |
| M | `agent/services/market-calendar.test.js` | 61 | 0 |
| M | `agent/services/performance-populations.js` | 9 | 0 |
| M | `agent/services/scanner-integration.test.js` | 13 | 2 |
| M | `agent/services/scanner-work.js` | 47 | 12 |
| M | `agent/services/watchdog-calendar-refresh.js` | 131 | 40 |
| M | `agent/services/watchdog-calendar-refresh.test.js` | 111 | 2 |
| M | `agent/services/watchdog-contract.js` | 34 | 4 |
| M | `agent/services/watchdog-contract.test.js` | 6 | 1 |
<!-- /details -->

<a name="pr-1130"></a>

### #1130 — Tick segment manifest with names and bytes; per-side durability policy (V3 R1)

- **Squash commit** `06955ff` · **merged** 25-09 23:31:48Z = 26-09 07:31:48 SGT · **services (inferred)** N
- **Commit subject differs from the PR title:** "Tick segment manifest with names and bytes; spool durability policy (V3 R1) (#1130)".
- **Plan item:** V3 R1 (P8). This is V3-SEQUENCE §1 item 16, group P8.

**What it did.**

- `/state/tick-segments` now lists every sealed segment per side, with name and bytes, plus the heartbeat's manifest.
- On every probe, the heartbeat reconciles the listing into two new tables, `tick_segment_manifest` and `tick_segment_boots`.
- A segment that stops being listed is classed as retired, lost at a restart, or unexplained, by oldest-first order plus the cap arithmetic. A restart is judged under the policy of the boot before it.
- A per-side durability policy is declared in the new `agent/config/tick-spool-durability.json`:
  - demo is DURABLE, with a cap of 20 GiB from the environment;
  - live is DURABLE from 2026-09-25T21:54:00Z, when the volume was attached.
- Each restart row records `torn_at_start`.
- The runtime manifest shows each sidecar's own recorder, and the misleading "tick engine not configured" note is corrected.
- `retention.js` gains `tickStatusSamplesDays`, off (null) by default.

**Verification recorded** (PR or commit body).

- X1 read-back used for the policy: demo listed the same 10 sealed segments (671,088,720 B) at 16:49 and 22:50 UTC.
- `GET /state/tick-recorder` at 22:49 UTC: the live spool `/data/tick` is on a 48,891,670,528 B mount at 0 % used; the cap reads 5 GiB from the environment.
- Independent check of r2: no blockers, merge recommended.
- The integrated plan's §2 records R1 as **Passed**.

<!-- details: Files of #1130: 14 (A 3 · M 11 · D 0), +1,171 / −14 -->
**Files of #1130: 14** (A 3 · M 11 · D 0), +1,171 / −14

| St | File | + | − |
|:-:|---|---:|---:|
| A | `agent/config/tick-spool-durability.json` | 22 | 0 |
| M | `agent/db.js` | 57 | 0 |
| M | `agent/routes/state.js` | 3 | 2 |
| M | `agent/routes/tick-readiness-routes.test.js` | 40 | 0 |
| M | `agent/services/heartbeat.js` | 15 | 1 |
| M | `agent/services/retention.js` | 18 | 0 |
| M | `agent/services/retention.test.js` | 29 | 0 |
| M | `agent/services/runtime-manifest.js` | 50 | 5 |
| M | `agent/services/runtime-manifest.test.js` | 46 | 1 |
| A | `agent/services/tick-segment-manifest.js` | 409 | 0 |
| A | `agent/services/tick-segment-manifest.test.js` | 377 | 0 |
| M | `agent/services/tick-segments.js` | 49 | 3 |
| M | `agent/services/tick-segments.test.js` | 55 | 1 |
| M | `docs/tick-momentum/readiness-register.csv` | 1 | 1 |
<!-- /details -->

<a name="pr-1131"></a>

### #1131 — Tick docs match GW-CAP and the cpp-acct volume; ledger write-back

- **Squash commit** `ff031b7` · **merged** 25-09 23:44:49Z = 26-09 07:44:49 SGT · **services (inferred)** N
- **Plan item:** No V3 id is stated. It is a docs follow-up to GW-CAP (#1111) and the X1 window, plus the CLAUDE.md §1 ledger write-back.

**What it did.**

- Docs only.
- `docs/tick-momentum/README.md` and `option-2-observation-rollout.md` now say the spool cap and reserve are read at boot from `TICK_SPOOL_CAP_BYTES`, `TICK_SPOOL_RESERVE_MIN_BYTES` and `TICK_SPOOL_RESERVE_PCT`, not "fixed in code". Production is set to 20 GiB on cpp-exec and 5 GiB on cpp-acct.
- The docs record that cpp-acct's `/data` volume was created at 50 GB against the 10 GB the owner approved, and flag that to the owner.
- A rollback caution is added: lowering or unsetting the cap deletes the oldest sealed segments above the new cap at the next boot (`tick_recorder.cpp:564`, `:703-718`).
- `readiness-register.csv` TM-27 gets a dated update and stays PARTIAL.
- CLAUDE.md gains the §1 ledger write-back: 187 replies after № 9,232.

**Verification recorded** (PR or commit body).

 none. Docs only; the PR body says "Merging redeploys Node once".

<!-- details: Files of #1131: 4 (A 0 · M 4 · D 0), +34 / −6 -->
**Files of #1131: 4** (A 0 · M 4 · D 0), +34 / −6

| St | File | + | − |
|:-:|---|---:|---:|
| M | `CLAUDE.md` | 16 | 0 |
| M | `docs/tick-momentum/README.md` | 2 | 2 |
| M | `docs/tick-momentum/option-2-observation-rollout.md` | 15 | 3 |
| M | `docs/tick-momentum/readiness-register.csv` | 1 | 1 |
<!-- /details -->

<a name="pr-1132"></a>

### #1132 — Partial manager runs every loop with a truthful status and UI (V3 T3)

- **Squash commit** `b9ec5ad` · **merged** 25-09 23:44:45Z = 26-09 07:44:45 SGT · **services (inferred)** N
- **Plan item:** V3 T3 (commit: "V3 T3, P0-2"; H-P0-4 default). This is V3-SEQUENCE §1 item 8, group P0/P3.

**What it did.**

- A new `momentum-partial-runtime.js` pass runs once per loop cycle. It sits after the momentum book, outside the symbols block, in its own try/catch.
- It checks the broker at most once per plan per 60 s, with a 15 s budget per account, and accounts run in parallel.
- A pre-filter skips the broker only on a fresh mark more than 0.25R short of the trigger. Fix-round blocker 1: the mark's age is judged from its bar time (`markAgeMs`), not from when the book wrote it.
- A proven partial writes exactly one `scale_out` event in the same transaction as the plan row.
- A waiting bind becomes BIND_ABANDONED once the book row is exit_sent or closed.
- `/state/momentum-targets` reports `passHeartbeatAt`, freshness and per-account availability. `runtimeIntegration` cannot read COMPLETE before T4.
- Website: a new "Momentum partial targets (TP1)" card on Performance, and the partial trigger in the cockpit. The trigger reads "UNAVAILABLE" with a reason when the pass cannot act on that account (blocker 2).
- Controllers: new `momentum_partial` in the protection group, bringing the registry to 38 live.
- The squash message carries T2's commit messages too, because the branch was built on T2. The diff against main is T3's 14 files.

**Verification recorded** (PR or commit body).

- Inert while `recordedPlans` is 0: no broker call and no credential read.
- Merge check: `node --test` 69 files 1,322/1,322; vitest 8 files 50/50.
- Independent check of the merge: **MERGE**. Nits N1 (freshness limit vs the heartbeat's loop period) and N2 (`ui-control-inventory.md` 8 lines stale) were carried.
- The integrated plan's §2 records T3 as **Passed** (03:42:45Z; the same at 05:16:42Z).

<!-- details: Files of #1132: 14 (A 4 · M 10 · D 0), +1,442 / −10 -->
**Files of #1132: 14** (A 4 · M 10 · D 0), +1,442 / −10

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/loop.js` | 26 | 0 |
| M | `agent/routes/momentum-target-status.test.js` | 124 | 0 |
| M | `agent/services/cockpit-intention.js` | 24 | 0 |
| M | `agent/services/cockpit-intention.test.js` | 62 | 0 |
| M | `agent/services/controller-groups.test.js` | 1 | 1 |
| M | `agent/services/heartbeat.js` | 6 | 0 |
| M | `agent/services/momentum-entry-contract.js` | 91 | 8 |
| A | `agent/services/momentum-partial-runtime.js` | 410 | 0 |
| A | `agent/services/momentum-partial-runtime.test.js` | 467 | 0 |
| M | `agent/shared/controller-groups.js` | 1 | 1 |
| M | `docs/v3-momentum-entry-contract-2026-09-25.md` | 74 | 0 |
| A | `src/components/MomentumTargets.jsx` | 98 | 0 |
| A | `src/components/momentum-targets.test.jsx` | 56 | 0 |
| M | `src/pages/Performance.jsx` | 2 | 0 |
<!-- /details -->

<a name="pr-1133"></a>

### #1133 — Each account's own symbol map, read daily whether or not it trades (V3 K2)

- **Squash commit** `1573559` · **merged** 25-09 23:48:18Z = 26-09 07:48:18 SGT · **services (inferred)** N
- **Plan item:** V3 K2 (P2; H-P2-5 default: build). This is V3-SEQUENCE §1 item 19. It depends on K1 (#1129).

**What it did.**

- A new `account-symbol-maps.js` pass runs every 5 min and sends at most one `ProtoOASymbolsListReq` per pass. It reads only for an account whose map is missing, unreadable, undated, 23 h or more old, or not proven to be its own.
- Limits: at least 30 min between attempts on one account, backing off to 6 h, and at most 3 reads per account per UTC day. The attempt record survives restarts.
- `wsGetSymbolsList` gains `{ perAccount: true }`, because its cache is keyed by host and could return another account's list for 6 h.
- `fetchAccountSymbolMap` refuses a list naming another account (`account_identity_mismatch`) and stamps `accountId` as proof of source.
- Accounts whose broker token was refused (B7) and disabled accounts (`enabled = 0`) are skipped and shown as blocked.
- It was transplanted onto main after K1's squash. One conflict, in `ctrader-ws.test.js`, was resolved by keeping both tests.

**Verification recorded** (PR or commit body).

- All 7 production accounts read `enabled=1` (GET `/state/accounts`, 25-09 ~23:00 UTC).
- After the transplant: 55/55. Checker: 716/716 and 253/253.
- Mutations M1–M4 failed. Independent check: no blockers.
- The commit names the read-back as a to-do: "/state/calendar-coverage should show all 7…".
- The integrated plan's §2 records "7 of 7 maps" as **Passed**, 05:04Z.

<!-- details: Files of #1133: 8 (A 2 · M 6 · D 0), +682 / −12 -->
**Files of #1133: 8** (A 2 · M 6 · D 0), +682 / −12

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/index.js` | 7 | 0 |
| M | `agent/lib/ctrader-creds.js` | 18 | 3 |
| M | `agent/lib/ctrader-ws.js` | 26 | 5 |
| M | `agent/lib/ctrader-ws.test.js` | 27 | 1 |
| M | `agent/lib/symbol-id-resolve.test.js` | 30 | 1 |
| A | `agent/services/account-symbol-maps.js` | 245 | 0 |
| A | `agent/services/account-symbol-maps.test.js` | 300 | 0 |
| M | `agent/services/calendar-coverage.js` | 29 | 2 |
<!-- /details -->

<a name="pr-1134"></a>

### #1134 — An outbox held by a setting is named, not counted as stuck (V3 STK-08v2)

- **Squash commit** `fe754a2` · **merged** 26-09 00:02:51Z = 26-09 08:02:51 SGT · **services (inferred)** N
- **Plan item:** V3 STK-08v2, version 2 of the order-lifecycle rule STK-08 `outbox_backlog`. It is not an item row in the V3-SEQUENCE §1 table. The integrated plan's §2 lists it under group P5a.

**What it did.**

- Both production STK-08 violations were channels switched off by settings. The rule now classes a channel disabled by a readable setting as `held_by_setting`: not a violation, but still named in the rule, the goal row and the daily line, with the setting, the unsent count, the oldest queued time and the reasons.
- A channel that is on and not delivering stays a defect. An unreadable setting is never taken as off.
- The watchdog's relayed `masterEnabled=false` counts only when Node's own readable `telegram_notify_json` reads `enabled=false` (fix-round nit 1).
- New read-only `GET /state/telegram-digest`, with no message text or credentials. It reads only through `idx_tg_outbox_pending`, and its reason breakdown is bounded to the newest 2,000 rows.
- STK-08 went to version 2, re-pinned at `f79c388f91fac5d1`.

**Verification recorded** (PR or commit body).

- Production (GET 25-09 23:29–23:34 UTC):
  - Telegram: 57,750 unsent rows, the oldest queued 2026-08-22 10:39:26 UTC.
  - Watchdog outbox: 512/512, dropped 1,527,783, with all four delivery settings false.
- Tests: 95/95, 44/44 and 74/74; after the fix, 170/170.
- Independent check: **MERGE**.
- The integrated plan's §2 records STK-08v2 as **Passed** (03:42:44Z; Telegram off).

<!-- details: Files of #1134: 6 (A 1 · M 5 · D 0), +486 / −11 -->
**Files of #1134: 6** (A 1 · M 5 · D 0), +486 / −11

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/routes/state.js` | 14 | 0 |
| A | `agent/routes/telegram-digest-route.test.js` | 74 | 0 |
| M | `agent/services/order-lifecycle.js` | 89 | 9 |
| M | `agent/services/order-lifecycle.test.js` | 176 | 1 |
| M | `agent/services/telegram-digest.js` | 70 | 0 |
| M | `agent/services/telegram-digest.test.js` | 63 | 1 |
<!-- /details -->

<a name="pr-1135"></a>

### #1135 — Broker lifecycle verdicts and the per-currency reconciliation report (V3 B2)

- **Squash commit** `982c656` · **merged** 26-09 00:11:26Z = 26-09 08:11:26 SGT · **services (inferred)** N
- **Plan item:** V3 B2 (commit: "V3 B2, P5b-2"). This is V3-SEQUENCE §1 item 13, group P5b, and depends on B1 (#1116). The squash message also carries B1's commit messages (the branch was built on B1), but the diff against main is B2's.

**What it did.**

- Every position-history read now records one of 14 verdicts in a new table, `position_lifecycle_evidence`. Examples: `never_filled` for histories made only of REJECTED / INTERNALLY_REJECTED / ERROR / MISSED deals, and a final `permanently_unsupported`.
- Final verdicts are not re-read under the same `rules` version. `unreadable` is retried after 15 min.
- A rotating evidence sweep covers closed rows with money but no broker receipt, positions whose money differs from its receipts, and rows with no account. It writes only verdicts and receipts, never money, status or account. It shares a 30 s per-account pacing with the old reader.
- New `GET /state/ledger-reconciliation?account=` on the report worker, per account in its deposit currency, pooled only by a proven, equal currency.
- The label "unresolved: no broker evidence" becomes "broker shows the order never filled", or "broker history read, not settleable", where that is what the broker returned.
- Merged with main: both B2's and main's summing now use main's `poolByCurrency`. The fix round resolved the K1 conflicts in `state.js` and `performance-populations.js`, and moved the Desk duplicate-money line into `src/lib/duplicate-money.js`.

**Verification recorded** (PR or commit body).

- Production before the change (`/state/unknown-pnl`, 19:09Z): 15 of 19 written-off rows carried the false "position deal evidence invalid" label.
- Load estimate from two production reads (19:26:17 and 19:38:22 UTC): the P&L pass ran 4 times in 725 s.
- Checker blocker B1 (`is_live` read in the report, against owner principle 1) was fixed. The merge-check blocker (conflicts with K1) was fixed.
- Final tests: node 80/80 and 178/178 on the touched files.
- The integrated plan's §2 records "B2: 2 money disagreements, 50 broker-only (04:58:50Z)".

<!-- details: Files of #1135: 19 (A 6 · M 13 · D 0), +1,954 / −59 -->
**Files of #1135: 19** (A 6 · M 13 · D 0), +1,954 / −59

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/db.js` | 48 | 0 |
| M | `agent/lib/position-deal-history.js` | 39 | 0 |
| M | `agent/routes/state.js` | 24 | 1 |
| M | `agent/services/cross-side-pnl.js` | 27 | 2 |
| A | `agent/services/ledger-reconciliation.js` | 320 | 0 |
| A | `agent/services/ledger-reconciliation.test.js` | 248 | 0 |
| M | `agent/services/mark-unresolvable.js` | 18 | 0 |
| M | `agent/services/old-position-pnl.js` | 30 | 5 |
| M | `agent/services/performance-populations.js` | 12 | 0 |
| M | `agent/services/pnl-lifecycle-guard.test.js` | 10 | 2 |
| M | `agent/services/pnl-reconcile-stall.test.js` | 9 | 2 |
| A | `agent/services/position-lifecycle-evidence.js` | 400 | 0 |
| A | `agent/services/position-lifecycle-evidence.test.js` | 433 | 0 |
| M | `agent/services/trade-integrity.js` | 120 | 21 |
| M | `agent/services/trade-integrity.test.js` | 125 | 0 |
| M | `docs/ui-control-inventory.md` | 11 | 11 |
| A | `src/lib/duplicate-money.js` | 22 | 0 |
| A | `src/lib/duplicate-money.test.js` | 29 | 0 |
| M | `src/pages/Desk.jsx` | 29 | 15 |
<!-- /details -->

<a name="pr-1136"></a>

### #1136 — Amend round-trip time and lateness on every amend path (V3 M5)

- **Squash commit** `fac8955` · **merged** 26-09 00:08:35Z = 26-09 08:08:35 SGT · **services (inferred)** N
- **Plan item:** V3 M5 (P1/P4). This is V3-SEQUENCE §1 item 18 ("spec: V3-SEQUENCE §1 item 18 plus the PR-6 detail in V3-SPECS.json").

**What it did.**

- Measurement only.
- A new `protection-latency.js` `measureAmend()` wraps all ten Node amend paths:
  - `executeBrokerAction` MOVE_SL and the runner leg;
  - `amendBookStop`, whose read-back is recorded as the confirmation;
  - loss-guardian, profit-keeper and trade-guard;
  - position-protect, as `manual` and `telegram`;
  - target-restore, tp-suggest and restrategize.
- It returns and rethrows exactly what the amend does, and records it into a 256-entry ring.
- The fast monitor passes `{dueAtMs, evaluatedAtMs}`, so its amends record due → evaluated → sent → broker answer as one composite. Lateness also goes into its own 512-sample ring.
- The authenticated `/health` gains `amendLatency`. The coordinator fix `gatedSummary()` makes p95 null below 20 amends and p99 null below 100. The native trail engine is always Not Verifiable.
- It is persisted in `amend_latency_json`, measured at 56,594 B with the rings full.

**Verification recorded** (PR or commit body).

- Independent check: **MERGE**. Existing tests of the changed code 578/578; main-thread cost `persistAmendLatency` p50 0.69 ms.
- Merge with main (conflict in `agent/index.js`): 315/315. Merge check: **MERGE**.
- Coordinator fix: 61/61.
- No production read-back in the commit or PR.

<!-- details: Files of #1136: 24 (A 3 · M 21 · D 0), +1,345 / −26 -->
**Files of #1136: 24** (A 3 · M 21 · D 0), +1,345 / −26

| St | File | + | − |
|:-:|---|---:|---:|
| A | `agent/amend-latency-wiring.test.js` | 207 | 0 |
| M | `agent/health-exposure.test.js` | 27 | 0 |
| M | `agent/index.js` | 11 | 0 |
| M | `agent/loop.js` | 14 | 6 |
| M | `agent/services/book-stop-amend.js` | 27 | 3 |
| M | `agent/services/book-stop-amend.test.js` | 38 | 0 |
| M | `agent/services/fast-monitor.js` | 12 | 1 |
| M | `agent/services/loss-guardian.js` | 4 | 2 |
| M | `agent/services/loss-guardian.test.js` | 27 | 0 |
| M | `agent/services/position-protect.js` | 4 | 1 |
| M | `agent/services/position-protect.test.js` | 20 | 0 |
| M | `agent/services/profit-keeper.js` | 4 | 2 |
| M | `agent/services/profit-keeper.test.js` | 16 | 0 |
| A | `agent/services/protection-latency.js` | 476 | 0 |
| A | `agent/services/protection-latency.test.js` | 273 | 0 |
| M | `agent/services/restrategize.js` | 4 | 1 |
| M | `agent/services/restrategize.test.js` | 20 | 0 |
| M | `agent/services/target-restore.js` | 4 | 2 |
| M | `agent/services/target-restore.test.js` | 18 | 0 |
| M | `agent/services/tp-suggest.js` | 4 | 2 |
| M | `agent/services/tp-suggest.test.js` | 18 | 0 |
| M | `agent/services/trade-guard.js` | 4 | 2 |
| M | `agent/services/trade-guard.test.js` | 31 | 0 |
| M | `docs/v3-p1p4-acceptance-2026-09-25.md` | 82 | 4 |
<!-- /details -->

<a name="pr-1137"></a>

### #1137 — Acceptance evaluators and the recorder soak driver, on the merged R1 (V3 R2)

- **Squash commit** `c4bbd19` · **merged** 26-09 00:29:43Z = 26-09 08:29:43 SGT · **services (inferred)** N
- **Plan item:** V3 R2 (commit: "V3 R2, P8d"). This is V3-SEQUENCE §1 item 22, group P8, and depends on R1 (#1130).

**What it did.**

- Adds offline acceptance evaluators in `agent/services/final-acceptance.js`: T0 freeze, T1/T1b recorder drill, T2 retention, T3 capacity, T4 end-to-end trace, the soak verdict and the T5 report. Each gives PASS, FAIL or NOT_VERIFIABLE with a named reason, from saved GET bodies only.
- The CLI `scripts/v3-final-acceptance.mjs` refuses any `/state/storage` body.
- Adds a recorder soak driver (`tick-recorder-soak-driver.cpp`), compiled from `scripts/` against `cpp-exec/src/tick_recorder.cpp`, so no gateway watch pattern fires. It comes with an LD_PRELOAD filesystem fault layer (`tick-recorder-soak-faults.c`).
- Adapted to the merged R1:
  - a restart is judged by the policy of the boot before it;
  - nothing is graded before R1 has listed the new boot;
  - `torn_at_start` is named;
  - a capped gone-list is NOT_VERIFIABLE.
- Fix round: an unrecorded loss FAILs again once the gone page covers the drill (`v3-r2-4`).
- The only server change: `ledgerView`'s `recent[]` SELECT gains six columns.

**Verification recorded** (PR or commit body).

- Carried to the merged R1: 31/31; R1 tests 144/145 (the known better-sqlite3 WAL-reset test).
- Carry check: **MERGE**.
- Fix round: 128/128, with 4 mutations, each caught by a failing test.
- The original build's 60 s soak smoke run graded FAIL on real defects in the gateway's tick recorder, which were left unfixed because `cpp-exec/**` was off-limits.
- No production read-back.

<!-- details: Files of #1137: 8 (A 6 · M 2 · D 0), +3,020 / −1 -->
**Files of #1137: 8** (A 6 · M 2 · D 0), +3,020 / −1

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/lib/one-account-model.test.js` | 1 | 0 |
| M | `agent/services/entry-ledger.js` | 4 | 1 |
| A | `agent/services/final-acceptance.js` | 1,065 | 0 |
| A | `agent/services/final-acceptance.test.js` | 854 | 0 |
| A | `scripts/tick-recorder-soak-driver.cpp` | 541 | 0 |
| A | `scripts/tick-recorder-soak-faults.c` | 147 | 0 |
| A | `scripts/tick-recorder-soak.mjs` | 198 | 0 |
| A | `scripts/v3-final-acceptance.mjs` | 210 | 0 |
<!-- /details -->

<a name="pr-1138"></a>

### #1138 — Expired holiday rows no longer make a calendar unknown (V3 K1b)

- **Squash commit** `ae77365` · **merged** 26-09 00:45:25Z = 26-09 08:45:25 SGT · **services (inferred)** N
- **Plan item:** V3 K1b, a follow-up to K1 (#1129), under P2 and owner principles 3 and 4. It is not an item row in the V3-SEQUENCE §1 table. The integrated plan's §2 lists it under P2.

**What it did.**

- Production sends `startSecond 0 / endSecond 0` on full-day "Closed" holiday rows. The range check rejected those, making 101 of 136 demanded calendars UNKNOWN.
- A non-recurring row with unreadable bounds, dated 3 or more UTC days before its own observation, is now skipped by `validateCalendar`. It stays in the stored payload, so the version hash is unchanged, and is flagged `holiday_expired_ignored`.
- `/state/market-calendar` lists it as `expiredHolidays`, and `/state/calendar-coverage` counts it.
- `calendarAt` never evaluates a row with unreadable bounds.
- Stored verdicts are re-derived at their own observation time.
- A current or future 0/0 row stays UNKNOWN; its meaning is the owner's K3 decision.

**Verification recorded** (PR or commit body).

- Diagnosis (GET, 26-09 00:08 UTC): 101 of 136 demanded calendars and 261 identities were UNKNOWN; 257 of the 261 were UNKNOWN only because of past-dated rows; there were 335 unresolved rows.
- Tests: 33/33. Independent check: **MERGE**.
- #1141's body records the result: "136 of 136, and UNKNOWN is 0 on all 7 accounts (read 26-09 00:48 UTC)".

<!-- details: Files of #1138: 7 (A 0 · M 7 · D 0), +315 / −34 -->
**Files of #1138: 7** (A 0 · M 7 · D 0), +315 / −34

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/services/calendar-coverage.js` | 20 | 3 |
| M | `agent/services/calendar-coverage.test.js` | 35 | 1 |
| M | `agent/services/market-calendar.js` | 100 | 25 |
| M | `agent/services/market-calendar.test.js` | 132 | 1 |
| M | `docs/market-calendar-contract-2026-09-22.md` | 8 | 1 |
| M | `docs/v3-completion-checkpoint-2026-09-24.md` | 8 | 0 |
| M | `docs/v3-handover-2026-09-24.md` | 12 | 3 |
<!-- /details -->

<a name="pr-1139"></a>

### #1139 — Older ledger edges carry the balance each stored deal reported, per currency (V3 WEB-8)

- **Squash commit** `e257d63` · **merged** 26-09 01:02:03Z = 26-09 09:02:03 SGT · **services (inferred)** N
- **Plan item:** V3 WEB-8. The commit body says "8,989-A row 7 (NEW-L3)". It was merged on top of WEB-3 (#1119) as "WEB-8-m".

**What it did.**

- Stores the broker's balance on deals and cashflows. New additive columns: `broker_deals` gains balance, balance_version, balance_currency and balance_source; `account_cashflows` gains balance, balance_version and balance_source.
- Balances come from `closePositionDetail.balance`, `depositWithdraw.balance` and the statements' "Balance" column.
- A ledger edge before the stored balance reads can now use the balance after the last stored deal or cashflow, but only when the next stored event reconciles to the cent. Otherwise it stays a labelled gap, for example `balance_chain_break` or `event_without_balance`.
- `balanceReader` gains an opt-in `dealBalances` fallback, which `ledgerBalanceEdges` turns on. The hourly card keeps the reads-only rule.
- `GET /state/deal-balances` answers `?at=` edges with the same reader, built once per request.
- A failed deal read is named in words on the tooltip, the footnote, the phone line and the copy text.

**Verification recorded** (PR or commit body).

- Measured on the three committed statements (683 deals, 31-07 → 21-08): 680 of 680 consecutive links reconcile.
- Independent check: **MERGE**, six nits. The fix round `42d04fb` applied nits 1–4 and 6: node 70/70, vitest 53/53.
- Nit 5 corrected the builder's test counts: the Performance-importing vitest files held 26 tests at c86e92c and 28 at the fix round; the reported 80 and 106 did not reproduce.
- No production read-back.

<!-- details: Files of #1139: 17 (A 2 · M 15 · D 0), +1,378 / −36 -->
**Files of #1139: 17** (A 2 · M 15 · D 0), +1,378 / −36

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/db.js` | 21 | 0 |
| M | `agent/lib/one-account-model.test.js` | 1 | 0 |
| M | `agent/routes/state.js` | 30 | 0 |
| M | `agent/services/account-cashflows.js` | 27 | 6 |
| M | `agent/services/balance-edges.js` | 82 | 6 |
| M | `agent/services/balance-edges.test.js` | 179 | 1 |
| M | `agent/services/broker-history-import.js` | 41 | 3 |
| M | `agent/services/cashflow-collector.js` | 6 | 2 |
| M | `agent/services/cashflow-collector.test.js` | 28 | 0 |
| A | `agent/services/deal-balances.js` | 282 | 0 |
| A | `agent/services/deal-balances.test.js` | 457 | 0 |
| M | `agent/services/statement-import.js` | 14 | 1 |
| M | `agent/shared/balance-carry.js` | 39 | 7 |
| M | `src/components/performance-balances.test.jsx` | 33 | 1 |
| M | `src/lib/balance-cells.js` | 61 | 3 |
| M | `src/lib/balance-cells.test.js` | 65 | 1 |
| M | `src/pages/Performance.jsx` | 12 | 5 |
<!-- /details -->

<a name="pr-1140"></a>

### #1140 — Completeness goals name what cannot be recovered (V3 B4)

- **Squash commit** `6541c0f` · **merged** 26-09 01:08:14Z = 26-09 09:08:14 SGT · **services (inferred)** N
- **Plan item:** V3 B4 (commit: "V3 B4, P5b-3"). This is V3-SEQUENCE §1 item 15, group P5b, and depends on B2.

**What it did.**

- The raw counts and verdicts of `close_completeness` and `trade_reasons` are unchanged. Each item now gets a class:
  - closes: `labelled_unrecoverable`, `broker_evidence_pending` or `postmortem_pending`;
  - trade reasons: `pre_contract` or `post_contract`.
- Each goal row shows the split, up to 50 named items, and the alternative reading if the owner excluded labelled rows (shown, not counted).
- A new `agent/lib/record-contracts.js` dates the writer contracts: #857 `e455ca8` 2026-09-08T07:48:28Z, PR-D #899, and PR-AL's fix #934.
- `/state/position-history` classes every refused record: `pre_contract`, `post_contract_pre_fix`, `outside_bot`, `broker_evidence_pending`, `labelled_unrecoverable` or `live_gap`.
- `buildPositionRecord` finds "123.0" as well as "123" without CAST.
- Fix round:
  - the Telegram close alert was bounded (`buildIncompleteCloseAlert`, ≤ 20 rows, 3,800 chars);
  - `plan_unscored` is always `post_contract`;
  - `preContractIds` was added;
  - finality requires `rules = EVIDENCE_RULES`.

**Verification recorded** (PR or commit body).

- Production 26-09 00:14Z: `close_completeness` 17 (all written off); `trade_reasons` 254; #8 and #353 lie outside the count.
- Independent check: **FIX FIRST**. The blocker was the Telegram alert growing from 1,162 to 4,188 characters, over the 4,096 limit, and failing silently. Fixed.
- Tests: 87/87 and 450/450.
- No post-merge read-back in the commit or PR.

<!-- details: Files of #1140: 10 (A 2 · M 8 · D 0), +1,061 / −45 -->
**Files of #1140: 10** (A 2 · M 8 · D 0), +1,061 / −45

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/index.js` | 6 | 2 |
| A | `agent/lib/record-contracts.js` | 115 | 0 |
| A | `agent/lib/record-contracts.test.js` | 37 | 0 |
| M | `agent/loop.js` | 4 | 2 |
| M | `agent/services/close-completeness.js` | 203 | 30 |
| M | `agent/services/close-completeness.test.js` | 197 | 1 |
| M | `agent/services/goal-table.js` | 61 | 3 |
| M | `agent/services/goal-table.test.js` | 100 | 0 |
| M | `agent/services/position-history.js` | 200 | 7 |
| M | `agent/services/position-history.test.js` | 138 | 0 |
<!-- /details -->

<a name="pr-1141"></a>

### #1141 — Show which part of the calendar export was cut; keep the verdict (V3 K1c)

- **Squash commit** `77da158` · **merged** 26-09 01:31:13Z = 26-09 09:31:13 SGT · **services (inferred)** N
- **Plan item:** V3 K1c, a follow-up to K1b (#1138), under P2 and owner principles 3 and 6. It is not an item row in the V3-SEQUENCE §1 table. It also carries the CLAUDE.md serial ledger write-back through № 9,515.

**What it did.**

- The `calendarsComplete` verdict is deliberately unchanged. The maker showed that a retained, non-demanded calendar can land on a work item, because `cpp-verify/src/watchdog_state.cpp:162-166` copies any matching export entry onto any service's item. A cpp-scan-tick row carries no calendar of its own, so "complete" on the demanded part alone would be false.
- `watchdogCalendars` now returns `calendarExport.{demanded, retained}`, each with total / exported / withCalendar / cut. `retained` adds `totalIsLowerBound` and `malformed`.
- The contract's size bound zeroes both parts.
- `/state/calendar-coverage` shows the split, and R2's `gate.calendars` reason names it, e.g. "demanded 136 of 136 exported, retained 36 of 512+ exported (476 cut)".
- It asks the owner how to handle retained calendars.

**Verification recorded** (PR or commit body).

- Production 26-09 00:48 UTC: 136 of 136 demanded calendars exported, UNKNOWN 0 on all 7 accounts, `calendarsComplete` still false.
- GET reads at 00:52 UTC: work items per service were cpp-scan-tick 0, cpp-scan-timeframe 0, cpp-exec 62, cpp-acct 56, node 13; no active calendar incidents (201 resolved).
- Independent check: **MERGE**. Fix round: 94/94.

<!-- details: Files of #1141: 8 (A 0 · M 8 · D 0), +244 / −11 -->
**Files of #1141: 8** (A 0 · M 8 · D 0), +244 / −11

| St | File | + | − |
|:-:|---|---:|---:|
| M | `CLAUDE.md` | 14 | 0 |
| M | `agent/services/calendar-coverage.js` | 9 | 0 |
| M | `agent/services/calendar-coverage.test.js` | 114 | 2 |
| M | `agent/services/final-acceptance.js` | 24 | 1 |
| M | `agent/services/final-acceptance.test.js` | 31 | 0 |
| M | `agent/services/scanner-work.js` | 44 | 5 |
| M | `agent/services/watchdog-contract.js` | 7 | 2 |
| M | `agent/services/watchdog-contract.test.js` | 1 | 1 |
<!-- /details -->

<a name="pr-1142"></a>

### #1142 — Mark an unread deal balance on the ledger cell itself; pin the phone note and copy text (V3 WEB-8b)

- **Squash commit** `9f44f97` · **merged** 26-09 02:54:26Z = 26-09 10:54:26 SGT · **services (inferred)** N
- **Plan item:** V3 WEB-8b, a follow-up to WEB-8 (#1139): the two nits from the independent check of its fix round, under owner principle 6.

**What it did.**

- When the stored deal balances for an account could not be read, `balanceLines` appends a mark to that missing line's own text. The mark was first " · deals unread" and, after a coordinator follow-up, " (deals unread)". It therefore shows in the ledger cell, the phone card and copy-as-text, in words rather than colour.
- `ledgerToText` is exported.
- The phone note moved into an exported `MobileLedgerDealNote` component, so both are pinned by tests.
- Website only; nothing under `agent/`.

**Verification recorded** (PR or commit body).

- vitest 58/58 on six files. Mutations M1–M3b failed.
- Independent check: **MERGE**.
- After the wording change: 58/58, with 5 tests failing under the revert mutation.
- No production read-back.

<!-- details: Files of #1142: 4 (A 0 · M 4 · D 0), +123 / −10 -->
**Files of #1142: 4** (A 0 · M 4 · D 0), +123 / −10

| St | File | + | − |
|:-:|---|---:|---:|
| M | `src/components/performance-balances.test.jsx` | 68 | 1 |
| M | `src/lib/balance-cells.js` | 9 | 3 |
| M | `src/lib/balance-cells.test.js` | 34 | 1 |
| M | `src/pages/Performance.jsx` | 12 | 5 |
<!-- /details -->

<a name="pr-1143"></a>

### #1143 — Plan for owner requests 1 and 2, and the DevTools MCP performance-trace harness

- **Squash commit** `5389a83` · **merged** 26-09 04:46:56Z = 26-09 12:46:56 SGT · **services (inferred)** N
- **Who merged it:** GitHub `merged_by` reads `ang-kl`. The integrated plan (`docs/v3-integrated-plan-2026-09-26.md` lines 5 and 60) records that the owner merged it: "you merged it at 04:46:56Z" and "#1143 merged at 12:46 SGT, then 'I thought the plan is approved' at about 13:40 SGT". The PR body opens with "Owner review required — do not auto-merge".
- **Plan item:** Owner requests 1 and 2, as stated in the title. It carries PERF-0 ("PERF-0 merged in #1143", integrated plan §0) and added the first DRAFT of the integrated plan.

**What it did.**

- Docs and scripts only.
- Added `docs/plan-ui-and-strategy-review-2026-09-26.md` (918 lines). It answers:
  - request 1: the sidebar, the Reasons page card by card, and the AI page;
  - request 2: the Performance cards, the entry-blocker table, why strategies are OFF, a strategy review, historical data, and whether a separate cpp service is needed.
- The plan lists decisions D1–D22. §13 is the owner's 26-09 mandate for Chrome DevTools MCP performance traces, with a 5-page desktop/phone baseline. §14 records that the 150-bar window is the code's own floor (`SIGNAL_BARS`, `fib-strategy.js:60`), not a cTrader limit.
- Added `scripts/perf-trace/`. It runs `chrome-devtools-mcp` 1.10.1 over MCP stdio in fresh isolated contexts, reports medians, strips the read-only key from output, and checks the TLS certificate before and after each run.
- A third commit added `docs/v3-integrated-plan-2026-09-26.md` marked DRAFT. The checked version replaced it in #1147.

**Verification recorded** (PR or commit body).

- PR body: ESLint clean on the harness scripts, and a dry run of the harness on `/risk` succeeded.
- The integrated plan (later) records that the merge restarted Node: boot 04:47:29Z, `/health` at 05:16:42Z on `5389a83` with 0 errors and 26 positions.
- It also records the M3 harness gap from 04:48:32Z.

<!-- details: Files of #1143: 7 (A 7 · M 0 · D 0), +1,627 / −0 -->
**Files of #1143: 7** (A 7 · M 0 · D 0), +1,627 / −0

| St | File | + | − |
|:-:|---|---:|---:|
| A | `docs/plan-ui-and-strategy-review-2026-09-26.md` | 918 | 0 |
| A | `docs/v3-integrated-plan-2026-09-26.md` | 490 | 0 |
| A | `scripts/perf-trace/.gitignore` | 2 | 0 |
| A | `scripts/perf-trace/README.md` | 48 | 0 |
| A | `scripts/perf-trace/certpin.mjs` | 40 | 0 |
| A | `scripts/perf-trace/run-traces.sh` | 27 | 0 |
| A | `scripts/perf-trace/trace.mjs` | 102 | 0 |
<!-- /details -->

<a name="pr-1144"></a>

### #1144 — The close goal row names each refused and unattributed close record (V3 B4b)

- **Squash commit** `13e5c0e` · **merged** 26-09 04:01:36Z = 26-09 12:01:36 SGT · **services (inferred)** N
- **Plan item:** V3 B4b, which is B4 (#1140) checker nit 5, declined in B4's fix round "on a stale premise". The integrated plan's §2 lists it under P5b/P5d.

**What it did.**

- The `lifecycle_close` goal row now names each new CLS-04 (position record refused) and CLS-03 (close cause unattributed) record: account, symbol, position id, trade id, the flagging rules, what is missing, and the class and reason from B4's classifier.
- The class comes through a new helper, `classifyFlaggedClose`, which adds no class of its own.
- A split partitions the count, with `other_rules` for records only other close rules flag. Items are capped at 50, with `itemsTotal`.
- Count, verdict and summary numbers are unchanged, and no ruleset version moved.
- Fix round:
  - the legacy `if (!e.new) continue` filter is pinned by a test;
  - the split is withheld when a close rule is unreadable or truncated (a lower bound);
  - each item carries `classedOn`.

**Verification recorded** (PR or commit body).

- Production at 03:05Z: 6 records (…0058 SGDJPY, MSFT.US on four accounts, …0949 Cocoa). The snapshot is 38,806 B with the 6 records, against a 65,536 B cap.
- Checker at 03:17Z: CLS-04 held 230 violations (8 new) and CLS-03 held 53 (1 new).
- Tests: 166/166 and 264/264. Fix round: 173/173.
- Independent check: **MERGE**.
- Later: the integrated plan's OD-33 cites "B4b's list (05:04:03Z): the 4 MSFT.US `pre_contract` rows labelled unrecoverable by rule; SGDJPY final 'no reason recorded'; Cocoa on …0949 was adopted without the bot's label".

<!-- details: Files of #1144: 6 (A 0 · M 6 · D 0), +564 / −8 -->
**Files of #1144: 6** (A 0 · M 6 · D 0), +564 / −8

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/services/goal-table.js` | 9 | 2 |
| M | `agent/services/goal-table.test.js` | 28 | 0 |
| M | `agent/services/order-lifecycle.js` | 141 | 4 |
| M | `agent/services/order-lifecycle.test.js` | 224 | 2 |
| M | `agent/services/position-history.js` | 90 | 0 |
| M | `agent/services/position-history.test.js` | 72 | 0 |
<!-- /details -->

<a name="pr-1145"></a>

### #1145 — Adopted bot trades get their reason back from evidence; adoption keeps it from now on (V3 B4c)

- **Squash commit** `22bcd29` · **merged** 26-09 04:11:08Z = 26-09 12:11:08 SGT · **services (inferred)** N
- **Plan item:** V3 B4c, under owner principles 4 and 6. The integrated plan's §2 lists it under P5b/P5d. It is not an item row in the V3-SEQUENCE §1 table.

**What it did.**

- Root cause: at `reconciler.js:612` the reconciler put a bot label's strategy in `label_strategy`, never in `strategy`, and linked no approval or plan unless the label carried an `|i<id>` intent tag.
- A new `adopted-reasons.js` `recoverTradeReason` fills only empty fields that a record names. Sources:
  - the label's strategy code, through the STRATEGIES table;
  - the intent tag, or the single intent that recorded the position;
  - the resting row that placed the intent's order;
  - a sibling bot row whose own approval source is shown.
- Each field writes its evidence to a new `trade_reason_evidence` table. It never uses a time window, invents a plan, or overwrites an approval.
- `backfillAdoptedReasons` runs at boot and hourly, and is idempotent.
- The reconciler calls `recoverTradeReason` at adoption.
- Fix rounds:
  - an approval or plan linked only by the pre-L2a symbol+time sweep counts as a missing "heuristic link", so the row stays counted and `post_contract`;
  - a promotion guard;
  - a new `idx_entry_intents_position` index.
- It also classes legacy external imports as `outside_bot`.

**Verification recorded** (PR or commit body).

- Expected effect, stated as an estimate from GET reads: 106 adopted rows get their label strategy back; trade_reasons raw about 253 (range 253–256).
- Independent check: **FIX FIRST**. The blocker was rows leaving `trade_reasons` on a heuristic approval id. Fixed in `330c435`.
- Check of the changes to merged code: **MERGE**, 275/275. Second fix `efbb853`: 266/266. After merging with main (B4b): 302/302.
- The integrated plan (later) says "B4c's recovery: seen only through B4b's named list (05:04:03Z)", listed under "Not verified".

<!-- details: Files of #1145: 10 (A 2 · M 8 · D 0), +1,247 / −51 -->
**Files of #1145: 10** (A 2 · M 8 · D 0), +1,247 / −51

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/db.js` | 5 | 0 |
| M | `agent/index.js` | 11 | 0 |
| M | `agent/lib/trade-labels.js` | 3 | 2 |
| M | `agent/loop.js` | 11 | 0 |
| A | `agent/services/adopted-reasons.js` | 559 | 0 |
| A | `agent/services/adopted-reasons.test.js` | 474 | 0 |
| M | `agent/services/close-completeness.js` | 74 | 5 |
| M | `agent/services/position-history.js` | 10 | 2 |
| M | `agent/services/position-history.test.js` | 16 | 0 |
| M | `agent/services/reconciler.js` | 84 | 42 |
<!-- /details -->

<a name="pr-1147"></a>

### #1147 — Trace loads stop counting as the owner's tabs; the manual-order confirm names the account; checked integrated plan and roadmap (Wave 1.1)

- **Squash commit** `e0dff3a` · **merged** 26-09 07:16:47Z = 26-09 15:16:47 SGT · **services (inferred)** N
- **Plan item:** Integrated plan Wave 1, row 1.1: NEW-1 + SAFE-0a, plus the checked plan and roadmap. The commit also cites "integrated plan 26-09-2026 §3/§5 row 1.1" and "plan §8 item 0(a)" for SAFE-0a.

**What it did.**

- **NEW-1.** A page opened with `?synthetic=<tag>` keeps the tag in sessionStorage and sends it on every `/state/client-ping`. `client-presence.js` stores it per tab, and a later untagged ping cannot clear it.
  - `openTabs`, `visibleTabs`, `timezones` and the tab-count warning count only the owner's tabs. Tagged tabs are reported apart as `synthetic`, and their rows are kept and labelled.
  - The P1/P4 grader skips synthetic rows.
  - `scripts/perf-trace/trace.mjs` opens every page with `?synthetic=trace`.
- **SAFE-0a.** The manual-order confirm (`src/lib/manual-order-confirm.js`, `Trade.jsx`) names the destination account (…last four, plus the login when known), says when it is not the account the page shows, and never names live or demo. Routing is unchanged (D2).
- **Inventory walk.** `scripts/ui-control-inventory.mjs` `walk()` skips `node_modules` before it stats it. This fixes an ELOOP on a self-linked `agent/node_modules/node_modules`.
- **Docs.** The checked `docs/v3-integrated-plan-2026-09-26.md` (20 verifier corrections plus the §10 record) replaces #1143's draft. The new `docs/v3-integrated-roadmap-2026-09-26.html` is 5,937 lines.
- **CLAUDE.md.** The §1 ledger write-back.

**Verification recorded** (PR or commit body).

- Independent checker: **MERGE** on the build (`2cea273`) and again on the nit fixes (`992972d`).
- `node --test` 80/80; vitest 23/23 plus the inventory test 11/11; ESLint, build and `check:no-green` clean.
- Mutations: the owner-tab filter, the account id in the confirm, the route pass-through and grader filter, and the `walk()` skip.
- The integrated plan's Wave 1 actuals (as corrected by #1160): row 1.1, #1147, merged 07:16Z / 15:16 SGT. Proof recorded: "Landed as planned".

<!-- details: Files of #1147: 19 (A 7 · M 12 · D 0), +6,734 / −384 -->
**Files of #1147: 19** (A 7 · M 12 · D 0), +6,734 / −384

| St | File | + | − |
|:-:|---|---:|---:|
| M | `CLAUDE.md` | 19 | 0 |
| M | `agent/routes/state.js` | 3 | 0 |
| M | `agent/services/client-presence.js` | 41 | 5 |
| A | `agent/services/client-presence.test.js` | 113 | 0 |
| M | `agent/services/p1p4-grade.js` | 6 | 1 |
| M | `docs/ui-control-inventory.md` | 12 | 11 |
| M | `docs/v3-integrated-plan-2026-09-26.md` | 300 | 357 |
| A | `docs/v3-integrated-roadmap-2026-09-26.html` | 5,937 | 0 |
| M | `scripts/perf-trace/README.md` | 1 | 0 |
| A | `scripts/perf-trace/synthetic.mjs` | 21 | 0 |
| A | `scripts/perf-trace/synthetic.test.js` | 29 | 0 |
| M | `scripts/perf-trace/trace.mjs` | 5 | 2 |
| M | `scripts/ui-control-inventory.mjs` | 6 | 1 |
| M | `src/lib/agent-api.js` | 40 | 4 |
| A | `src/lib/manual-order-confirm.js` | 43 | 0 |
| A | `src/lib/manual-order-confirm.test.js` | 60 | 0 |
| A | `src/lib/synthetic-presence.test.js` | 72 | 0 |
| M | `src/lib/ui-control-inventory.test.js` | 17 | 2 |
| M | `src/pages/Trade.jsx` | 9 | 1 |
<!-- /details -->

<a name="pr-1148"></a>

### #1148 — Every card collapses the same way and remembers it; Performance's two cards join the standard; fewer layout jumps (Wave 1.2: UI-1, PERF-1, PERF-2)

- **Squash commit** `3fe1daa` · **merged** 26-09 07:34:28Z = 26-09 15:34:28 SGT · **services (inferred)** N
- **Commit subject differs from the PR title:** "Every card collapses the same way and remembers it; Performance's two cards join the standard; fewer layout jumps (Wave 1.2) (#1148)".
- **Plan item:** Integrated plan Wave 1, row 1.2: UI-1 + PERF-1, plus PERF-2, which moved in from row 1.5. It also covers owner request 2's two Performance cards. The UI defaults come from OD-0 yes, i.e. OD-17 (a).

**What it did.**

- **UI-1.**
  - `Card.jsx`'s collapse triangle is always visible (full opacity, with a border).
  - Each card's open or closed state is remembered by `id` through a new pure `src/lib/card-open.js` with injected storage; throwing storage degrades to the default.
  - Performance's "Account balance, floating profit and equity" (`sec-acct-balance`) and "Recorded entry blockers" (`sec-blockers`) cards get ids and nav entries.
- **PERF-1.**
  - The `inter-800.woff2` preload in `index.html` gets `crossorigin`.
  - Cards reserve 160 px while loading.
  - The blockers card starts collapsed.
  - GSAP ScrollTrigger refreshes once per batch through the new `src/lib/scroll-reveal.js`. This was the fix-round item the checker had flagged as missing.
- **PERF-2.** The second Performance digit tree renders as static text; only the Rolling-24h counter stays animated.

**Verification recorded** (PR or commit body).

- Maker: 30 targeted tests; mutation checks on the persistence wiring, the triangle style and the font `crossorigin`.
- Independent checker: one blocker, the missing ScrollTrigger item. Fixed with 7 behavioural tests and a wiring pin.
- On the merged tree with #1147: `npx vitest run` 1,207/1,208 before the inventory was regenerated, passing after.
- The integrated plan's Wave 1 actuals: row 1.2, #1148, 07:34Z / 15:34 SGT.
  - "Performance CLS passed (desktop 0.70→0.23, phone 0.78→0.12)."
  - "**Reasons CLS Failed** (0.76→0.74 desktop, 0.59→0.55 phone) — closed by W1-FU."

<!-- details: Files of #1148: 16 (A 6 · M 10 · D 0), +540 / −37 -->
**Files of #1148: 16** (A 6 · M 10 · D 0), +540 / −37

| St | File | + | − |
|:-:|---|---:|---:|
| M | `docs/ui-control-inventory.md` | 20 | 20 |
| M | `index.html` | 11 | 0 |
| M | `src/components/BlockerReport.jsx` | 6 | 1 |
| M | `src/components/account-history.test.jsx` | 13 | 0 |
| M | `src/components/common/Card.jsx` | 51 | 4 |
| A | `src/components/common/Card.test.jsx` | 98 | 0 |
| M | `src/components/common/Collapse.jsx` | 10 | 3 |
| A | `src/lib/card-open.js` | 44 | 0 |
| A | `src/lib/card-open.test.js` | 71 | 0 |
| M | `src/lib/index-html-scripts.test.js` | 15 | 0 |
| M | `src/lib/nav-tree.js` | 7 | 0 |
| A | `src/lib/scroll-reveal.js` | 40 | 0 |
| A | `src/lib/scroll-reveal.test.js` | 106 | 0 |
| M | `src/pages/Performance.jsx` | 7 | 2 |
| M | `src/pages/Risk.jsx` | 5 | 7 |
| A | `src/pages/risk-scroll-reveal-wiring.test.js` | 36 | 0 |
<!-- /details -->

<a name="pr-1149"></a>

### #1149 — Honest arming records and a picker that follows the accounts; the bar path fetches the depth it needs and measures itself (Wave 1.6: S-1, S-3)

- **Squash commit** `24de265` · **merged** 26-09 08:00:39Z = 26-09 16:00:39 SGT · **services (inferred)** N
- **Plan item:** Integrated plan Wave 1, row 1.6: S-1 + S-3. The commit cites "new plan §4, §7, §8 items 4 and 11".

**What it did.**

- **S-1.**
  - The scan winner and the analysis picker rank by the union of the roster's own Auto Trade & Open cells (`rosterArmedTradeKeys`), not the shared list.
  - At boot, each unexplained cell gets an appended `declared` arming row. The 7 wrong fib_confluence reasons from 20-09 get appended `corrected` rows. The 90-day `arming_log` prune is removed.
  - Per-account writes to Scan, Back Test, Live Tweak & Close or a filter's trade flag are refused with a 400 (`stage_not_account_scoped`). Stored ones are listed as `unapplied`.
  - Tune shows "followed by N of M".
  - Principle-5 texts corrected.
- **S-3.**
  - Bar-cache entries record their depth, and the scan fetches its need plus one.
  - Entries expire at the close of the bar still forming at fetch time.
  - New Phase 0 counters (`agent/lib/bar-path-counters.js`) under `/state/data-feed` `barPath`.
  - `/state/armed-cell-reachability` marks "impossible" cells only when the broker's history ends inside the request window.
  - tsmom_long liveness reads the momentum ranking.
- Fix round (the checker's blocker): the first draft marked every weekend-gapped window impossible. `isHistoryLimited` now uses a 7-day, two-period edge against the request's own window start (`trendbarWindowStartMs`).

**Verification recorded** (PR or commit body).

- Maker: 3,108/3,114 on 234 touched-module files. The failures were 2 old overlay tests rewritten for the new 400, and 1 SQLite 3.49.2 environment test. 5 mutations failed.
- Checker: one blocker, the false "impossible" cells. Fix round: 122/122.
- On the merged tree: 173/173 agent; vitest 1,211/1,211.
- PR body note: scanner-mirror `delivery_failed` already read 45 before the merge, against the plan's 33.
- The integrated plan's Wave 1 actuals: row 1.6, #1149, 08:00Z / 16:00 SGT. "Read back: arming rows appended; picker ranks by armed strategies."

<!-- details: Files of #1149: 26 (A 5 · M 21 · D 0), +1,680 / −164 -->
**Files of #1149: 26** (A 5 · M 21 · D 0), +1,680 / −164

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/config/strategy-pins.json` | 2 | 2 |
| M | `agent/index.js` | 13 | 0 |
| A | `agent/lib/bar-path-counters.js` | 210 | 0 |
| M | `agent/lib/ctrader-session.js` | 6 | 0 |
| M | `agent/lib/ctrader-ws.js` | 38 | 13 |
| M | `agent/lib/entry-producers.js` | 1 | 1 |
| M | `agent/loop.js` | 28 | 10 |
| M | `agent/routes/actions.js` | 4 | 1 |
| M | `agent/routes/state.js` | 11 | 3 |
| M | `agent/services/armed-cell-reachability.js` | 48 | 1 |
| M | `agent/services/arming-log.js` | 123 | 6 |
| M | `agent/services/arming-ratchet.js` | 10 | 3 |
| A | `agent/services/fib-strategy-bar-path.test.js` | 333 | 0 |
| M | `agent/services/fib-strategy.js` | 150 | 30 |
| M | `agent/services/refusal-ledger.js` | 15 | 8 |
| M | `agent/services/stage-matrix-account.test.js` | 18 | 5 |
| A | `agent/services/stage-matrix-s1.test.js` | 283 | 0 |
| M | `agent/services/stage-matrix.js` | 168 | 22 |
| M | `agent/services/strategy-liveness.js` | 39 | 8 |
| M | `docs/claude-takeover-2026-09-25.md` | 3 | 1 |
| M | `docs/dual-environment-plan-2026-09-25.md` | 6 | 1 |
| M | `docs/first-principles-audit-2026-09-19.md` | 9 | 0 |
| M | `docs/ui-control-inventory.md` | 45 | 45 |
| A | `src/lib/stage-matrix-view.js` | 58 | 0 |
| A | `src/lib/stage-matrix-view.test.js` | 34 | 0 |
| M | `src/pages/Tune.jsx` | 25 | 4 |
<!-- /details -->

<a name="pr-1150"></a>

### #1150 — Honest sidebar readiness, the real build commit, one AI page (Wave 1.4: UI-4, UI-7)

- **Squash commit** `1aca2bd` · **merged** 26-09 08:12:09Z = 26-09 16:12:09 SGT · **services (inferred)** N
- **Plan item:** Integrated plan Wave 1, row 1.4: UI-4 + UI-7 (SB1, SB2; OD-21 / D3 for the build label).

**What it did.**

- **Readiness.** `GET /state/tick-readiness?account=all` returns the whole roster; before, "all" was read as an account id. The sidebar and panel ask for `all`.
- **Row join.** `engineRowFor` joins on the full `routingAccountId`, and a missing reading shows "no record".
- **Entry note.** The owner-flagged "· shadow" word is replaced by `entryStatusNote`, built from `readiness.shadowReady` / `shadowBlockers`, `entryModePolicy` and the stored row.
- **Build commit.**
  - A new `scripts/build-commit.mjs` reads Railway's `RAILWAY_GIT_COMMIT_SHA`.
  - The root `Dockerfile` frontend stage declares the ARG after `npm ci`. Every image had been stamped `dev`, which now reads "unknown".
  - `buildLabel` renders the build at four sites.
- **LLM status.** `/health` `llmProvider` reads `off` when no key is set or the switch is on (`llmStatusLabel`).
- **UI-7.** A new `src/pages/Ai.jsx`:
  - the LLM spend card moves off Desk into `LlmSpendCard.jsx`;
  - Re-Risk (`RiskReassess`) moves from Risk to the AI page, with deep links back to `/risk#risk-<key>`;
  - the screener chat stays on Tune;
  - "(Claude)" and "thesis intact" are relabelled as rules-based.

**Verification recorded** (PR or commit body).

- Independent checker: **FIX FIRST**. Four blockers:
  - readiness narrowed by the viewed account;
  - the build label not rendered at every site;
  - the "· shadow" word;
  - Re-Risk not moved.

  Plus 4 nits. All 8 were fixed.
- On the merged tree: 304/304 agent tests; vitest 1,262/1,262.
- Coordinator's own mutation: `scope.explicit && !scope.all` → `scope.explicit` made the new route test fail.
- The integrated plan's Wave 1 actuals: row 1.4, #1150, 08:12Z / 16:12 SGT. "Read back: web and agent commits match; the AI page reads 'off'."

<!-- details: Files of #1150: 40 (A 8 · M 32 · D 0), +1,280 / −255 -->
**Files of #1150: 40** (A 8 · M 32 · D 0), +1,280 / −255

| St | File | + | − |
|:-:|---|---:|---:|
| M | `Dockerfile` | 17 | 0 |
| M | `agent/deploy-image.test.js` | 26 | 0 |
| M | `agent/health-exposure.test.js` | 18 | 0 |
| M | `agent/index.js` | 9 | 2 |
| M | `agent/lib/llm-provider.js` | 24 | 0 |
| M | `agent/lib/llm-provider.test.js` | 13 | 1 |
| M | `agent/routes/state.js` | 8 | 1 |
| M | `agent/routes/tick-readiness-routes.test.js` | 16 | 0 |
| M | `docs/ui-control-inventory.md` | 56 | 56 |
| A | `scripts/build-commit.mjs` | 37 | 0 |
| A | `scripts/build-commit.test.js` | 28 | 0 |
| M | `src/App.jsx` | 5 | 0 |
| M | `src/cockpit/cockpit-data.js` | 4 | 1 |
| M | `src/components/AgentHealthPanel.jsx` | 5 | 4 |
| M | `src/components/BotChanges.jsx` | 4 | 1 |
| M | `src/components/EngineStatusLine.jsx` | 5 | 2 |
| M | `src/components/EngineStatusPanel.jsx` | 7 | 2 |
| M | `src/components/LlmMonitorStatus.jsx` | 33 | 0 |
| A | `src/components/LlmSpendCard.jsx` | 130 | 0 |
| M | `src/components/RiskReassess.jsx` | 11 | 23 |
| M | `src/components/SessionFooter.jsx` | 15 | 5 |
| M | `src/components/agent-health-panel.test.jsx` | 53 | 7 |
| A | `src/components/engine-status-line.test.jsx` | 128 | 0 |
| M | `src/components/engine-status-panel.test.jsx` | 7 | 0 |
| M | `src/components/llm-monitor-status.test.jsx` | 34 | 0 |
| A | `src/components/llm-spend-card.test.jsx` | 44 | 0 |
| M | `src/lib/agent-health-view.js` | 30 | 1 |
| M | `src/lib/engine-account-id.test.js` | 21 | 0 |
| M | `src/lib/engine-status-view.js` | 66 | 2 |
| M | `src/lib/engine-status-view.test.js` | 55 | 1 |
| M | `src/lib/nav-tabs.js` | 2 | 0 |
| M | `src/lib/nav-tree.js` | 15 | 2 |
| M | `src/lib/use-engine-status.js` | 20 | 4 |
| A | `src/lib/use-engine-status.test.js` | 93 | 0 |
| A | `src/pages/Ai.jsx` | 121 | 0 |
| M | `src/pages/Desk.jsx` | 7 | 109 |
| M | `src/pages/Risk.jsx` | 49 | 16 |
| A | `src/pages/ai-page-nav.test.js` | 37 | 0 |
| M | `src/pages/risk-anchors.test.js` | 20 | 7 |
| M | `vite.config.js` | 7 | 8 |
<!-- /details -->

<a name="pr-1151"></a>

### #1151 — Closers wait for an in-flight momentum close; a tick-feeder stall alarm; the lifecycle rule on every pass; the PRE fill spread recorded (Wave 1.7: F1, F4, F5-N6, PO-M3)

- **Squash commit** `36c44fd` · **merged** 26-09 08:33:01Z = 26-09 16:33:01 SGT · **services (inferred)** N
- **Plan item:** Integrated plan Wave 1, row 1.7: F1 + F4 + F5's N6 + PO-M3. F1 is T2's "Not covered" follow-up (`docs/v3-momentum-exit-coordination-2026-09-25.md`). F4 is #1099 nit 2.

**What it did.**

- **F1.** The profit keeper (close and scale-out), loss guardian, trade guard (partial TPs) and weekend bank call `protectiveExitDeferral` before closing. A momentum SENDING / RANK_SENDING claim on the same position within 50 s defers that close for this pass only, recorded in a `deferred` list.
- **F4.** A new `tick-feeder-stall.js` produces a `tick_feeder` heartbeat plus a `tick_feeder_stall:<side>` inspector finding.
  - It reads stalled at ≥ 240 s, the second missed 120 s probe.
  - It is registered `quiet`, so nothing is sent.
  - It sits in the "Scanning and strategies" controller group.
- **F5-N6.** `pnl-backfill.js` applies the lifecycle rule on every window pass, not only strict ones. Both production callers are already strict.
- **PO-M3.** A new `limit-fill-spread.js` records the spread at a resting limit's (PRE) fill into new columns `trades.fill_spread` and `fill_spread_json`, or `not_read` with a reason. It is write-once.
  - Fix-round blocker: once a record cannot change, the recorder returns before scanning the unindexed `cpp_events` table.

**Verification recorded** (PR or commit body).

- Maker: 2,611/2,613 across 153 files. The 2 failures are timing tests under concurrency.
- Checker: one blocker (the `cpp_events` scan) and 5 nits. Fix round: 286/286.
- On the merged tree: 637/637 agent; vitest 1,262/1,262.
- The integrated plan's Wave 1 actuals: row 1.7, #1151, 08:33Z / 16:33 SGT. "Read back: the `tick_feeder` heartbeat; closers defer (inert, 0 plans)."

<!-- details: Files of #1151: 20 (A 5 · M 15 · D 0), +1,134 / −39 -->
**Files of #1151: 20** (A 5 · M 15 · D 0), +1,134 / −39

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/db.js` | 5 | 0 |
| M | `agent/loop.js` | 1 | 0 |
| A | `agent/services/closer-horizon-deferral.test.js` | 257 | 0 |
| M | `agent/services/controller-groups.test.js` | 1 | 1 |
| M | `agent/services/fast-monitor.js` | 14 | 3 |
| M | `agent/services/heartbeat.js` | 27 | 2 |
| A | `agent/services/limit-fill-spread.js` | 137 | 0 |
| A | `agent/services/limit-fill-spread.test.js` | 188 | 0 |
| M | `agent/services/log-inspector.js` | 55 | 0 |
| M | `agent/services/loss-guardian.js` | 7 | 1 |
| M | `agent/services/pnl-backfill.js` | 15 | 5 |
| M | `agent/services/pnl-backfill.test.js` | 91 | 6 |
| M | `agent/services/profit-keeper.js` | 21 | 4 |
| A | `agent/services/tick-feeder-stall.js` | 104 | 0 |
| A | `agent/services/tick-feeder-stall.test.js` | 156 | 0 |
| M | `agent/services/trade-guard.js` | 11 | 2 |
| M | `agent/services/weekend-bank.js` | 14 | 2 |
| M | `agent/shared/controller-groups.js` | 1 | 1 |
| M | `docs/reporting-acceptance-2026-09-23.md` | 17 | 6 |
| M | `docs/v3-momentum-exit-coordination-2026-09-25.md` | 12 | 6 |
<!-- /details -->

<a name="pr-1152"></a>

### #1152 — A weekly answer cut by the bar count is no longer read as the end of the broker's history; BTCUSD's monthly start corrected to July 2010 (follow-up to #1149)

- **Squash commit** `b509b6f` · **merged** 26-09 08:54:21Z = 26-09 16:54:21 SGT · **services (inferred)** N
- **Plan item:** Follow-up to #1149 (W1.6, S-3), found while answering the owner's BTCUSD history question (26-09 16:32 SGT). It has no row of its own; the Wave 1 actuals table lists it as "—".

**What it did.**

- `isHistoryLimited` read a short answer as "the broker's whole history". But `wsGetTrendbarsBatch` requests `fetchCount + 5` periods, so an answer that stopped at the count starts about 5 periods inside the window.
- The new exported `WINDOW_PAD_BARS = 5` is shared by `planWindowStartMs` and the check. The margin is now max(7 days, 2 periods) + 5 periods.
- BTCUSD 1w reads `windowLimited`; BTCUSD 1mo is still history-limited.
- The `/state/data-feed` note explains `windowLimited`.
- Docs and comment corrected: BTCUSD monthly history starts with the July 2010 bar (2010-06-30 21:00Z). It holds 190 bars where 194 months would be expected.

**Verification recorded** (PR or commit body).

- Production false row (`/state/data-feed` `barPath.shortHistory`, 08:13Z): BTCUSD 1w, asked 451, got 450, first bar 2018-02-04, window from 2017-12-30.
- Maker: 14/14 and 511/511. Checker: **MERGE**. On the merged tree: 511/511.
- The integrated plan's Wave 1 actuals: #1152, 08:54Z / 16:54 SGT. "BTCUSD history: monthly series starts July 2010; the 'weekly starts 2018' reading was a false positive."

<!-- details: Files of #1152: 5 (A 0 · M 5 · D 0), +128 / −16 -->
**Files of #1152: 5** (A 0 · M 5 · D 0), +128 / −16

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/lib/bar-path-counters.js` | 43 | 9 |
| M | `agent/lib/ctrader-ws.js` | 5 | 1 |
| M | `agent/services/armed-cell-reachability.js` | 7 | 4 |
| M | `agent/services/fib-strategy-bar-path.test.js` | 72 | 1 |
| M | `docs/plan-ui-and-strategy-review-2026-09-26.md` | 1 | 1 |
<!-- /details -->

<a name="pr-1153"></a>

### #1153 — One shared table with sticky headers and day groups; the Blockers card grouped by day in your time zone, bounded, honest about what it folds (Wave 1.3: UI-2, UI-3)

- **Squash commit** `bb9f0ef` · **merged** 26-09 09:21:25Z = 26-09 17:21:25 SGT · **services (inferred)** N
- **Plan item:** Integrated plan Wave 1, row 1.3: UI-2 + UI-3 (the commit cites "UI-1 (OD-17 = D19/D8, 26-09 UI plan §3)"). It was built on W1.2 (#1148).

**What it did.**

- **UI-2.** A new shared `src/components/common/DataTable.jsx` has a sticky header, a sticky first column and a sticky day line. Day groups are sibling rows in one table, with `<th scope="rowgroup">` date lines. Grouping lives in `src/lib/data-table-groups.js`. `useSort` is extended.
- **UI-3 (the Blockers card on Performance).**
  - Records are grouped by day in the viewer's time zone, via a new `agent/lib/date-zones.js`. SGT is shown with UTC underneath. This fixes zone-less SQLite times being read as local.
  - Repeated rows are folded with honest counts: records, summed `repeat_count` evaluations, and the time range to `last_at`.
  - Under "all", roster-wide stops are counted once.
  - "OFF since … — your order" is built from the arming ledger.
  - Response size is bounded by `BLOCKER_DAYS_MAX_BYTES`, which reports `daysIncomplete` and falls back to the paged flat list.
  - A pin test shows the watchdog contract and cpp-verify are unaffected.

**Verification recorded** (PR or commit body).

- Independent checker: **FIX FIRST**, 7 blockers (local-time reading, roster double count, `repeat_count` / `last_at` ignored, a weak fold-key test, nested tables, "OFF since" not built, no size bound) and 10 nits. All 7 blockers were fixed.
- The checker's synthetic 40,000-row probe produced a 68.7 MB answer before the bound.
- On the merged tree: 219/219 agent; routes 263/263; vitest 1,284/1,284.
- The integrated plan's Wave 1 actuals: row 1.3, #1153, 09:21Z / 17:21 SGT. "6 h and 24 h Blockers group by day; **72 h fell back to the flat list** (24,692 records > 512 KB) — closed by W1-FU."

<!-- details: Files of #1153: 19 (A 8 · M 11 · D 0), +2,152 / −49 -->
**Files of #1153: 19** (A 8 · M 11 · D 0), +2,152 / −49

| St | File | + | − |
|:-:|---|---:|---:|
| A | `agent/lib/date-zones.js` | 86 | 0 |
| A | `agent/lib/date-zones.test.js` | 79 | 0 |
| M | `agent/routes/state.js` | 7 | 1 |
| M | `agent/services/blocker-report.js` | 305 | 4 |
| M | `agent/services/blocker-report.test.js` | 306 | 1 |
| M | `agent/services/watchdog-contract.test.js` | 39 | 0 |
| M | `docs/ui-control-inventory.md` | 1 | 1 |
| A | `scripts/fixtures/blocker-report.json` | 504 | 0 |
| M | `scripts/responsive-audit.mjs` | 80 | 10 |
| M | `src/components/BlockerReport.jsx` | 151 | 29 |
| M | `src/components/blocker-report.test.jsx` | 77 | 0 |
| M | `src/components/common/Card.jsx` | 15 | 0 |
| A | `src/components/common/DataTable.jsx` | 204 | 0 |
| A | `src/components/common/DataTable.test.jsx` | 59 | 0 |
| M | `src/index.css` | 22 | 0 |
| A | `src/lib/data-table-groups.js` | 105 | 0 |
| A | `src/lib/data-table-groups.test.js` | 66 | 0 |
| M | `src/lib/use-sort.jsx` | 11 | 3 |
| A | `src/lib/use-sort.test.jsx` | 35 | 0 |
<!-- /details -->

<a name="pr-1154"></a>

### #1154 — The Reasons page reordered card by card on the shared table; the daily-stop line says it counts realised P&L only (Wave 1.5: UI-6, F3) + ledger write-back

- **Squash commit** `8531db5` · **merged** 26-09 09:34:47Z = 26-09 17:34:47 SGT · **services (inferred)** N
- **Plan item:** Integrated plan Wave 1, row 1.5: UI-6 + F3, plus the ledger write-back. PERF-2 moved to #1148. F3 is the WEB-9 checker nit (commit: "V3-SEQUENCE.md ~:793"). The OD-19 default removes the go-live card.

**What it did.**

- **UI-6.**
  - The Reasons page follows RS-1's order (`REASONS_PAGE_LAYOUT` in `src/lib/reasons-view.js`, `ReasonsGroup` in `Reasons.jsx`), and every Reasons table uses W1.3's shared `DataTable`.
  - The go-live-readiness card is removed, and the veto breakdown is merged into refusal cost.
  - Phase audit moves to Desk and Exit counterfactual moves to Tune.
  - `shapeBody` takes an opt-in `expand`.
- **F3.** The daily-stop line now reads "<n> USD left today on realised P&L (floating not counted)". The fixture is corrected to 1130.17: the cap minus realised loss only (`daily-loss-pacing.js:242`).
- **CLAUDE.md.** The §1 ledger write-back through № 9,739.
- Website and docs only; nothing under `agent/`.

**Verification recorded** (PR or commit body).

- Maker: vitest 1,234/1,234. Checker: **MERGE**, no blockers.
- On the merged tree: vitest 1,288/1,288.
- Coordinator mutation: the checker's own mutations left the grep count unchanged (1 → 1), so the coordinator replaced the whole F3 phrase (count 1 → 0) and both F3 tests failed.
- The integrated plan's Wave 1 actuals: row 1.5, #1154, 09:34Z / 17:34 SGT. "Reasons reordered on the shared table. **Its DOM grew 5,357 → 8,904 elements** — closed by W1-FU."

<!-- details: Files of #1154: 10 (A 0 · M 10 · D 0), +452 / −138 -->
**Files of #1154: 10** (A 0 · M 10 · D 0), +452 / −138

| St | File | + | − |
|:-:|---|---:|---:|
| M | `CLAUDE.md` | 16 | 0 |
| M | `docs/ui-control-inventory.md` | 48 | 49 |
| M | `src/components/data-feed-card.test.jsx` | 4 | 1 |
| M | `src/lib/daily-stop-display.js` | 11 | 6 |
| M | `src/lib/daily-stop-display.test.jsx` | 9 | 3 |
| M | `src/lib/reasons-view.js` | 87 | 24 |
| M | `src/pages/Desk.jsx` | 13 | 0 |
| M | `src/pages/Reasons.jsx` | 161 | 33 |
| M | `src/pages/Tune.jsx` | 12 | 0 |
| M | `src/pages/reasons.test.jsx` | 91 | 22 |
<!-- /details -->

<a name="pr-1157"></a>

### #1157 — W1-FU: Reasons card standard, lazy collapsed cards, 72 h blocker day groups, trace warm-up

- **Squash commit** `e751b15` · **merged** 26-09 12:21:03Z = 26-09 20:21:03 SGT · **services (inferred)** N
- **Plan item:** W1-FU, the Wave 1 follow-up. It closes the three read-back gaps recorded in `docs/v3-integrated-plan-2026-09-26.md` §5, "Wave 1 actuals": row 1.2's Reasons CLS, row 1.3's 72 h fallback and row 1.5's DOM growth.

**What it did.**

- Every Reasons card gets a `reasons-<key>` id (wired into `nav-tree.js`), `loading={!result}`, and `defaultCollapsed` after the first two.
- `Card` gains an opt-in `lazy` prop: a collapsed card never opened does not mount its children. Maximise sets `everOpened` (the checker's blocker). Only Reasons opts in.
- Trade consistency is folded into Ledger integrity, per the owner's 26-09 answer.
- `blocker-report.js` `FOLDED_LINES_PER_DAY_MAX` goes 300 → 90, so a 72 h all-accounts window fits the 512 KB bound. Each day header shows "N more line(s) not shown".
- `Tune.jsx` drops an invalid `kind="reasons"`.
- `scripts/perf-trace/trace.mjs` does one discarded warm-up per profile and reports a null run as "not measured".
- The plan doc gains a Wave 1 actuals block.

**Verification recorded** (PR or commit body).

- vitest 1,299/1,299; `blocker-report.test.js` 31/31.
- Full `node --test agent/**/*.test.js`: 6,766/6,784. The 14 failures are pre-existing: SQLite version detection, stall timing and concurrency.
- Not verifiable in the suite: the maximise → restore click.
- Production proof, recorded later in the integrated plan (#1160), traced 12:46–13:02Z on `e751b15` as a median of 3 after a discarded warm-up:

  | Page · profile | Before W1.2 | After W1.5 | After W1-FU | Target | Result |
  |---|---|---|---|---|---|
  | Reasons · desktop CLS | 0.76 | 0.74 | **0.53** | ≤ 0.25 | **Failed** (improved) |
  | Reasons · phone CLS | 0.59 | 0.55 | **0.46** | ≤ 0.25 | **Failed** (improved) |
  | Reasons elements | 5,357 | 8,904 | **2,936** | ≤ 5,400 | **Passed** |
  | Performance · desktop CLS | 0.70 | 0.23 | **0.19** | not worse | Passed |
  | Performance · phone CLS | 0.78 | 0.12 | **0.08** | not worse | Passed |

- Blockers 72 h: "**Passed on production at 12:40Z** — `daysIncomplete: false`, 4 day groups, 426 KB (6 h: 1 day, 24 h: 2 days)."
- LCP medians rose on all four pairs:

  | Page · profile | Before | After |
  |---|---|---|
  | Performance · desktop | 1,123 ms | 3,860 ms |
  | Performance · phone | 4,864 ms | 6,351 ms |
  | Reasons · desktop | 2,374 ms | 7,507 ms |
  | Reasons · phone | 7,787 ms | 9,624 ms |

  "The cause is not attributed."

<!-- details: Files of #1157: 13 (A 1 · M 12 · D 0), +390 / −57 -->
**Files of #1157: 13** (A 1 · M 12 · D 0), +390 / −57

| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/services/blocker-report.js` | 9 | 1 |
| M | `agent/services/blocker-report.test.js` | 49 | 8 |
| M | `docs/ui-control-inventory.md` | 17 | 17 |
| M | `docs/v3-integrated-plan-2026-09-26.md` | 15 | 0 |
| M | `scripts/perf-trace/trace.mjs` | 32 | 2 |
| M | `src/components/BlockerReport.jsx` | 6 | 0 |
| A | `src/components/BlockerReport.test.jsx` | 74 | 0 |
| M | `src/components/common/Card.jsx` | 40 | 1 |
| M | `src/components/common/Card.test.jsx` | 56 | 0 |
| M | `src/lib/nav-tree.js` | 19 | 0 |
| M | `src/lib/reasons-view.js` | 29 | 12 |
| M | `src/pages/Reasons.jsx` | 34 | 14 |
| M | `src/pages/Tune.jsx` | 10 | 2 |
<!-- /details -->

<a name="pr-1160"></a>

### #1160 — Plan and roadmap at 26-09 21:30 SGT: Wave 1 actuals corrected, Wave 2 pre-build status, V3 on-track verdict

- **Squash commit** `b414a06` · **merged** 26-09 13:11:38Z = 26-09 21:11:38 SGT · **services (inferred)** N
- **Commit subject differs from the PR title:** "Plan and roadmap brought up to date at 26-09 21:30 SGT: Wave 1 actuals corrected, Wave 2 pre-build status, and whether V3 is on track (#1160)".
- **Plan item:** The owner's order of 26-09 20:54 SGT: "update Road Map … update the Integration Plan … Are we on track to finish v3". Docs only.

**What it did.**

- Corrected `docs/v3-integrated-plan-2026-09-26.md` §5 "Wave 1 actuals". The first table had put four rows on the wrong PR; they are re-read from the merge commits: 1.3 = #1153, 1.5 = #1154, 1.6 = #1149, 1.7 = #1151.
- Added W1-FU's production proof.
- Added a §5 "Wave 2 pre-build status" table: branch, check verdict, PR / CI and readiness per row, plus the owner questions the checks raised.
- §6 records the owner's 26-09 answers.
- §7 gives progress and the on-track verdict.
- Updated the dataset in `docs/v3-integrated-roadmap-2026-09-26.html`: Wave 1 merged with PRs and times; Wave 2 pre-built or building; answered decisions marked; a new "pre-built" status; counts recomputed.

**Verification recorded** (PR or commit body).

- `check:no-green`: OK. The roadmap renders with no script errors. "On merge, Node restarts once."
- Key figures it records:

  | Check | Before | After | Result |
  |---|---|---|---|
  | Blockers card, 72 h window | not grouped by day | grouped by day | Passed |
  | Reasons page elements | 8,904 | 2,936 | Passed |
  | Reasons CLS (desktop / phone) | 0.74 / 0.55 | 0.53 / 0.46 (target ≤ 0.25) | **Failed**, though improved |

- On-track verdict (plan §7): "the build is on track through Monday. The whole of V3 is not yet on track, because Wave 3 has not started and is gated on answers that are not in."
  - Wave 1: "All 7 merged Sat 07:16–09:34Z, plus #1152 and W1-FU #1157 (12:21Z). **About 34 h early**."
  - "Nine Node restarts; every read-back showed 0 errors and all positions protected."
- Wave 2 status (plan §5):

  | Row | PR / branch head | State |
  |---|---|---|
  | 2.1 | draft #1158 (`5d1f4a4`) | ready |
  | 2.3 | draft #1155 (`88d3dd8`) | ready |
  | 2.4 | draft #1156 (`44e1d41`) | ready |
  | 2.5 | draft #1159 (`a73efbb`) | ready (CI pending at writing) |
  | 2.2 | C8 → C9 | FIX FIRST |
  | 2.6 | B2b + UI-5 | at risk |
  | 2.7 | T4 | draft only until OD-1 and OD-15 |

<!-- details: Files of #1160: 2 (A 0 · M 2 · D 0), +373 / −168 -->
**Files of #1160: 2** (A 0 · M 2 · D 0), +373 / −168

| St | File | + | − |
|:-:|---|---:|---:|
| M | `docs/v3-integrated-plan-2026-09-26.md` | 77 | 12 |
| M | `docs/v3-integrated-roadmap-2026-09-26.html` | 296 | 156 |
<!-- /details -->

## Appendix B: the full file list by area, `83c94e6..b414a06`

**Totals, measured:** 572 files; A 210 · M 362 · D 0; +76,028 / −2,833. No renames, no copies, no binary files. **0 files were deleted.**

**Grouping** (first match wins): 1. **tests** (`*.test.js/jsx/mjs`, any `tests/` directory including the C++ `test_*.cpp`, `agent/test-support/`, `scripts/fixtures/`); 2. **config** (`agent/config/**`, every `railway.json` and `Dockerfile`, `package*.json`, `eslint.config.js`, `vite.config.js`, `.github/**`); 3. the named source folders `agent/services`, `agent/lib`, `agent/routes`, `src/pages`, `src/components`, `src/lib`; 4. **agent root + agent/shared**; 5. **cpp-\*** (non-test, non-config); 6. **scripts**; 7. **docs**; 8. **other** (`CLAUDE.md`, `index.html`, `src/` root files, `src/cockpit/`). So a source area's count excludes its tests.

**"PRs"** is how many of the 71 merged PRs changed the file.

### agent/services: 129 files (A 36 · M 93 · D 0), +22,297 / −1,176

<!-- details: agent/services: 129 files -->
| St | File | + | − | PRs |
|:-:|---|---:|---:|---:|
| M | `agent/services/account-cashflows.js` | 27 | 6 | 1 |
| M | `agent/services/account-history.js` | 98 | 25 | 1 |
| M | `agent/services/account-overview.js` | 6 | 1 | 1 |
| A | `agent/services/account-symbol-maps.js` | 245 | 0 | 1 |
| A | `agent/services/adopted-reasons.js` | 559 | 0 | 1 |
| M | `agent/services/armed-cell-reachability.js` | 51 | 1 | 2 |
| M | `agent/services/arming-log.js` | 123 | 6 | 1 |
| M | `agent/services/arming-ratchet.js` | 10 | 3 | 1 |
| A | `agent/services/balance-edges.js` | 304 | 0 | 2 |
| A | `agent/services/basis-performance.js` | 233 | 0 | 2 |
| M | `agent/services/blocker-report.js` | 681 | 37 | 4 |
| M | `agent/services/book-stop-amend.js` | 27 | 3 | 1 |
| A | `agent/services/boot-clock.js` | 43 | 0 | 1 |
| M | `agent/services/broker-history-import.js` | 178 | 73 | 4 |
| A | `agent/services/broker-readings.js` | 218 | 0 | 1 |
| A | `agent/services/calendar-coverage.js` | 259 | 0 | 4 |
| M | `agent/services/cashflow-collector.js` | 6 | 2 | 1 |
| M | `agent/services/client-presence.js` | 41 | 5 | 1 |
| A | `agent/services/close-capture.js` | 104 | 0 | 1 |
| M | `agent/services/close-completeness.js` | 301 | 34 | 3 |
| M | `agent/services/closed-market-limits.js` | 209 | 74 | 3 |
| M | `agent/services/cockpit-intention.js` | 24 | 0 | 1 |
| M | `agent/services/controller-runtime.js` | 1 | 1 | 1 |
| M | `agent/services/cross-side-pnl.js` | 34 | 3 | 2 |
| M | `agent/services/daily-report.js` | 25 | 1 | 3 |
| A | `agent/services/daily-stop-reading.js` | 178 | 0 | 1 |
| A | `agent/services/data-feed-report.js` | 197 | 0 | 2 |
| A | `agent/services/deal-balances.js` | 282 | 0 | 1 |
| M | `agent/services/decision-log.js` | 43 | 5 | 1 |
| A | `agent/services/deposit-currencies.js` | 33 | 0 | 1 |
| M | `agent/services/direction-policy.js` | 11 | 1 | 1 |
| M | `agent/services/entry-ledger.js` | 277 | 15 | 4 |
| M | `agent/services/entry-mode-auto.js` | 36 | 15 | 1 |
| M | `agent/services/entry-mode.js` | 213 | 78 | 3 |
| M | `agent/services/event-loop-lag.js` | 146 | 0 | 1 |
| M | `agent/services/evidence-gate.js` | 59 | 23 | 1 |
| M | `agent/services/family-edge.js` | 40 | 6 | 2 |
| M | `agent/services/fast-monitor.js` | 122 | 8 | 4 |
| A | `agent/services/feed-receipts-record.js` | 68 | 0 | 1 |
| M | `agent/services/fib-strategy.js` | 153 | 31 | 2 |
| A | `agent/services/final-acceptance.js` | 1,088 | 0 | 2 |
| M | `agent/services/goal-table.js` | 321 | 11 | 6 |
| M | `agent/services/heartbeat.js` | 288 | 26 | 11 |
| M | `agent/services/hourly-activity.js` | 46 | 7 | 2 |
| A | `agent/services/intent-corrections.js` | 195 | 0 | 1 |
| A | `agent/services/ledger-reconciliation.js` | 320 | 0 | 1 |
| A | `agent/services/limit-fill-spread.js` | 137 | 0 | 1 |
| M | `agent/services/log-inspector.js` | 79 | 0 | 3 |
| M | `agent/services/loss-cap.js` | 7 | 0 | 1 |
| M | `agent/services/loss-guardian.js` | 11 | 3 | 2 |
| M | `agent/services/loss-postmortem.js` | 28 | 3 | 1 |
| M | `agent/services/mark-unresolvable.js` | 48 | 2 | 2 |
| M | `agent/services/market-calendar.js` | 176 | 16 | 2 |
| M | `agent/services/momentum-broker-evidence.js` | 153 | 2 | 2 |
| M | `agent/services/momentum-entry-contract.js` | 126 | 19 | 3 |
| A | `agent/services/momentum-exit-coordination.js` | 78 | 0 | 1 |
| M | `agent/services/momentum-partial-broker.js` | 44 | 14 | 2 |
| M | `agent/services/momentum-partial-manager.js` | 234 | 45 | 2 |
| M | `agent/services/momentum-partial-ownership.js` | 18 | 3 | 1 |
| A | `agent/services/momentum-partial-runtime.js` | 410 | 0 | 1 |
| M | `agent/services/momentum-rank-exit.js` | 201 | 41 | 2 |
| M | `agent/services/momentum-target-policy.js` | 107 | 3 | 2 |
| M | `agent/services/momentum-target-proposal.js` | 11 | 1 | 1 |
| M | `agent/services/momentum-timed-quote.js` | 11 | 3 | 1 |
| M | `agent/services/naked-position-guard.js` | 7 | 1 | 1 |
| M | `agent/services/old-position-pnl.js` | 241 | 18 | 3 |
| A | `agent/services/order-lifecycle-ticker.js` | 115 | 0 | 2 |
| A | `agent/services/order-lifecycle.js` | 1,973 | 0 | 10 |
| A | `agent/services/p1p4-grade.js` | 1,100 | 0 | 2 |
| M | `agent/services/pending-orders.js` | 22 | 8 | 2 |
| M | `agent/services/performance-populations.js` | 327 | 23 | 9 |
| A | `agent/services/performance-snapshots.js` | 84 | 0 | 1 |
| A | `agent/services/pf-metrics.js` | 112 | 0 | 1 |
| M | `agent/services/pnl-backfill.js` | 440 | 23 | 4 |
| A | `agent/services/position-capture-accounts.js` | 613 | 0 | 1 |
| M | `agent/services/position-capture.js` | 45 | 12 | 2 |
| M | `agent/services/position-history.js` | 348 | 12 | 5 |
| A | `agent/services/position-lifecycle-evidence.js` | 400 | 0 | 1 |
| M | `agent/services/position-protect.js` | 4 | 1 | 1 |
| M | `agent/services/profit-keeper.js` | 25 | 6 | 2 |
| M | `agent/services/profit-ratchet.js` | 7 | 0 | 1 |
| A | `agent/services/protection-latency.js` | 476 | 0 | 1 |
| M | `agent/services/reconciler.js` | 228 | 25 | 5 |
| M | `agent/services/refusal-ledger.js` | 168 | 11 | 2 |
| M | `agent/services/regime-gate.js` | 17 | 5 | 1 |
| M | `agent/services/regime.js` | 19 | 0 | 1 |
| M | `agent/services/restrategize.js` | 4 | 1 | 1 |
| M | `agent/services/retention.js` | 18 | 0 | 1 |
| M | `agent/services/route-timing.js` | 115 | 5 | 1 |
| M | `agent/services/runtime-manifest.js` | 66 | 9 | 2 |
| A | `agent/services/runtime-record.js` | 396 | 0 | 1 |
| M | `agent/services/scanner-candidates.js` | 9 | 3 | 1 |
| M | `agent/services/scanner-collector.js` | 10 | 2 | 1 |
| M | `agent/services/scanner-comparison.js` | 116 | 15 | 2 |
| M | `agent/services/scanner-feed.js` | 150 | 28 | 2 |
| M | `agent/services/scanner-profile-registry.js` | 8 | 3 | 1 |
| M | `agent/services/scanner-work.js` | 240 | 52 | 5 |
| M | `agent/services/stage-matrix.js` | 168 | 22 | 1 |
| M | `agent/services/statement-import.js` | 14 | 1 | 1 |
| M | `agent/services/storage-report.js` | 143 | 40 | 2 |
| M | `agent/services/strategy-autopilot.js` | 6 | 43 | 1 |
| M | `agent/services/strategy-liveness.js` | 39 | 8 | 1 |
| A | `agent/services/strategy-qualification.js` | 522 | 0 | 1 |
| M | `agent/services/strategy-verdicts.js` | 13 | 4 | 1 |
| A | `agent/services/stuck-resolver.js` | 754 | 0 | 1 |
| M | `agent/services/symbol-position-cap.js` | 9 | 1 | 1 |
| M | `agent/services/target-restore.js` | 4 | 2 | 1 |
| M | `agent/services/telegram-digest.js` | 70 | 0 | 1 |
| A | `agent/services/tick-entry-work.js` | 127 | 0 | 1 |
| A | `agent/services/tick-feeder-stall.js` | 104 | 0 | 1 |
| M | `agent/services/tick-permits.js` | 25 | 5 | 3 |
| M | `agent/services/tick-readiness.js` | 7 | 4 | 2 |
| A | `agent/services/tick-replay-parity.js` | 344 | 0 | 3 |
| M | `agent/services/tick-research-run.js` | 611 | 43 | 3 |
| M | `agent/services/tick-research.js` | 263 | 17 | 2 |
| A | `agent/services/tick-segment-manifest.js` | 409 | 0 | 1 |
| M | `agent/services/tick-segments.js` | 57 | 4 | 2 |
| M | `agent/services/tick-shadow-accounts.js` | 1 | 1 | 1 |
| A | `agent/services/tick-shadow-counterfactual.js` | 286 | 0 | 2 |
| M | `agent/services/tick-shadow.js` | 7 | 2 | 1 |
| M | `agent/services/tick-validation.js` | 47 | 3 | 3 |
| M | `agent/services/tp-suggest.js` | 4 | 2 | 1 |
| A | `agent/services/trade-basis.js` | 140 | 0 | 1 |
| M | `agent/services/trade-guard.js` | 15 | 4 | 2 |
| M | `agent/services/trade-integrity.js` | 120 | 21 | 1 |
| M | `agent/services/trade-plans.js` | 79 | 0 | 2 |
| M | `agent/services/watchdog-calendar-refresh.js` | 135 | 21 | 2 |
| M | `agent/services/watchdog-contract.js` | 55 | 7 | 4 |
| M | `agent/services/weekend-bank.js` | 14 | 2 | 1 |
<!-- /details -->

### agent/lib: 27 files (A 11 · M 16 · D 0), +2,310 / −85

<!-- details: agent/lib: 27 files -->
| St | File | + | − | PRs |
|:-:|---|---:|---:|---:|
| A | `agent/lib/autopilot-cadence.js` | 110 | 0 | 1 |
| A | `agent/lib/bar-path-counters.js` | 244 | 0 | 2 |
| M | `agent/lib/calendar-intervals.js` | 20 | 0 | 1 |
| M | `agent/lib/ctrader-creds.js` | 56 | 6 | 3 |
| M | `agent/lib/ctrader-payload-types.js` | 5 | 0 | 1 |
| M | `agent/lib/ctrader-session.js` | 20 | 0 | 2 |
| M | `agent/lib/ctrader-ws.js` | 115 | 21 | 7 |
| A | `agent/lib/date-zones.js` | 86 | 0 | 1 |
| A | `agent/lib/deal-money.js` | 130 | 0 | 1 |
| M | `agent/lib/entry-contracts.js` | 9 | 0 | 1 |
| M | `agent/lib/entry-producers.js` | 15 | 1 | 2 |
| M | `agent/lib/exec-engine.js` | 37 | 9 | 1 |
| M | `agent/lib/exit-replay.js` | 27 | 2 | 1 |
| A | `agent/lib/feed-receipts.js` | 352 | 0 | 1 |
| M | `agent/lib/llm-provider.js` | 24 | 0 | 1 |
| M | `agent/lib/lot-size-registry.js` | 26 | 0 | 1 |
| A | `agent/lib/order-answer.js` | 106 | 0 | 1 |
| M | `agent/lib/position-deal-history.js` | 130 | 9 | 3 |
| A | `agent/lib/record-contracts.js` | 115 | 0 | 1 |
| A | `agent/lib/request-actor.js` | 52 | 0 | 1 |
| A | `agent/lib/scanner-bounds.js` | 12 | 0 | 1 |
| M | `agent/lib/sessions.js` | 5 | 2 | 1 |
| A | `agent/lib/sqlite-wal-reset.js` | 77 | 0 | 1 |
| A | `agent/lib/stuck-resolutions.js` | 63 | 0 | 1 |
| M | `agent/lib/tick-replay-sim.js` | 413 | 22 | 4 |
| M | `agent/lib/trade-labels.js` | 3 | 2 | 1 |
| M | `agent/lib/verify-client.js` | 58 | 11 | 1 |
<!-- /details -->

### agent/routes: 3 files (A 1 · M 2 · D 0), +750 / −152

<!-- details: agent/routes: 3 files -->
| St | File | + | − | PRs |
|:-:|---|---:|---:|---:|
| M | `agent/routes/actions.js` | 289 | 105 | 10 |
| A | `agent/routes/scanner-registration-body.js` | 20 | 0 | 1 |
| M | `agent/routes/state.js` | 441 | 47 | 22 |
<!-- /details -->

### agent/* root + agent/shared: 7 files (A 2 · M 5 · D 0), +1,197 / −189

<!-- details: agent/* root + agent/shared: 7 files -->
| St | File | + | − | PRs |
|:-:|---|---:|---:|---:|
| M | `agent/db.js` | 305 | 1 | 13 |
| M | `agent/index.js` | 106 | 20 | 10 |
| M | `agent/loop.js` | 355 | 150 | 20 |
| A | `agent/shared/balance-carry.js` | 151 | 0 | 2 |
| M | `agent/shared/controller-groups.js` | 3 | 3 | 5 |
| M | `agent/shared/performance-populations.js` | 169 | 15 | 4 |
| A | `agent/shared/report-sessions.js` | 108 | 0 | 1 |
<!-- /details -->

### src/pages: 7 files (A 1 · M 6 · D 0), +857 / −356

<!-- details: src/pages: 7 files -->
| St | File | + | − | PRs |
|:-:|---|---:|---:|---:|
| A | `src/pages/Ai.jsx` | 121 | 0 | 1 |
| M | `src/pages/Desk.jsx` | 59 | 127 | 5 |
| M | `src/pages/Performance.jsx` | 378 | 165 | 12 |
| M | `src/pages/Reasons.jsx` | 181 | 33 | 4 |
| M | `src/pages/Risk.jsx` | 54 | 23 | 2 |
| M | `src/pages/Trade.jsx` | 19 | 4 | 3 |
| M | `src/pages/Tune.jsx` | 45 | 4 | 3 |
<!-- /details -->

### src/components: 22 files (A 4 · M 18 · D 0), +1,101 / −168

<!-- details: src/components: 22 files -->
| St | File | + | − | PRs |
|:-:|---|---:|---:|---:|
| M | `src/components/AccountHistory.jsx` | 37 | 12 | 1 |
| M | `src/components/AgentHealthPanel.jsx` | 5 | 4 | 1 |
| M | `src/components/BlockerReport.jsx` | 210 | 30 | 5 |
| M | `src/components/BotChanges.jsx` | 4 | 1 | 1 |
| M | `src/components/ControllerGroups.jsx` | 2 | 2 | 1 |
| M | `src/components/ControllerRuntime.jsx` | 33 | 2 | 2 |
| M | `src/components/CurrentAccountReadings.jsx` | 4 | 2 | 1 |
| M | `src/components/EngineStatusLine.jsx` | 5 | 2 | 1 |
| M | `src/components/EngineStatusPanel.jsx` | 54 | 32 | 3 |
| M | `src/components/EntryModePolicySwitch.jsx` | 1 | 1 | 1 |
| A | `src/components/LatestPricesNote.jsx` | 10 | 0 | 1 |
| M | `src/components/LlmMonitorStatus.jsx` | 33 | 0 | 1 |
| A | `src/components/LlmSpendCard.jsx` | 130 | 0 | 1 |
| A | `src/components/MomentumTargets.jsx` | 98 | 0 | 1 |
| M | `src/components/PerfAccountScope.jsx` | 14 | 8 | 1 |
| M | `src/components/PerfMacroSections.jsx` | 55 | 13 | 3 |
| M | `src/components/ReportChart.jsx` | 61 | 24 | 1 |
| M | `src/components/RiskReassess.jsx` | 11 | 23 | 1 |
| M | `src/components/SessionFooter.jsx` | 15 | 5 | 1 |
| M | `src/components/common/Card.jsx` | 105 | 4 | 3 |
| M | `src/components/common/Collapse.jsx` | 10 | 3 | 1 |
| A | `src/components/common/DataTable.jsx` | 204 | 0 | 1 |
<!-- /details -->

### src/lib: 29 files (A 14 · M 15 · D 0), +2,013 / −125

<!-- details: src/lib: 29 files -->
| St | File | + | − | PRs |
|:-:|---|---:|---:|---:|
| A | `src/lib/account-history-request.js` | 15 | 0 | 1 |
| M | `src/lib/agent-api.js` | 51 | 6 | 2 |
| M | `src/lib/agent-health-view.js` | 30 | 1 | 1 |
| A | `src/lib/balance-cells.js` | 137 | 0 | 3 |
| A | `src/lib/card-open.js` | 44 | 0 | 1 |
| A | `src/lib/currency-money.js` | 114 | 0 | 1 |
| M | `src/lib/current-account-totals.js` | 49 | 0 | 1 |
| A | `src/lib/daily-stop-display.js` | 179 | 0 | 3 |
| A | `src/lib/data-feed.js` | 299 | 0 | 2 |
| A | `src/lib/data-table-groups.js` | 105 | 0 | 1 |
| A | `src/lib/duplicate-money.js` | 22 | 0 | 1 |
| M | `src/lib/engine-status-view.js` | 181 | 7 | 3 |
| M | `src/lib/hourly-activity.js` | 18 | 0 | 2 |
| M | `src/lib/hourly-order.js` | 7 | 6 | 1 |
| A | `src/lib/latest-prices.js` | 61 | 0 | 2 |
| A | `src/lib/manual-order-confirm.js` | 43 | 0 | 1 |
| M | `src/lib/nav-tabs.js` | 2 | 0 | 1 |
| M | `src/lib/nav-tree.js` | 41 | 2 | 3 |
| A | `src/lib/partial-money.js` | 61 | 0 | 1 |
| M | `src/lib/perf-aggregate.js` | 30 | 4 | 1 |
| M | `src/lib/performance-curve.js` | 96 | 14 | 1 |
| M | `src/lib/performance-gradients.js` | 125 | 28 | 1 |
| M | `src/lib/reasons-view.js` | 112 | 19 | 4 |
| A | `src/lib/scroll-reveal.js` | 40 | 0 | 1 |
| A | `src/lib/server-readings.js` | 25 | 0 | 1 |
| A | `src/lib/stage-matrix-view.js` | 58 | 0 | 1 |
| M | `src/lib/use-account-overview.js` | 37 | 31 | 1 |
| M | `src/lib/use-engine-status.js` | 20 | 4 | 1 |
| M | `src/lib/use-sort.jsx` | 11 | 3 | 1 |
<!-- /details -->

### cpp-*: 17 files (A 2 · M 15 · D 0), +855 / −63

<!-- details: cpp-*: 17 files -->
| St | File | + | − | PRs |
|:-:|---|---:|---:|---:|
| M | `cpp-exec/README.md` | 14 | 0 | 1 |
| M | `cpp-exec/src/main.cpp` | 35 | 3 | 1 |
| M | `cpp-exec/src/tick_recorder.cpp` | 254 | 1 | 1 |
| M | `cpp-exec/src/tick_recorder.hpp` | 94 | 2 | 1 |
| M | `cpp-scan-tick/Makefile` | 10 | 1 | 1 |
| M | `cpp-scan-tick/src/scanner.cpp` | 87 | 17 | 1 |
| M | `cpp-scan-tick/src/scanner.hpp` | 20 | 3 | 1 |
| M | `cpp-scan-tick/src/scanner_contract.hpp` | 7 | 2 | 1 |
| M | `cpp-scan-timeframe/src/scanner.cpp` | 62 | 17 | 1 |
| M | `cpp-scan-timeframe/src/scanner.hpp` | 18 | 2 | 1 |
| M | `cpp-scan-timeframe/src/scanner_contract.hpp` | 7 | 2 | 1 |
| M | `cpp-verify/README.md` | 48 | 6 | 1 |
| A | `cpp-verify/src/entry_diagnostics.cpp` | 125 | 0 | 1 |
| A | `cpp-verify/src/entry_diagnostics.hpp` | 24 | 0 | 1 |
| M | `cpp-verify/src/watchdog.cpp` | 12 | 4 | 1 |
| M | `cpp-verify/src/watchdog.hpp` | 16 | 0 | 1 |
| M | `cpp-verify/src/watchdog_state.cpp` | 22 | 3 | 1 |
<!-- /details -->

### scripts: 18 files (A 13 · M 5 · D 0), +1,967 / −33

<!-- details: scripts: 18 files -->
| St | File | + | − | PRs |
|:-:|---|---:|---:|---:|
| A | `scripts/agent-gate.mjs` | 66 | 0 | 1 |
| A | `scripts/build-commit.mjs` | 37 | 0 | 1 |
| A | `scripts/perf-trace/.gitignore` | 2 | 0 | 1 |
| A | `scripts/perf-trace/README.md` | 49 | 0 | 2 |
| A | `scripts/perf-trace/certpin.mjs` | 40 | 0 | 1 |
| A | `scripts/perf-trace/run-traces.sh` | 27 | 0 | 1 |
| A | `scripts/perf-trace/synthetic.mjs` | 21 | 0 | 1 |
| A | `scripts/perf-trace/trace.mjs` | 135 | 0 | 3 |
| M | `scripts/responsive-audit.mjs` | 80 | 10 | 1 |
| M | `scripts/run-agent-tests.mjs` | 26 | 11 | 2 |
| A | `scripts/tick-recorder-soak-driver.cpp` | 541 | 0 | 1 |
| A | `scripts/tick-recorder-soak-faults.c` | 147 | 0 | 1 |
| A | `scripts/tick-recorder-soak.mjs` | 198 | 0 | 1 |
| M | `scripts/tick-research.mjs` | 18 | 2 | 3 |
| M | `scripts/ui-control-inventory.mjs` | 6 | 1 | 1 |
| A | `scripts/v3-final-acceptance.mjs` | 210 | 0 | 1 |
| A | `scripts/v3-p1p4-acceptance.mjs` | 344 | 0 | 1 |
| M | `scripts/v3-scanner-load-acceptance.mjs` | 20 | 9 | 1 |
<!-- /details -->

### docs: 27 files (A 7 · M 20 · D 0), +9,283 / −137

<!-- details: docs: 27 files -->
| St | File | + | − | PRs |
|:-:|---|---:|---:|---:|
| M | `docs/account-history-2026-09-22.md` | 40 | 1 | 1 |
| A | `docs/claude-takeover-2026-09-25.md` | 80 | 0 | 2 |
| A | `docs/dual-environment-plan-2026-09-25.md` | 232 | 0 | 4 |
| M | `docs/first-principles-audit-2026-09-19.md` | 9 | 0 | 1 |
| M | `docs/independent-watchdog-2026-09-22.md` | 7 | 0 | 1 |
| M | `docs/market-calendar-contract-2026-09-22.md` | 8 | 1 | 1 |
| M | `docs/performance-populations-2026-09-22.md` | 7 | 2 | 1 |
| A | `docs/plan-ui-and-strategy-review-2026-09-26.md` | 918 | 0 | 2 |
| M | `docs/reporting-acceptance-2026-09-23.md` | 63 | 0 | 3 |
| M | `docs/shared-scanner-boundary-2026-09-22.md` | 26 | 11 | 1 |
| M | `docs/tick-momentum/README.md` | 2 | 2 | 1 |
| M | `docs/tick-momentum/option-2-observation-rollout.md` | 15 | 3 | 1 |
| M | `docs/tick-momentum/plan.md` | 7 | 1 | 3 |
| M | `docs/tick-momentum/readiness-register.csv` | 2 | 2 | 2 |
| M | `docs/ui-control-inventory.md` | 113 | 111 | 12 |
| M | `docs/v3-acceptance-sequence-2026-09-23.md` | 5 | 0 | 1 |
| M | `docs/v3-completion-checkpoint-2026-09-24.md` | 8 | 0 | 1 |
| M | `docs/v3-handover-2026-09-24.md` | 12 | 3 | 1 |
| A | `docs/v3-integrated-plan-2026-09-26.md` | 513 | 0 | 4 |
| A | `docs/v3-integrated-roadmap-2026-09-26.html` | 6,077 | 0 | 2 |
| M | `docs/v3-live-performance-2026-09-25.md` | 15 | 0 | 1 |
| M | `docs/v3-momentum-entry-contract-2026-09-25.md` | 170 | 0 | 3 |
| M | `docs/v3-momentum-exit-coordination-2026-09-25.md` | 199 | 0 | 2 |
| M | `docs/v3-momentum-target-policy-2026-09-24.md` | 22 | 0 | 1 |
| A | `docs/v3-p1p4-acceptance-2026-09-25.md` | 313 | 0 | 3 |
| A | `docs/v3-p1p4-harness-2026-09-25.md` | 367 | 0 | 1 |
| M | `docs/v3-scanner-operator-2026-09-23.md` | 53 | 0 | 2 |
<!-- /details -->

### tests: 269 files (A 117 · M 152 · D 0), +33,177 / −328

<!-- details: tests: 269 files -->
| St | File | + | − | PRs |
|:-:|---|---:|---:|---:|
| A | `agent/amend-latency-wiring.test.js` | 207 | 0 | 1 |
| M | `agent/db-path.test.js` | 3 | 2 | 1 |
| M | `agent/db.test.js` | 2 | 1 | 1 |
| M | `agent/deploy-image.test.js` | 26 | 0 | 1 |
| M | `agent/health-exposure.test.js` | 72 | 0 | 3 |
| A | `agent/lib/autopilot-cadence.test.js` | 63 | 0 | 1 |
| M | `agent/lib/ctrader-session.test.js` | 48 | 0 | 1 |
| M | `agent/lib/ctrader-ws.test.js` | 77 | 1 | 2 |
| A | `agent/lib/date-zones.test.js` | 79 | 0 | 1 |
| A | `agent/lib/deal-money.test.js` | 155 | 0 | 1 |
| M | `agent/lib/exec-engine.test.js` | 85 | 0 | 1 |
| A | `agent/lib/feed-receipts-wiring.test.js` | 115 | 0 | 1 |
| A | `agent/lib/feed-receipts.test.js` | 183 | 0 | 1 |
| M | `agent/lib/llm-provider.test.js` | 13 | 1 | 1 |
| M | `agent/lib/one-account-model.test.js` | 8 | 2 | 6 |
| A | `agent/lib/order-answer.test.js` | 88 | 0 | 1 |
| A | `agent/lib/record-contracts.test.js` | 37 | 0 | 1 |
| A | `agent/lib/request-actor.test.js` | 104 | 0 | 1 |
| A | `agent/lib/sqlite-wal-reset.test.js` | 134 | 0 | 1 |
| M | `agent/lib/symbol-id-resolve.test.js` | 30 | 1 | 1 |
| M | `agent/lib/tick-replay-sim.test.js` | 342 | 3 | 4 |
| M | `agent/lib/verify-client.test.js` | 32 | 0 | 1 |
| M | `agent/lib/wal-open.test.js` | 2 | 1 | 1 |
| M | `agent/loop-phase-indexes.test.js` | 80 | 5 | 2 |
| A | `agent/loop-regime-symbols.test.js` | 42 | 0 | 1 |
| M | `agent/routes/account-engineering-isolation.test.js` | 4 | 1 | 1 |
| A | `agent/routes/blocker-report-isolation.test.js` | 92 | 0 | 3 |
| A | `agent/routes/data-feed-route.test.js` | 96 | 0 | 2 |
| M | `agent/routes/goal-table-routes.test.js` | 39 | 4 | 2 |
| M | `agent/routes/momentum-target-status.test.js` | 124 | 0 | 1 |
| A | `agent/routes/order-lifecycle-route.test.js` | 213 | 0 | 1 |
| A | `agent/routes/position-history-scope-route.test.js` | 51 | 0 | 1 |
| M | `agent/routes/postmortem-isolation.test.js` | 4 | 1 | 1 |
| A | `agent/routes/report-unavailable.test.js` | 245 | 0 | 2 |
| A | `agent/routes/scanner-registration-body.test.js` | 95 | 0 | 1 |
| A | `agent/routes/storage-purge.test.js` | 61 | 0 | 1 |
| A | `agent/routes/stream-prices-feed-latency.test.js` | 94 | 0 | 1 |
| A | `agent/routes/telegram-digest-route.test.js` | 74 | 0 | 1 |
| M | `agent/routes/tick-readiness-routes.test.js` | 58 | 1 | 3 |
| M | `agent/routes/watchdog-isolation.test.js` | 6 | 0 | 1 |
| A | `agent/services/account-history-window.test.js` | 188 | 0 | 1 |
| M | `agent/services/account-history.test.js` | 8 | 2 | 1 |
| M | `agent/services/account-horizon.test.js` | 2 | 1 | 1 |
| M | `agent/services/account-phases.test.js` | 1 | 1 | 1 |
| A | `agent/services/account-symbol-maps.test.js` | 300 | 0 | 1 |
| A | `agent/services/adopted-reasons.test.js` | 474 | 0 | 1 |
| M | `agent/services/arming-log.test.js` | 1 | 1 | 1 |
| M | `agent/services/arming-ratchet.test.js` | 1 | 1 | 1 |
| A | `agent/services/balance-edges.test.js` | 535 | 0 | 3 |
| A | `agent/services/basis-performance.test.js` | 313 | 0 | 1 |
| M | `agent/services/blocker-report.test.js` | 610 | 4 | 4 |
| M | `agent/services/book-stop-amend.test.js` | 38 | 0 | 1 |
| M | `agent/services/broker-history-import.test.js` | 6 | 23 | 1 |
| A | `agent/services/broker-readings.test.js` | 213 | 0 | 1 |
| A | `agent/services/calendar-coverage.test.js` | 530 | 0 | 3 |
| M | `agent/services/cashflow-collector.test.js` | 31 | 1 | 2 |
| A | `agent/services/client-presence.test.js` | 113 | 0 | 1 |
| M | `agent/services/close-completeness.test.js` | 197 | 1 | 1 |
| A | `agent/services/close-writers-l2b.test.js` | 516 | 0 | 1 |
| M | `agent/services/closed-market-limits.test.js` | 27 | 20 | 1 |
| A | `agent/services/closer-horizon-deferral.test.js` | 257 | 0 | 1 |
| M | `agent/services/cockpit-intention.test.js` | 62 | 0 | 1 |
| M | `agent/services/controller-groups.test.js` | 1 | 1 | 5 |
| M | `agent/services/controller-runtime.test.js` | 3 | 0 | 1 |
| M | `agent/services/cross-side-pnl.test.js` | 11 | 6 | 1 |
| M | `agent/services/cup-handle-funnel.test.js` | 2 | 2 | 1 |
| M | `agent/services/daily-report.test.js` | 42 | 2 | 3 |
| A | `agent/services/daily-stop-reading.test.js` | 207 | 0 | 1 |
| A | `agent/services/data-feed-report.test.js` | 170 | 0 | 1 |
| A | `agent/services/deal-balances.test.js` | 457 | 0 | 1 |
| M | `agent/services/decision-log.test.js` | 41 | 6 | 1 |
| M | `agent/services/direction-policy.test.js` | 7 | 2 | 1 |
| M | `agent/services/emergency-reclaim.test.js` | 5 | 4 | 1 |
| A | `agent/services/entry-basis-callers.test.js` | 70 | 0 | 1 |
| M | `agent/services/entry-ledger.test.js` | 215 | 1 | 2 |
| M | `agent/services/entry-mode-auto.test.js` | 101 | 24 | 1 |
| M | `agent/services/entry-mode-gateway.test.js` | 19 | 0 | 1 |
| M | `agent/services/entry-mode.test.js` | 284 | 10 | 4 |
| M | `agent/services/error-log.test.js` | 2 | 2 | 1 |
| M | `agent/services/event-loop-lag.test.js` | 74 | 1 | 1 |
| M | `agent/services/evidence-gate.test.js` | 42 | 0 | 1 |
| M | `agent/services/family-edge.test.js` | 46 | 0 | 2 |
| M | `agent/services/fast-monitor-sidecar-quotes.test.js` | 100 | 0 | 1 |
| M | `agent/services/fast-monitor.test.js` | 55 | 0 | 1 |
| A | `agent/services/feed-receipts-record.test.js` | 40 | 0 | 1 |
| A | `agent/services/fib-strategy-bar-path.test.js` | 404 | 0 | 2 |
| A | `agent/services/final-acceptance.test.js` | 885 | 0 | 2 |
| M | `agent/services/global-strategy-seed.test.js` | 2 | 1 | 1 |
| M | `agent/services/goal-table.test.js` | 313 | 4 | 4 |
| M | `agent/services/hand-pin-watch.test.js` | 2 | 1 | 1 |
| A | `agent/services/heartbeat-cadence-dormant.test.js` | 167 | 0 | 1 |
| M | `agent/services/hourly-activity.test.js` | 167 | 0 | 1 |
| A | `agent/services/intent-corrections.test.js` | 166 | 0 | 1 |
| A | `agent/services/ledger-reconciliation.test.js` | 248 | 0 | 1 |
| A | `agent/services/limit-fill-spread.test.js` | 188 | 0 | 1 |
| M | `agent/services/loss-guardian.test.js` | 27 | 0 | 1 |
| M | `agent/services/loss-postmortem.test.js` | 2 | 2 | 1 |
| M | `agent/services/market-calendar.test.js` | 193 | 1 | 2 |
| M | `agent/services/momentum-account.test.js` | 3 | 2 | 1 |
| M | `agent/services/momentum-book.test.js` | 2 | 1 | 1 |
| M | `agent/services/momentum-broker-evidence.test.js` | 96 | 2 | 1 |
| A | `agent/services/momentum-close-recovery.test.js` | 609 | 0 | 1 |
| A | `agent/services/momentum-exit-coordination.test.js` | 239 | 0 | 1 |
| M | `agent/services/momentum-partial-broker.test.js` | 34 | 1 | 1 |
| M | `agent/services/momentum-partial-manager.test.js` | 99 | 0 | 2 |
| M | `agent/services/momentum-partial-ownership.test.js` | 41 | 5 | 1 |
| A | `agent/services/momentum-partial-runtime.test.js` | 467 | 0 | 1 |
| A | `agent/services/momentum-plan-arithmetic.test.js` | 354 | 0 | 2 |
| M | `agent/services/momentum-rank-exit.test.js` | 59 | 0 | 3 |
| M | `agent/services/momentum-target-policy.test.js` | 126 | 3 | 2 |
| M | `agent/services/momentum-target-proposal.test.js` | 27 | 0 | 1 |
| M | `agent/services/momentum-timed-quote.test.js` | 51 | 1 | 1 |
| M | `agent/services/naked-position-guard.test.js` | 2 | 1 | 1 |
| M | `agent/services/old-position-pnl.test.js` | 3 | 1 | 1 |
| M | `agent/services/open-duplicates.test.js` | 2 | 1 | 1 |
| M | `agent/services/opportunity-funnel.test.js` | 2 | 2 | 1 |
| M | `agent/services/opportunity-identity.test.js` | 2 | 2 | 1 |
| A | `agent/services/order-lifecycle.test.js` | 1,788 | 0 | 8 |
| A | `agent/services/order-writers-l2a.test.js` | 526 | 0 | 1 |
| A | `agent/services/p1p4-grade.test.js` | 898 | 0 | 1 |
| M | `agent/services/performance-populations.test.js` | 195 | 1 | 3 |
| A | `agent/services/performance-snapshots.test.js` | 111 | 0 | 1 |
| A | `agent/services/pf-metrics.test.js` | 54 | 0 | 1 |
| M | `agent/services/phase-trace.test.js` | 2 | 2 | 1 |
| M | `agent/services/pnl-backfill.test.js` | 111 | 16 | 2 |
| A | `agent/services/pnl-lifecycle-guard.test.js` | 525 | 0 | 2 |
| A | `agent/services/pnl-reconcile-stall.test.js` | 484 | 0 | 3 |
| A | `agent/services/position-capture-accounts.test.js` | 713 | 0 | 1 |
| M | `agent/services/position-capture-backlog.test.js` | 23 | 12 | 2 |
| M | `agent/services/position-capture.test.js` | 21 | 5 | 2 |
| M | `agent/services/position-history.test.js` | 226 | 0 | 3 |
| A | `agent/services/position-lifecycle-evidence.test.js` | 433 | 0 | 1 |
| M | `agent/services/position-protect.test.js` | 20 | 0 | 1 |
| M | `agent/services/producer-retirement.test.js` | 5 | 1 | 1 |
| M | `agent/services/profit-keeper.test.js` | 16 | 0 | 1 |
| M | `agent/services/protection-both-sides.test.js` | 7 | 0 | 1 |
| A | `agent/services/protection-latency.test.js` | 273 | 0 | 1 |
| M | `agent/services/prune-scans.test.js` | 2 | 1 | 1 |
| M | `agent/services/reclassify-null-sl.test.js` | 3 | 2 | 1 |
| M | `agent/services/reconciler.test.js` | 28 | 0 | 1 |
| M | `agent/services/regime-gate.test.js` | 18 | 0 | 1 |
| M | `agent/services/regime.test.js` | 8 | 1 | 1 |
| M | `agent/services/report-retention.test.js` | 2 | 1 | 1 |
| A | `agent/services/report-unavailable.test.js` | 241 | 0 | 2 |
| M | `agent/services/restrategize.test.js` | 20 | 0 | 1 |
| M | `agent/services/retention.test.js` | 29 | 0 | 1 |
| M | `agent/services/risk-config-seed.test.js` | 2 | 1 | 1 |
| M | `agent/services/risk-reassess.test.js` | 1 | 1 | 1 |
| M | `agent/services/route-timing.test.js` | 145 | 2 | 1 |
| M | `agent/services/runtime-manifest.test.js` | 77 | 2 | 3 |
| A | `agent/services/runtime-record.test.js` | 235 | 0 | 1 |
| M | `agent/services/scanner-boundary.test.js` | 15 | 0 | 1 |
| A | `agent/services/scanner-bridge-sqlite-gate.test.js` | 92 | 0 | 1 |
| A | `agent/services/scanner-bridge-start.test.js` | 155 | 0 | 1 |
| A | `agent/services/scanner-bridge-wiring.test.js` | 24 | 0 | 1 |
| A | `agent/services/scanner-collector-work.test.js` | 76 | 0 | 1 |
| M | `agent/services/scanner-collector.test.js` | 27 | 0 | 1 |
| A | `agent/services/scanner-comparison.test.js` | 213 | 0 | 2 |
| M | `agent/services/scanner-integration.test.js` | 70 | 1 | 4 |
| A | `agent/services/scanner-work-tick.test.js` | 128 | 0 | 1 |
| M | `agent/services/sidecar-pins.test.js` | 23 | 1 | 1 |
| M | `agent/services/stage-matrix-account.test.js` | 18 | 5 | 1 |
| A | `agent/services/stage-matrix-s1.test.js` | 283 | 0 | 1 |
| M | `agent/services/stage-matrix.test.js` | 2 | 1 | 1 |
| M | `agent/services/statement-import.test.js` | 2 | 1 | 1 |
| M | `agent/services/storage-report.test.js` | 89 | 2 | 2 |
| M | `agent/services/strategy-liveness.test.js` | 2 | 2 | 1 |
| A | `agent/services/strategy-qualification.test.js` | 325 | 0 | 1 |
| M | `agent/services/strategy-verdicts.test.js` | 23 | 0 | 1 |
| A | `agent/services/stuck-resolver.test.js` | 584 | 0 | 1 |
| M | `agent/services/target-restore.test.js` | 18 | 0 | 1 |
| M | `agent/services/telegram-chart.test.js` | 2 | 1 | 1 |
| M | `agent/services/telegram-digest.test.js` | 63 | 1 | 1 |
| A | `agent/services/tick-entry-work.test.js` | 125 | 0 | 1 |
| A | `agent/services/tick-feeder-stall.test.js` | 156 | 0 | 1 |
| M | `agent/services/tick-permits.test.js` | 6 | 4 | 1 |
| M | `agent/services/tick-readiness.test.js` | 14 | 0 | 1 |
| M | `agent/services/tick-recorder-pull.test.js` | 73 | 0 | 1 |
| A | `agent/services/tick-replay-honesty.test.js` | 385 | 0 | 2 |
| A | `agent/services/tick-replay-live-filters.test.js` | 426 | 0 | 1 |
| A | `agent/services/tick-replay-parity.test.js` | 264 | 0 | 2 |
| M | `agent/services/tick-research-run.test.js` | 15 | 7 | 1 |
| M | `agent/services/tick-research.test.js` | 30 | 1 | 1 |
| A | `agent/services/tick-segment-manifest.test.js` | 377 | 0 | 1 |
| M | `agent/services/tick-segments.test.js` | 55 | 1 | 1 |
| A | `agent/services/tick-shadow-counterfactual.test.js` | 244 | 0 | 1 |
| A | `agent/services/tick-shadow-restart-loss.test.js` | 192 | 0 | 1 |
| M | `agent/services/tick-shadow.test.js` | 4 | 2 | 1 |
| M | `agent/services/tick-validation.test.js` | 55 | 0 | 2 |
| M | `agent/services/tp-suggest.test.js` | 18 | 0 | 1 |
| M | `agent/services/trade-consistency.test.js` | 12 | 5 | 1 |
| M | `agent/services/trade-guard.test.js` | 31 | 0 | 1 |
| M | `agent/services/trade-integrity.test.js` | 125 | 0 | 1 |
| M | `agent/services/trade-plans.test.js` | 40 | 2 | 2 |
| M | `agent/services/trading-coverage-followup.test.js` | 4 | 1 | 1 |
| M | `agent/services/veto-boundary.test.js` | 5 | 2 | 1 |
| M | `agent/services/vol-context-carry.test.js` | 2 | 1 | 1 |
| M | `agent/services/vol-gate.test.js` | 2 | 1 | 1 |
| M | `agent/services/watchdog-calendar-refresh.test.js` | 196 | 2 | 2 |
| A | `agent/services/watchdog-contract-entry-diagnostics.test.js` | 138 | 0 | 1 |
| M | `agent/services/watchdog-contract.test.js` | 45 | 1 | 3 |
| M | `agent/services/watchlists.test.js` | 2 | 1 | 1 |
| A | `agent/shared/report-sessions.test.js` | 141 | 0 | 1 |
| M | `agent/state-stmt-cache.test.js` | 2 | 2 | 1 |
| A | `agent/test-hygiene.test.js` | 150 | 0 | 1 |
| M | `agent/test-support/fake-broker.js` | 160 | 16 | 1 |
| A | `agent/test-support/temp-dir.js` | 64 | 0 | 1 |
| A | `agent/test-support/tmp-guard.js` | 62 | 0 | 1 |
| M | `cpp-exec/src/tests/test_tick_recorder.cpp` | 306 | 2 | 1 |
| M | `cpp-scan-tick/src/tests/test_scanner.cpp` | 91 | 2 | 1 |
| M | `cpp-scan-timeframe/src/tests/test_scanner.cpp` | 119 | 1 | 1 |
| A | `cpp-verify/src/tests/fixtures/node-entry-activity.json` | 28 | 0 | 1 |
| A | `cpp-verify/src/tests/test_entry_diagnostics.cpp` | 105 | 0 | 1 |
| M | `cpp-verify/src/tests/test_watchdog.cpp` | 60 | 0 | 1 |
| M | `cpp-verify/src/tests/test_watchdog_http.cpp` | 14 | 1 | 1 |
| A | `scripts/agent-gate.test.js` | 94 | 0 | 1 |
| A | `scripts/build-commit.test.js` | 28 | 0 | 1 |
| M | `scripts/count-interactions.test.js` | 13 | 1 | 1 |
| A | `scripts/fixtures/blocker-report.json` | 504 | 0 | 1 |
| A | `scripts/perf-trace/synthetic.test.js` | 29 | 0 | 1 |
| A | `src/components/BlockerReport.test.jsx` | 74 | 0 | 1 |
| M | `src/components/account-history.test.jsx` | 63 | 0 | 2 |
| M | `src/components/agent-health-panel.test.jsx` | 53 | 7 | 1 |
| M | `src/components/blocker-report.test.jsx` | 127 | 0 | 3 |
| A | `src/components/common/Card.test.jsx` | 154 | 0 | 2 |
| A | `src/components/common/DataTable.test.jsx` | 59 | 0 | 1 |
| M | `src/components/controller-groups.test.jsx` | 57 | 0 | 2 |
| A | `src/components/currency-lines.test.jsx` | 209 | 0 | 1 |
| A | `src/components/current-account-readings.test.jsx` | 22 | 0 | 1 |
| A | `src/components/data-feed-card.test.jsx` | 174 | 0 | 3 |
| A | `src/components/engine-status-line.test.jsx` | 128 | 0 | 1 |
| M | `src/components/engine-status-panel.test.jsx` | 53 | 0 | 3 |
| A | `src/components/gradient-body.test.jsx` | 60 | 0 | 1 |
| M | `src/components/llm-monitor-status.test.jsx` | 34 | 0 | 1 |
| A | `src/components/llm-spend-card.test.jsx` | 44 | 0 | 1 |
| A | `src/components/momentum-targets.test.jsx` | 56 | 0 | 1 |
| M | `src/components/perf-account-scope.test.jsx` | 2 | 1 | 1 |
| A | `src/components/performance-balances.test.jsx` | 201 | 0 | 3 |
| M | `src/components/performance-evidence.test.jsx` | 11 | 0 | 1 |
| A | `src/components/report-chart.test.jsx` | 88 | 0 | 1 |
| M | `src/lib/agent-api.test.js` | 63 | 0 | 3 |
| A | `src/lib/balance-cells.test.js` | 188 | 0 | 3 |
| A | `src/lib/card-open.test.js` | 71 | 0 | 1 |
| A | `src/lib/currency-money.test.js` | 86 | 0 | 1 |
| M | `src/lib/current-account-totals.test.js` | 60 | 1 | 1 |
| A | `src/lib/daily-stop-display.test.jsx` | 301 | 0 | 3 |
| A | `src/lib/data-feed.test.js` | 259 | 0 | 2 |
| A | `src/lib/data-table-groups.test.js` | 66 | 0 | 1 |
| A | `src/lib/duplicate-money.test.js` | 29 | 0 | 1 |
| M | `src/lib/engine-account-id.test.js` | 21 | 0 | 1 |
| M | `src/lib/engine-status-view.test.js` | 140 | 1 | 3 |
| M | `src/lib/index-html-scripts.test.js` | 15 | 0 | 1 |
| A | `src/lib/latest-prices.test.jsx` | 97 | 0 | 2 |
| A | `src/lib/manual-order-confirm.test.js` | 60 | 0 | 1 |
| A | `src/lib/partial-money.test.js` | 39 | 0 | 1 |
| A | `src/lib/performance-curve-gaps.test.js` | 111 | 0 | 1 |
| M | `src/lib/performance-gradients.test.js` | 81 | 1 | 1 |
| A | `src/lib/scroll-reveal.test.js` | 106 | 0 | 1 |
| A | `src/lib/server-readings.test.js` | 30 | 0 | 1 |
| A | `src/lib/stage-matrix-view.test.js` | 34 | 0 | 1 |
| A | `src/lib/synthetic-presence.test.js` | 72 | 0 | 1 |
| M | `src/lib/ui-control-inventory.test.js` | 17 | 2 | 1 |
| A | `src/lib/use-account-overview.test.js` | 51 | 0 | 1 |
| A | `src/lib/use-engine-status.test.js` | 93 | 0 | 1 |
| A | `src/lib/use-sort.test.jsx` | 35 | 0 | 1 |
| A | `src/pages/ai-page-nav.test.js` | 37 | 0 | 1 |
| M | `src/pages/reasons.test.jsx` | 121 | 18 | 3 |
| M | `src/pages/risk-anchors.test.js` | 20 | 7 | 1 |
| A | `src/pages/risk-scroll-reveal-wiring.test.js` | 36 | 0 | 1 |
<!-- /details -->

### config: 12 files (A 2 · M 10 · D 0), +77 / −20

<!-- details: config: 12 files -->
| St | File | + | − | PRs |
|:-:|---|---:|---:|---:|
| M | `.github/workflows/cpp-scanners.yml` | 2 | 0 | 1 |
| M | `Dockerfile` | 17 | 0 | 1 |
| M | `agent/config/entry-mode-policy.json` | 1 | 1 | 1 |
| A | `agent/config/order-lifecycle.json` | 6 | 0 | 1 |
| M | `agent/config/strategy-pins.json` | 2 | 2 | 1 |
| A | `agent/config/tick-spool-durability.json` | 22 | 0 | 1 |
| M | `agent/package-lock.json` | 7 | 4 | 1 |
| M | `agent/package.json` | 2 | 2 | 1 |
| M | `cpp-scan-tick/railway.json` | 5 | 1 | 1 |
| M | `cpp-scan-timeframe/railway.json` | 5 | 1 | 1 |
| M | `eslint.config.js` | 1 | 1 | 1 |
| M | `vite.config.js` | 7 | 8 | 1 |
<!-- /details -->

### other: 5 files (A 0 · M 5 · D 0), +144 / −1

<!-- details: other: 5 files -->
| St | File | + | − | PRs |
|:-:|---|---:|---:|---:|
| M | `CLAUDE.md` | 102 | 0 | 7 |
| M | `index.html` | 11 | 0 | 1 |
| M | `src/App.jsx` | 5 | 0 | 1 |
| M | `src/cockpit/cockpit-data.js` | 4 | 1 | 1 |
| M | `src/index.css` | 22 | 0 | 1 |
<!-- /details -->

## Appendix C: open work at the cutoff, commits and files

Heads are those on the remote at 26-09 22:00Z (`branches-0600.txt`, matching `git ls-remote`). Files are `git diff b414a06...<head>`: what the branch changes since it left main. Three heads moved in the minutes after the cutoff; their later commits are listed separately and are not counted in the cutoff figures. The gateway `/health` hotfix branch `claude/gw-health-ids` was not on the remote at the cutoff, so it has no list. **Since the cutoff:** the owner merged four of them: #1156 at 22:41:40Z (`9a846d7`), #1162 at 22:42:00Z (`4d269d4`), #1158 at 22:49:57Z (`580308e`) and #1161 at 23:39:04Z (`584237b`). That the owner merged #1161 is **first-hand**; GitHub `merged_by` cannot tell the owner from the session. The S-8 branch became draft PR #1163 (22:36:05Z) and the `/health` hotfix branch draft PR #1164 (23:37:16Z). See the main document, §7.2.

### #1158 · `claude/w2-s2-book` · head `5d1f4a4` at the cutoff

9 files (A 1 · M 8 · D 0), +946 / −105. Commits on the branch that are not on `main` (`git log b414a06..<head>`), newest first:

- `5d1f4a4` 26-09 12:21Z — Wave 2 row 2.1 nit round: the schedule-closed-now retry described as the disagreement case it is; a close that resolved is never re-recorded as a refusal
- `0fd5776` 26-09 12:14Z — Wave 2 row 2.1 fix round 2: a MARKET_CLOSED retry trusts the schedule's next open only when it says closed now, capped at 2 h; a send clears the whole refusal record; a post-send record failure is not a failed close
- `f8cceae` 26-09 11:49Z — Wave 2 row 2.1 fix round: the row-cursor entry hold pinned; one send per cycle; the refused-exit retry backs off
- `7cb263e` 26-09 10:40Z — The momentum book leaves the scan branch; the daily exit asks the broker's hours; a momentum_book heartbeat (Wave 2 row 2.1: S-2 + F2 + F6, OD-2)

**After the cutoff:** head moved to `b6288c8` (branch commits only; commits that came in from `main` are not listed):

- `b6288c8` committed 26-09 22:07Z — Wave 2 row 2.1 small round: the book runs even when a phase before it throws; a market closure clears the refusal count; the hold line prints on change, not every cycle

<!-- details: Files of #1158 at `5d1f4a4`: 9 -->
| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/db.js` | 6 | 1 |
| M | `agent/loop.js` | 116 | 83 |
| M | `agent/services/controller-groups.test.js` | 1 | 1 |
| M | `agent/services/heartbeat.js` | 16 | 0 |
| M | `agent/services/momentum-account.js` | 183 | 14 |
| M | `agent/services/momentum-account.test.js` | 5 | 2 |
| A | `agent/services/momentum-book-out-of-scan.test.js` | 586 | 0 |
| M | `agent/services/momentum-book.js` | 32 | 3 |
| M | `agent/shared/controller-groups.js` | 1 | 1 |
<!-- /details -->

### #1156 · `claude/w2-k3-safe0b` · head `44e1d41` at the cutoff

12 files (A 2 · M 10 · D 0), +527 / −61. Commits on the branch that are not on `main` (`git log b414a06..<head>`), newest first:

- `44e1d41` 26-09 11:39Z — Nits: K3 header no longer claims 0/0 stays unknown; spring-forward DST test; Re-Risk confirm names the traded account too
- `552cf28` 26-09 10:34Z — K3: a 0/0 holiday row closes its whole local day (OD-7); SAFE-0b: Re-Risk apply refuses a stale or other-account proposal and the confirm names its keys (OD-14)

**After the cutoff:** head moved to `afe84d9` (branch commits only; commits that came in from `main` are not listed):

- `afe84d9` committed 26-09 21:53Z — K3 + SAFE-0b fix round: Cancel on the Re-Risk confirm proven to post nothing; own-key proposals only; projection tests for recurring and DST rows
- `caee268` committed 26-09 21:43Z — Merge origin/main (b414a06) into K3 + SAFE-0b; inventory regenerated

<!-- details: Files of #1156 at `44e1d41`: 12 -->
| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/lib/calendar-intervals.js` | 7 | 3 |
| M | `agent/routes/actions.js` | 15 | 1 |
| A | `agent/routes/risk-reassess-apply.test.js` | 142 | 0 |
| M | `agent/services/calendar-coverage.js` | 4 | 3 |
| M | `agent/services/calendar-coverage.test.js` | 38 | 9 |
| M | `agent/services/market-calendar.js` | 38 | 14 |
| M | `agent/services/market-calendar.test.js` | 141 | 26 |
| M | `agent/services/risk-reassess.js` | 42 | 0 |
| M | `docs/ui-control-inventory.md` | 4 | 4 |
| M | `src/components/RiskReassess.jsx` | 12 | 1 |
| M | `src/lib/risk-proposal-status.js` | 27 | 0 |
| A | `src/lib/risk-proposal-status.test.js` | 57 | 0 |
<!-- /details -->

### #1155 · `claude/w2-cv2` · head `88d3dd8` at the cutoff

12 files (A 1 · M 11 · D 0), +483 / −7. Commits on the branch that are not on `main` (`git log b414a06..<head>`), newest first:

- `88d3dd8` 26-09 10:43Z — V3 CV-2 fix round: the mute writes only a state this process owns
- `5fae4bc` 26-09 10:25Z — V3 CV-2 (OD-10): cpp-verify delivery muted through a 24 h soak

<!-- details: Files of #1155 at `88d3dd8`: 12 -->
| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/services/controller-groups.test.js` | 1 | 1 |
| M | `agent/services/heartbeat.js` | 13 | 0 |
| M | `agent/services/independent-protection.js` | 35 | 0 |
| A | `agent/services/verify-watchdog-soak.test.js` | 129 | 0 |
| M | `agent/shared/controller-groups.js` | 1 | 1 |
| M | `cpp-verify/src/main.cpp` | 19 | 1 |
| M | `cpp-verify/src/tests/test_watchdog.cpp` | 61 | 0 |
| M | `cpp-verify/src/tests/test_watchdog_http.cpp` | 44 | 0 |
| M | `cpp-verify/src/watchdog.cpp` | 29 | 2 |
| M | `cpp-verify/src/watchdog.hpp` | 29 | 0 |
| M | `cpp-verify/src/watchdog_state.cpp` | 63 | 2 |
| M | `docs/independent-watchdog-2026-09-22.md` | 59 | 0 |
<!-- /details -->

### #1159 · `claude/w2-m7` · head `a73efbb` at the cutoff

7 files (A 3 · M 4 · D 0), +1,144 / −120. Commits on the branch that are not on `main` (`git log b414a06..<head>`), newest first:

- `a73efbb` 26-09 12:54Z — M7 nit round: strengthen two wiring tests, fix a late-stream socket leak
- `34b95d8` 26-09 12:28Z — M7 fix round: never evaluate a cached/stale quote; fair cap; validated cap
- `912d9f3` 26-09 12:08Z — M7: parallel broker-fallback probes under a cap, with backoff <= 5 min

<!-- details: Files of #1159 at `a73efbb`: 7 -->
| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/lib/ctrader-ws.js` | 34 | 7 |
| M | `agent/lib/ctrader-ws.test.js` | 54 | 1 |
| A | `agent/lib/fast-monitor-probes.js` | 218 | 0 |
| A | `agent/lib/fast-monitor-probes.test.js` | 244 | 0 |
| A | `agent/services/fast-monitor-m7-probes.test.js` | 337 | 0 |
| M | `agent/services/fast-monitor-sidecar-quotes.test.js` | 9 | 1 |
| M | `agent/services/fast-monitor.js` | 248 | 111 |
<!-- /details -->

### #1161 · `claude/w2-c8-c9` · head `e1f9263` at the cutoff

11 files (A 1 · M 10 · D 0), +1,053 / −96. Commits on the branch that are not on `main` (`git log b414a06..<head>`), newest first:

- `e1f9263` 26-09 13:09Z — C9 fix round: the restart hold is keyed on the boot change, and expireStale cannot lift it
- `f9e566e` 26-09 12:28Z — C9 (SEQUENCE PR-9): tick combined risk, Node side — unsettled fires, book cap on tick, re-validation, boot binding
- `9d66ba1` 26-09 11:56Z — C8 (SEQUENCE PR-8): the book-wide symbol cap reads `side`, so held positions and in-flight orders count

**After the cutoff:** head moved to `e7aa9ae` (branch commits only; commits that came in from `main` are not listed):

- `e7aa9ae` committed 26-09 22:07Z — C8/C9 fix round 2: ended in-flight rows stop holding the book cap; the restart hold reads the snapshot's request time; an index for the per-call fire read

<!-- details: Files of #1161 at `e1f9263`: 11 -->
| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/services/account-pregate.js` | 3 | 2 |
| M | `agent/services/book-symbol-cap.js` | 9 | 2 |
| M | `agent/services/book-symbol-cap.test.js` | 49 | 18 |
| M | `agent/services/entry-ledger.js` | 85 | 9 |
| M | `agent/services/heartbeat.js` | 35 | 4 |
| M | `agent/services/reconciler.js` | 10 | 1 |
| M | `agent/services/risk.js` | 28 | 1 |
| A | `agent/services/tick-combined-risk.test.js` | 464 | 0 |
| M | `agent/services/tick-permits.js` | 331 | 50 |
| M | `agent/services/tick-permits.test.js` | 10 | 9 |
| M | `docs/dual-environment-plan-2026-09-25.md` | 29 | 0 |
<!-- /details -->

### #1162 · `claude/w2-b2b-ui5` · head `a9ec8e6` at the cutoff

21 files (A 4 · M 17 · D 0), +1,587 / −48. Commits on the branch that are not on `main` (`git log b414a06..<head>`), newest first:

- `a9ec8e6` 26-09 14:35Z — Named corrections: #309's evidence gives its read date, not its import date
- `647d82f` 26-09 14:33Z — Row 2.6 last nits: pin the sweep arg, tighten ids, evidence strings
- `0633271` 26-09 14:00Z — Row 2.6 fix round nits N2-N7
- `c99485d` 26-09 14:00Z — B1 (checker fix round, row 2.6): fix the wrong-site write-off exclusion
- `752f9e7` 26-09 13:15Z — UI-5 (RS-1): trade-plan flags — flag wrong-unit plans read-only, D5's correction stays a separate step
- `a36a313` 26-09 13:13Z — UI-5 (RS-1): the phase-audit split — switch flips no longer drowned out by controller events
- `2410b0e` 26-09 13:11Z — UI-5 (RS-1): the refusal-time window — window on when the refusal happened, not when the scorer got to it
- `c3ca02d` 26-09 13:11Z — UI-5 (RS-1): the re-stamp fix — stop re-stamping written-off rows
- `ebe1bb7` 26-09 13:03Z — UI-5 (RS-1a): gross P&L consistency — name the fee or swap, not a guess
- `3367b0f` 26-09 12:55Z — Nit round for B2b named-corrections: named-not-recomputed apply, real deal breakdowns, #309/#310 wording (checker: MERGE, no blockers)
- `bf1e0c0` 26-09 12:20Z — Fix round for B2b named-corrections: absolute-only money fixes, #47 removed, OD-11 scope narrowed (checker: FIX FIRST)
- `f5f24ef` 26-09 11:59Z — B2b + UI-5 named corrections: OD-11 write-off gate and OD-12 dry-run/apply (Wave 2 pre-build, unmerged)

<!-- details: Files of #1162 at `a9ec8e6`: 21 -->
| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/db.js` | 6 | 0 |
| M | `agent/routes/actions.js` | 82 | 0 |
| M | `agent/routes/actions.test.js` | 53 | 1 |
| A | `agent/routes/named-corrections-route.test.js` | 147 | 0 |
| A | `agent/routes/state-phase-audit.test.js` | 68 | 0 |
| M | `agent/routes/state.js` | 15 | 5 |
| A | `agent/services/named-corrections.js` | 322 | 0 |
| A | `agent/services/named-corrections.test.js` | 396 | 0 |
| M | `agent/services/old-position-pnl.js` | 7 | 1 |
| M | `agent/services/old-position-pnl.test.js` | 18 | 0 |
| M | `agent/services/phase-audit.js` | 52 | 20 |
| M | `agent/services/phase-audit.test.js` | 35 | 1 |
| M | `agent/services/pnl-backfill.js` | 47 | 3 |
| M | `agent/services/pnl-backfill.test.js` | 86 | 1 |
| M | `agent/services/pnl-reconcile-stall.test.js` | 6 | 1 |
| M | `agent/services/refusal-ledger.js` | 39 | 5 |
| M | `agent/services/refusal-ledger.test.js` | 24 | 0 |
| M | `agent/services/trade-consistency.js` | 60 | 7 |
| M | `agent/services/trade-consistency.test.js` | 63 | 1 |
| M | `agent/services/trade-plans.js` | 19 | 1 |
| M | `agent/services/trade-plans.test.js` | 42 | 1 |
<!-- /details -->

### T4 (no PR) · `claude/w2-t4` · head `d3b01c8` at the cutoff

21 files (A 5 · M 16 · D 0), +2,131 / −144. Commits on the branch that are not on `main` (`git log b414a06..<head>`), newest first:

- `d3b01c8` 26-09 13:05Z — T4 nit round: a switch-off test of the daily account's HTF resting branch (N1) and a behavioural rollback test of the intent/INSERT transaction (N2)
- `db2f551` 26-09 12:59Z — Merge remote-tracking branch 'origin/claude/w2-s2-book' into claude/w2-t4
- `699aace` 26-09 12:30Z — T4 built OFF: momentum market entries carry the partial-TP1 plan behind a switch; a closed-market momentum entry is refused by name (Wave 2 row 2.7: V3 item 32, OD-3)
- `5d1f4a4` 26-09 12:21Z — Wave 2 row 2.1 nit round: the schedule-closed-now retry described as the disagreement case it is; a close that resolved is never re-recorded as a refusal
- `0fd5776` 26-09 12:14Z — Wave 2 row 2.1 fix round 2: a MARKET_CLOSED retry trusts the schedule's next open only when it says closed now, capped at 2 h; a send clears the whole refusal record; a post-send record failure is not a failed close
- `f8cceae` 26-09 11:49Z — Wave 2 row 2.1 fix round: the row-cursor entry hold pinned; one send per cycle; the refused-exit retry backs off
- `7cb263e` 26-09 10:40Z — The momentum book leaves the scan branch; the daily exit asks the broker's hours; a momentum_book heartbeat (Wave 2 row 2.1: S-2 + F2 + F6, OD-2)

<!-- details: Files of T4 (no PR) at `d3b01c8`: 21 -->
| St | File | + | − |
|:-:|---|---:|---:|
| A | `agent/config/momentum-entries.json` | 5 | 0 |
| M | `agent/db.js` | 6 | 1 |
| M | `agent/dispatch-provenance.test.js` | 1 | 1 |
| M | `agent/lib/fill-anchor.test.js` | 5 | 3 |
| M | `agent/lib/one-account-model.test.js` | 1 | 1 |
| M | `agent/loop.js` | 305 | 94 |
| M | `agent/routes/momentum-target-status.test.js` | 28 | 7 |
| M | `agent/services/controller-groups.test.js` | 1 | 1 |
| M | `agent/services/heartbeat.js` | 16 | 0 |
| M | `agent/services/momentum-account.js` | 183 | 14 |
| M | `agent/services/momentum-account.test.js` | 5 | 2 |
| A | `agent/services/momentum-book-out-of-scan.test.js` | 586 | 0 |
| M | `agent/services/momentum-book.js` | 32 | 3 |
| M | `agent/services/momentum-entry-contract.js` | 60 | 16 |
| A | `agent/services/momentum-entry-producer.js` | 341 | 0 |
| A | `agent/services/momentum-entry-switch.js` | 42 | 0 |
| A | `agent/services/momentum-entry-t4.test.js` | 404 | 0 |
| M | `agent/services/momentum-partial-runtime.js` | 17 | 0 |
| M | `agent/services/momentum-target-policy.js` | 23 | 0 |
| M | `agent/shared/controller-groups.js` | 1 | 1 |
| M | `docs/v3-momentum-entry-contract-2026-09-25.md` | 69 | 0 |
<!-- /details -->

### S-8 + WEB-6b (no PR) · `claude/w3-s8-web6b` · head `8b98ad3` at the cutoff

28 files (A 5 · M 23 · D 0), +1,717 / −96. Commits on the branch that are not on `main` (`git log b414a06..<head>`), newest first:

- `8b98ad3` 26-09 14:58Z — S-8 fix round 2: the missing-map read is bounded like the calendar read; per-account cooldown; separate loop and route budgets
- `c9ec6fb` 26-09 14:10Z — S-8 fix round: strict K3 readings, a bounded entry-path re-read, the map fallback, and the pinned wiring
- `62c2047` 26-09 13:57Z — Merge K3 + SAFE-0b (claude/w2-k3-safe0b 44e1d41) so S-8 cannot land without it; inventory regenerated
- `2fce83d` 26-09 13:41Z — Holidays on the entry path, UNKNOWN never reads open; broker-listed holidays in the session report (Wave 3.2: S-8, WEB-6b) — DRAFT pre-build
- `44e1d41` 26-09 11:39Z — Nits: K3 header no longer claims 0/0 stays unknown; spring-forward DST test; Re-Risk confirm names the traded account too
- `552cf28` 26-09 10:34Z — K3: a 0/0 holiday row closes its whole local day (OD-7); SAFE-0b: Re-Risk apply refuses a stale or other-account proposal and the confirm names its keys (OD-14)

<!-- details: Files of S-8 + WEB-6b (no PR) at `8b98ad3`: 28 -->
| St | File | + | − |
|:-:|---|---:|---:|
| M | `agent/lib/calendar-intervals.js` | 7 | 3 |
| M | `agent/lib/ctrader-auth-reactive.test.js` | 16 | 0 |
| M | `agent/lib/ctrader-ws.js` | 20 | 6 |
| M | `agent/loop.js` | 26 | 5 |
| M | `agent/routes/actions.js` | 15 | 1 |
| A | `agent/routes/risk-reassess-apply.test.js` | 142 | 0 |
| M | `agent/services/blocker-report.js` | 3 | 2 |
| M | `agent/services/blocker-report.test.js` | 12 | 0 |
| M | `agent/services/calendar-coverage.js` | 8 | 6 |
| M | `agent/services/calendar-coverage.test.js` | 38 | 9 |
| A | `agent/services/entry-hours.js` | 297 | 0 |
| A | `agent/services/entry-hours.test.js` | 458 | 0 |
| M | `agent/services/gate-skips.js` | 27 | 0 |
| M | `agent/services/market-calendar.js` | 41 | 14 |
| M | `agent/services/market-calendar.test.js` | 141 | 26 |
| M | `agent/services/performance-populations.js` | 26 | 4 |
| M | `agent/services/performance-populations.test.js` | 56 | 0 |
| M | `agent/services/risk-reassess.js` | 42 | 0 |
| A | `agent/services/session-holidays.js` | 71 | 0 |
| M | `agent/shared/performance-populations.js` | 17 | 1 |
| M | `agent/shared/report-sessions.js` | 95 | 7 |
| M | `agent/shared/report-sessions.test.js` | 42 | 1 |
| M | `docs/performance-populations-2026-09-22.md` | 12 | 3 |
| M | `docs/ui-control-inventory.md` | 4 | 4 |
| M | `src/components/RiskReassess.jsx` | 12 | 1 |
| M | `src/lib/risk-proposal-status.js` | 27 | 0 |
| A | `src/lib/risk-proposal-status.test.js` | 57 | 0 |
| M | `src/pages/Performance.jsx` | 5 | 3 |
<!-- /details -->

### GW-1 (no PR) · `claude/w3-gw1` · head `532f64d` at the cutoff

26 files (A 7 · M 19 · D 0), +1,841 / −141. Commits on the branch that are not on `main` (`git log b414a06..<head>`), newest first:

- `532f64d` 26-09 15:41Z — GW-1 fix round 2: the open /health really carries no account or symbol id (checker B1b) — guard and shadow-sim builders extracted and tested; refund and expiry pinned; seal log counts drops
- `2d1e88a` 26-09 14:19Z — GW-1 fix round: the open /health carries no account id (checker B1); no_permit named before the cap; late quotes at shutdown counted dropped; entrypoint comment path
- `0876084` 26-09 13:26Z — GW-1 (3/3): Node reads the sidecar's startedAtMs and commit from /health
- `383ad58` 26-09 13:26Z — GW-1 (2/3): P8c — the SIGTERM seal and exit 143, setpriv, draining, GAP_RESTART at every boot, salvage, torn bytes under the cap, checked return codes, mount kind, lifetime counters, the commit
- `ef84336` 26-09 13:26Z — GW-1 (1/3): the gateway half of WP-D — per-fire slots, full-replace permits, spend after checks, profile and boot refusals, bar entries spend slots; mirror destroyed outside vpoMtx

<!-- details: Files of GW-1 (no PR) at `532f64d`: 26 -->
| St | File | + | − |
|:-:|---|---:|---:|
| M | `.github/workflows/cpp-exec.yml` | 2 | 0 |
| M | `agent/lib/entry-producers.test.js` | 2 | 1 |
| M | `agent/lib/exec-engine.js` | 8 | 0 |
| M | `agent/lib/exec-engine.test.js` | 25 | 0 |
| M | `agent/services/runtime-manifest.js` | 4 | 4 |
| M | `cpp-exec/Dockerfile` | 4 | 1 |
| A | `cpp-exec/entrypoint-signal-test.sh` | 42 | 0 |
| M | `cpp-exec/entrypoint.sh` | 10 | 1 |
| M | `cpp-exec/railway.json` | 1 | 0 |
| M | `cpp-exec/src/engine.cpp` | 8 | 0 |
| M | `cpp-exec/src/engine.hpp` | 7 | 0 |
| A | `cpp-exec/src/health_view.cpp` | 49 | 0 |
| A | `cpp-exec/src/health_view.hpp` | 35 | 0 |
| M | `cpp-exec/src/main.cpp` | 112 | 43 |
| A | `cpp-exec/src/term_seal.cpp` | 49 | 0 |
| A | `cpp-exec/src/term_seal.hpp` | 38 | 0 |
| M | `cpp-exec/src/tests/test_async_session.cpp` | 42 | 0 |
| M | `cpp-exec/src/tests/test_engine_send_boundary.cpp` | 22 | 0 |
| A | `cpp-exec/src/tests/test_health_view.cpp` | 129 | 0 |
| A | `cpp-exec/src/tests/test_term_seal.cpp` | 158 | 0 |
| M | `cpp-exec/src/tests/test_tick_firer.cpp` | 335 | 2 |
| M | `cpp-exec/src/tests/test_tick_recorder.cpp` | 210 | 29 |
| M | `cpp-exec/src/tick_firer.cpp` | 196 | 24 |
| M | `cpp-exec/src/tick_firer.hpp` | 77 | 0 |
| M | `cpp-exec/src/tick_recorder.cpp` | 233 | 35 |
| M | `cpp-exec/src/tick_recorder.hpp` | 43 | 1 |
<!-- /details -->

