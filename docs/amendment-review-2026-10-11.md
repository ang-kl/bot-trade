# Read-only review of the research programme against the amendment

Claude · № 13,100 · 11-10'26 10:25 SGT · claude-builder. Ordered by the owner's
instruction of 11-10 (read `2026-1011-agile-frolicking-wigderson.md`, then the
amendment, then review the work already done against the amendment's six
areas). This review changed no application code, configuration, policy or
stored result; it built, deployed, merged and ran nothing. It uses the
amendment's criteria wherever they correct the original plan.

The original run evidence (`docs/theory-gap-report-2026-10-11.md`, № 13,098)
is kept as the historical record and is not overwritten; this document marks
which of its conclusions survive the amendment and which become provisional
or unsupported.

## 1. Actual completion state

Implementation, validation, merge, deployment and research execution are
listed apart, because completing one does not complete the others.

| Plan step | Implemented (commit) | Validated (local gate, revision, time UTC) | Merged (PR, squash sha) | Deployed (Railway bot-trade, env 7bc0dfc6) | Research executed |
|---|---|---|---|---|---|
| 1 boundary script, isolation test, research.json | dbe3ac5e | gate green on dbe3ac5e (01:1x) | #1308 → 8a12c454 | c3d61edd SUCCESS 01:35:48Z | n/a |
| 2 r-audit route | f66300a4 → 825f0172 | gate green on e247fb28 (01:43) | #1309 → 770892fe | deploy at 01:46:5xZ (SKIPPED rows for the gateways, Node deploy succeeded; read back live at 01:5x) | read-only report reads only |
| 3 exit-replay additive rules + golden | daaf1f3a → ee6c31d0 | same | #1309 | same | n/a |
| 4 exit-counterfactual extensions | 48d70f4c → e247fb28 | same | #1309 | same | read-only report reads (02:0x) |
| 5 regime-block counts | 32aea324 → 45219dbb | gate green on f99b256d (01:55) | #1310 → 005f9c07 | 16e02e69 SUCCESS 01:57:45Z; `/health` commit 005f9c0 | read-only report read (02:0x) |
| 6 tick-bars.js | 52b23dbf → 618016fa | same | #1310 | same | never executed on recorded ticks in production |
| 7 runBacktest research options + golden | a4e0fced → f99b256d | same | #1310 | same | n/a |
| 8 bar-form research job | e5ea2cb5, df291964 | first gate on e5ea2cb5 (02:11) FAILED 1 test (one-account model); fixed in df291964; gate on 98f79c49 running at review time | #1311 OPEN (not merged) | not deployed (`GET /state/bar-form-research` answers 404 on 005f9c0) | **never run**: no dry run, no small run, no `bar_form_runs` row can exist |
| 9 broker cross-check, gate tag | a2926215 | in the same pending gate | #1311 OPEN | not deployed | never run |
| Codex findings on #1309/#1310 | 98f79c49 | same pending gate | #1311 OPEN | not deployed | n/a |

Identities: production service bot-trade `04945f5c-03d4-4d3f-bec1-f4debcefe5e6`,
environment `7bc0dfc6-82c5-406c-a621-fd3ff549674d`; registry accounts 7
(42993489 live active; 43002148, 43069009 live archived; 43097342, 46130058,
47790949 demo active; 46979908 demo manage_only). The read-only report reads
of 02:0x UTC were made over all accounts (no account scope) on commit 005f9c0.

**What is incomplete, inaccessible or unknown**

- No research run exists; every "run" artefact the amendment asks for
  (run id, input manifest, coverage, completion, cleanup) is absent by
  construction, not lost.
- The local gate receipts are logs in this session's scratchpad
  (`gate-1309.log` 01:43Z on e247fb28; `gate-1310.log` 01:55Z on f99b256d;
  `gate-1311.log` 02:11Z on e5ea2cb5, 1 failure). They are not in the
  repository; CI check runs on GitHub carry the same heads.
- Whether any operator ran the manual backtest action with `volGate` on
  between 01:57Z (#1310 live) and the #1311 fix is unknown to this session
  (no log read was made); see area 6.
- Production CPU, memory, lock waits and event-loop lag during the 02:0x
  report reads were not measured.

## 2. Amendment compliance table

| Area | Status | Evidence inspected | Missing evidence | Affected claims |
|---|---|---|---|---|
| 1 Runtime impact and cleanup | **not satisfied** | `agent/config/research.json` declares `pauseBetweenSegmentsMs`, `maxSegmentsPerRun`, `maxSymbolsPerRun`, `calibrationSegments`, `computeWindowBars` only. No CPU, memory, runtime, cancellation-latency, temp-bytes, transaction-duration, lock-wait, gateway-rate or event-loop-lag limit is declared anywhere. Cleanup in code: segment deleted after processing (`bar-form-research-core.js`), slot released on done/aborted/failed/exit (`bar-form-research.js` finish), abort flag polled between segments. No baseline measured. | A measured baseline; declared limits and breach actions; in-run detection; cleanup after a hard kill (the cache is under `os.tmpdir()`, which a container restart clears, but nothing in-process can promise it); storage estimate for the maximum result matrix (12 symbols × 6 forms × 12 strategies = 864 cells per run, size unmeasured). | The plan's "no impact on live trade management" reads as **not established**; the small run cannot be declared ready. "Short transaction" is not "zero lock impact": `persistRun` takes SQLite's writer lock for one transaction of up to 864 rows. |
| 2 Tick semantics and comparability | **not satisfied** | Event definition is explicit in `agent/lib/tick-bars.js` `countsAsTick` (two-sided, non-snapshot, non-crossed, changed quote; repeats, snapshots, crossed, one-sided and gaps tallied in `dropped`); price = bid; clock = recorder receive time (`recvMs`); broker time is absent from the stream (`brokerTsMs: null` in the decoder). Gaps mark the open bar and the next; silence over `maxSilenceMs` marks the next; runs split at invalid bars; a run shorter than `minBars + 31` is not replayed. Broker cross-check: built (#1311, `agent/lib/bar-crosscheck.js`), **never run**; it compares OHLC and the activity-count ratio, **not** the Donchian prior-20-bar ratio or the gate decision. N calibration: `calibrationSegments` = the first segments of the **same** run data; not a training-only split. Tick bars pass the **nominal** label (`1m`, `5m`) to strategies, so time caps and `parseTimeframe`-based rules read nominal time, not elapsed time. | The executed cross-check with predeclared tolerances; the Donchian ratio/gate agreement; a training-only N; elapsed-time semantics for fixed-N bars. | "Donchian works unchanged on tick-built time bars" is **unsupported** until parity is measured. Fixed-N bars are a separate variant (the code labels `v` as bar speed, which is correct, but the strategies still read `v` as volume). |
| 3 Initial-R provenance | **not satisfied** (sensitivity analysis only) | `r-audit` computes R under six candidate stops. Lineage: `trades.broker_sl_initial` is written by `reconciler.js:584` as the **first stop the reconciler observed** on the broker position (`WHERE broker_sl_initial IS NULL`), which is after the fill and after any amend that preceded the first reconcile; it is not the accepted initial protection from the opening order receipt. `proposal_sl` is the gate's proposal; `planned_sl` the plan; `initial_risk` the monitor row's distance (units: price, lineage undocumented in the audit); postmortem and current stops are trailed. Partials: `fillWeightedR` uses `broker_deals` lots-weighted close price; commissions, fees and swaps are not in any R figure (price-based R only). No source-precedence rule is documented. | A per-episode provenance chain (opening fill, accepted initial SL/TP, timestamps, amendments) and a precedence rule; cost-inclusive episode P&L beside PF_R. | The report's "true tsmom PF 0.60 against the broker's initial stop" is **provisional**: it shows the postmortem's 1.45 divides by a trailed stop (that part is established by the 39/56 difference count), but it does not establish that `broker_sl_initial` is the risk accepted at entry. Every R figure in the report (actual PF 0.52, every replay row) carries this unresolved denominator. |
| 4 Replay fairness and policy history | **not satisfied** | The extended counterfactual resolves `loadManagedExit(db)` **at request time** (today's `managed_exit_json` over defaults) and labels the rule `managed_approx`: a current-policy scenario, correctly not a historical replay, but the report table does not say which policy applied to each historical trade. Truncation: each rule scores only trades it resolves, so denominators differ by variant (as_traded 51 scored / 100 truncated against managed_approx 98 / 53) — censored trades are dropped differently by variant. Intrabar: a bar touching stop and target is `ambiguous` and excluded (exit-replay.js:220); stop-before-target otherwise. Costs: none (price-based exits at the level; no spread, slippage, commission). Fills: at the level. Portfolio effects (margin pool, position caps, the keeper's account-level arm) are omitted and not stated per row. | A common cohort with a common horizon and one censoring rule across variants; declared cost assumptions; a per-trade policy-applicability record for any historical-policy claim. | The exit table in the report (§4) is **not interpretable as a comparison between variants** until the denominators are made common; it remains a per-rule descriptive figure. "Chandelier alone PF 0.79 on breakouts" and "exit-at-mean worse than the stack" are **withdrawn as comparisons**. |
| 5 Statistical conclusions | **not satisfied** (hypotheses only) | Regime missingness: 40% of the 523 closes had no regime label (№ 13,089); the extended route now reports `(none)` groups and `gateTag.unknown` (step 9, not deployed). No holdout, no walk-forward, no predeclared primary comparison, no uncertainty on any exit figure, no dependence accounting (repeated signals, shared periods, several accounts on one opportunity). The plan's "about ±0.28R at 50 trades" has no stated variance, confidence or dependence assumption. | The predeclared design; uncertainty per cell (the bar-form job computes `expectancyLowerR` and `mdeR` but has not run); holdout. | The regime "reversal" (breakouts doing better against the trend) stays a **hypothesis**. The ±0.28R claim is **withdrawn**. The 30-trade floor screens, it does not establish precision. |
| 6 Isolation and shared dependencies | **partly satisfied; one live-closure change found** | The isolation test now names tiers: strict research modules (config loader, tick-bars, theory-gap, research-slot, bar-form core); `READ_ONLY_PROTECTED` reach for `regime.js` / `regime-gate.js`; doors (bar-form service, worker, tick-research door, state/actions routes, report worker, exit-counterfactual-extended) pinned to call no state writer or order function. Import-time effects of the live loaders research reaches: no top-level timers, subscriptions or process hooks in `managed-exit.js`, `mae-chandelier-observe.js`, `capped-hybrid-policy.js`, `regime.js`, `regime-gate.js`, `strategies.js` (grep of this revision; transitive closure not audited). Protected no-diff: 43 paths identical on every PR. **Edited shared dependencies in the live closure:** `agent/scripts/backtest-fib.js` is imported by `strategy-autopilot.js` (production, `autopilot_mode: auto`, last run 02:20:46Z) and by the manual backtest action; `tick-research-run.js` (the slot). The golden test pins default `runBacktest` output byte-identical; the Codex P2 on #1310 showed the gap the amendment names: with `volGate` on, the merged #1310 made one extra `widenStop` call per entry, inflating the `stopsWidened` counter. The autopilot passes no `volGate` (its output is the golden's default path); the manual backtest route can. Fixed in 98f79c49 (#1311, unmerged). | Transitive import-time audit of the reached closure; a regression receipt for `strategy-autopilot` on the edited module; whether any `volGate` backtest was requested between 01:57Z and the fix. | "Live behaviour unchanged" is **established for the default backtest path by the golden** and for the protected files by the no-diff; it is **not established for `volGate` backtest reports in the window above** (reporting field only; no trading decision reads `stopsWidened`, per the code read, but this review ran no test to prove it). |

Legacy response contracts: `/state/exit-counterfactual` legacy JSON is
pinned identical by `agent/routes/exit-counterfactual-route.test.js` (a
direct-call comparison); `exit-replay` legacy rules by
`agent/lib/golden/exit-replay.golden.json`; `runBacktest` defaults by
`agent/lib/golden/backtest.golden.json`. These are the regression receipts
the amendment asks to review; they passed in the gates named above. This
review ran none of them.

## 3. Revised conclusions

**Still supported (with their limits)**

- The postmortem's R for tsmom divides by a stop the momentum book had
  already trailed on 39 of 56 trades, and the ledger and postmortem disagree
  on 37 of 56. This is a record fact, independent of which stop is the true
  initial one.
- The regime gate's QUIET rule refused 17 episodes in 30 days against 385
  trend-vs-trend and 278 fade-vs-trend episodes. Counts of recorded skips;
  nothing scored.
- 102 of 151 replayable trades over 90 days run past their stored window
  before stop or target: the stored windows are the limiting instrument.

**Provisional (a prerequisite is missing)**

- "tsmom's true PF is 0.60": true for the `broker_sl_initial` candidate; the
  candidate is the reconciler's first observation, not proven initial
  protection (area 3).
- Every replay figure in the report's §4 (actual 0.52, managed_approx 0.67,
  own target 0.18, and the rest): current-policy scenario, uncommon
  denominators, no costs (areas 3, 4).
- The follow-through bracket (3.3% / 70.9% at +1R): the Codex P1 fix in
  #1311 changes it; it must be re-read after deploy and is not quotable now.

**Cannot presently be interpreted**

- Any ranking between exit variants, any per-family verdict (mean reversion
  vs breakout exits), the regime reversal, and any bar-form comparison
  (nothing has run).

## 4. Minimal remediation proposal (research-only; code apart from provenance)

**Code (small PRs, each gated; none touches a protected file)**

- R1. Replay fairness: one common cohort and one censoring rule across
  variants in `exit-counterfactual-extended.js` (score a trade for a variant
  only if every compared variant resolves it, and report the dropped count),
  plus a declared cost field (spread at exit from the stored bars where
  present; otherwise "none") printed per rule. Validation: a fixture where
  variants resolve different subsets must yield equal denominators.
- R2. Tick forms: the elapsed-time label for fixed-N bars (pass the bar's own
  `durMs`-derived timeframe or refuse strategies that parse the label), and a
  training-only N (calibration segments excluded from the evaluated series,
  recorded in the manifest). Validation: the core test's calibration case
  asserts the evaluated bars start after the calibration prefix.
- R3. Cross-check: add the Donchian prior-20-bar ratio and gate decision
  agreement to `bar-crosscheck.js`, with predeclared tolerances read from
  `research.json`. Validation: a synthetic pair where the ratio agrees and
  the gate disagrees.
- R4. Limits: a `limits` section in `research.json` the job refuses to start
  without (worker memory, max runtime, max temp bytes, max cells, max
  transaction rows, gateway pulls per minute), with the worker reporting
  observed values per segment and aborting on breach. Validation: a fake
  worker that reports a breach ends the run as `aborted` with the breach
  named.
- R5. Isolation: a test that pins `strategy-autopilot`'s `runBacktest`
  options to the golden's default path, and an import-time audit (load each
  reached live module in a child process and assert no timer or subscription
  is created).

**Data and provenance (code cannot recover what was not retained)**

- P1. Initial-R provenance per episode: the opening order receipt, the
  accepted initial SL/TP and their timestamps exist for trades opened since
  the keeper receipts (#1306) and the tick entry proof; older trades have at
  best `broker_sl_initial`. A precedence rule must be written and each trade
  tagged `accepted` / `first_observed` / `unresolved`; unresolved trades stay
  out of R rankings. This is a record audit, ask-first where it writes a tag.
- P2. Stored replay windows: 68% truncation cannot be recovered; extending
  windows (`/state/aftermath-extend-preview`) is a forward fix the owner
  approves (decision D0 of the report).
- P3. Baseline measurements before any run: Railway CPU/memory/disk for
  bot-trade and the serving gateway, event-loop lag and fast-monitor skips
  from the heartbeat, SQLite busy counts, for a full loop cycle, recorded with
  times.

## 5. Next-run readiness

The amendment's prerequisites are **not established**. In the amendment's
revised sequence: step 1 (provenance, permitted dependencies, config
snapshot, resource/cancellation requirements) is partly done (dependency
tiers and the config snapshot are explicit; limits and provenance are not);
step 2 (R denominator audit) is a sensitivity analysis, not a provenance
audit; step 3 (pure bar construction, then the bounded cross-check) is built
but the cross-check has not run and lacks the Donchian comparison; step 4
(frozen design, splits, assumptions) is not written; step 5 (isolation,
legacy behaviour, streaming bounds, cleanup validation) is partly done
(goldens, isolation tiers, in-process cleanup) with limits and hard-kill
cleanup open.

Unresolved before a small run: R4 limits and P3 baseline; R2 training-only
N and elapsed-time labels; R3 cross-check content; the predeclared
comparison design (area 5). PR #1311 (steps 8–9 and the Codex fixes) is held
unmerged during this review; its merge is the owner's word now, not the
standing policy's, because this instruction excluded merges from the review.

This is a readiness assessment, not authorization to execute.

Conversation ref: ordered by the owner's 11-10 instruction · reported
№ 13,100. Session https://claude.ai/code/session_01C1hz86KuE5JKVq6W2KtUE2.
