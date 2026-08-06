# Result — Bot-Trade Algorithmic Decision Integrity Audit

**Prompt executed:** `instr/Bot-Trade_Algorithmic_Decision_Integrity_Audit_Prompt_v1.0.md` (v1.0, 1,144 lines)
**Run started:** 2026-08-05 22:35 UTC · **completed:** 2026-08-05 23:0x UTC
**Frozen SHA:** `0e6465158337c40d70952334b685551c7afdd289` (`main`, "Alert when an enabled account is not authorised on the exec sidecar (#660)")
**Mode:** AUDIT-FIRST · READ-ONLY RUNTIME · OFFLINE TESTING · EVIDENCE-PRESERVING
**Live actions taken:** none. No order placed, amended, cancelled or closed. `exec-parity.js --order` never invoked. No credential, account mode, risk limit or environment variable changed.

Full deliverable tree: `audit/algo-integrity-2026-08-06/`.

---

## 0. The honest headline

**This audit is PARTIAL, and the partition is not subtle.** Everything that can be
proved from source, tests and a frozen checkout was executed and is reported with
evidence. Everything that requires the production database or a broker session —
which is most of §9 through §15, the parts that would actually answer *"is there an
edge"* — is **BLOCKED**, because this environment has no agent DB and holds a
read-tier credential by design.

That distinction is the single most important thing in this document, because the
prompt's own §2 forbids inventing a result and its §21 forbids counting missing data
as a pass. So:

> **Direct answer to the prompt's closing question — "is the system trading a
> demonstrated edge or merely operating a complex set of rules?"**
> On the evidence available at this SHA: **it is operating a complex set of rules
> whose edge is UNPROVEN from this vantage point.** That is not a claim the edge is
> absent. It is a statement that the evidence needed to decide — out-of-sample trade
> sequences, realised cost drag, per-strategy expectancy with confidence intervals —
> was not reachable from here, and no number in this document should be read as
> standing in for it.

What *is* proved is narrower and still worth having: the pipeline is structurally
sound at HEAD, all twelve strategies are alive rather than silently dead, and there
is **one confirmed cross-account contamination defect on a money path** that is
reachable today.

---

## 1. Executive verdict

| Verdict axis | Classification | Basis |
|---|---|---|
| **Economic character** (§3.1) | `BOUNDED SPECULATION` for FX/indices/commodities/CFD; `UNCLASSIFIED — INSUFFICIENT EVIDENCE` for equity CFDs | No valuation or margin-of-safety pipeline exists anywhere in the repo. Graham test part 1 (thorough analysis) is met on *price* evidence only; part 3 (adequate return after costs) is unproven. Bounded, because per-trade risk, daily loss caps, equity stop and position caps all exist and are enforced in code. |
| **Defence posture** (§3.2) | `MIXED` | Entry-side defences are numerous, layered and — on the 7-day figures the owner surfaced on 04-08 — collectively near-prohibitive (1.7% approval). Execution-side authority is well arbitrated (`acting-layer.js` single-flight + dual ledger/broker gate). Cross-account scoping has one proven hole. |
| **Edge status** (§3.3) | `EDGE UNPROVEN` for all 12 strategies, portfolio included | Not `EDGE NEGATIVE` — that would also be a claim requiring the data. No out-of-sample trade sequence was reachable. |

**Defence posture is `MIXED`, not `OVER-DEFENDED`,** even though the approval rate is
1.7%. Calling it over-defended would require the counterfactual replay in §10.2 of
the prompt — replaying each vetoed opportunity's unchanged entry/stop/target — and
that is `BLOCKED`. The 1.7% figure is a strong *prior* for over-defence; it is not
the measurement.

---

## 2. Baseline — executed, with exit codes

All commands run in a clean `git worktree` at the frozen SHA, isolated from the
working tree. Full log: `audit/algo-integrity-2026-08-06/evidence/commands.log`.

| Command | Exit | Duration | Result |
|---|---|---|---|
| `npm test` | 0 | 9s | pass |
| `shopt -s globstar; node --test agent/**/*.test.js` | 0 | 37s | 2,815 tests pass |
| `npm run lint` | 0 | 35s | clean |
| `npm run build` | 0 | 1s | pass |
| `npm run check:no-green` | 0 | 1s | pass |
| `make -C cpp-exec clean` | 0 | 0s | pass |
| `make -C cpp-exec CXX=g++ test` | 0 | **306s** | pass |
| `make -C cpp-exec CXX=g++` | 0 | 20s | pass |
| `node agent/scripts/backtest-parity.mjs` | 0 | 1s | pass |
| `node agent/scripts/exec-parity.js` | **1** | 0s | **BLOCKED** — `cTrader creds not configured in the agent DB` |

`npm ci` was **not** re-run; `node_modules` was linked from the working tree after
confirming the lockfile is byte-identical at its head. Recorded as a deviation.

Environment: Node v22.22.2, npm 10.9.7, g++ present, 853 tracked files, 542 JS/MJS,
277 test files, 47 C++ sources, 150 service modules.

**The exec-parity failure is preserved, not repaired.** It is the boundary of this
audit: it is the one command that would have proved a real broker session, and it
could not run.

---

## 3. Confirmed findings

### F-RISK-01 — `sameSideAccountIds` selects the WRONG side on every call

**Classification:** defect · **Severity:** critical · **Confidence:** high
**Status:** **proved by execution**
**Scope:** `agent/services/acting-layer.js:167-177`, `agent/lib/ctrader-creds.js:23-61`, callers `agent/services/loss-cap.js:377`, `agent/services/profit-ratchet.js:157`
**Hypothesis:** H06 (cross-account contamination) — **CONFIRMED**

**Observation.** `getCtraderCreds()` computes `isLive` at `ctrader-creds.js:23-25`, uses
it at `:43` and `:53`, and then **does not return it**. The returned object has no
`isLive` key. `sameSideAccountIds(db, baseCreds)` reads `!!baseCreds?.isLive`
(`acting-layer.js:170`) and therefore evaluates `!!undefined === false` — **always**.

**Reachable trigger.** Executed against the real module with a fake registry of two
live and two demo rows, passing credentials in exactly the shape `getCtraderCreds`
returns for a LIVE account:

```
creds has own isLive field?  false
!!creds.isLive           =  false
sameSideAccountIds(LIVE creds) = [ '42993489', '43097342', '46130058' ]
EXPECTED for a live account   = [ 42993489, 99999999 ]
```

Two demo accounts are selected for a sweep carrying LIVE credentials, and a second
live account is silently dropped.

**Economic effect.** Two ways, and the second is worse than the first.
The demo accounts fail authorisation against a live token, so `loss-cap` and
`profit-ratchet` burn a broker round-trip and an error per account per pass — noise,
not loss. But the **dropped live account gets no loss cap and no profit ratchet
sweep at all**. A second live account would be unprotected by both layers and
nothing would say so. Today only one live account is enabled, which is the only
reason this has not already cost money.

**Counter-evidence.** This is precisely the cross-side mixing the comment at
`acting-layer.js:158-162` says the function exists to prevent — the function is
correct, its input is not. And `authorisedAccountId(baseCreds)` still puts the
primary first and always includes it (`:175-176`), so the *selected* account is
never lost. The blast radius is additional accounts on the same side.

**Minimum sufficient remedy.** Return the side from `getCtraderCreds`, derived from
`creds.host` rather than a field that can go missing again:
`isLive: host === 'live.ctraderapi.com'`. One line, no behavioural change for a
single-account registry.

**Policy boundary.** None — this is a correctness fix, not a risk-policy change.

**Regression proof.** A test that builds real creds via `getCtraderCreds` against a
two-sided fake registry and asserts `sameSideAccountIds` returns only same-side ids.
Fails at this SHA, passes after.

**Rollback.** Revert the one line; behaviour returns to always-demo selection.

---

### F-CONN-01 — enabled accounts cannot self-heal onto the sidecar's roster

**Classification:** defect · **Severity:** capital (opportunity) · **Confidence:** high
**Status:** proved (live measurement 05-08 12:26 UTC; mechanism confirmed in source at this SHA)
**Scope:** `cpp-exec/src/engine.cpp:106-115`, `cpp-exec/src/main.cpp:144`, `agent/services/heartbeat.js` `rosterDrift`, `agent/lib/ctrader-creds.js:42`, gate at `agent/loop.js:1173`
**Hypotheses:** H06, H18 — **CONFIRMED**

**Observation.** Four demo accounts (43097342, 46130058, 46979908, 47790949) are
`enabled = 1` and absent from the exec sidecar's authorised roster. Measured live:
`/state/account-phases` reported `connectivity: disconnected` for all four and
`active` only for 42993489. Consequence: 965 `account_probe` skips in 24h and **zero
trades opened in twelve hours**, against 87 the day before.

**Reachable trigger.** Three facts compose into a deadlock, each verified in source:

1. One `ExecEngine` holds one `host_` for its life; `main.cpp:144` creates exactly one
   engine, and `POST /connect` with a different host **tears the session down**
   rather than adding one (`engine.cpp:106-115`).
2. The self-heal that should notice — `rosterDrift` — compares the sidecar roster
   against `getCtraderCreds(db).accountIds`, which is filtered
   `WHERE enabled = 1 AND is_live = ?` off the single global `ctrader_is_live` flag
   (`ctrader-creds.js:42`). That flag says LIVE, so the comparison set is
   `{42993489}` — which matches. **Drift is structurally undetectable**: the demo
   accounts were never in the comparison.
3. The only other thing that would push demo credentials is an order attempt, and the
   connectivity gate (`loop.js:1173`) skips the account before one is built.

**Economic effect.** Total suppression of demo-side trading, which is the evidence
base for the 12 Aug go-live decision. Not a loss; an absence of the data the decision
needs.

**Failure-state classification (§17).** This was `silent unknown` until the owner
asked. It is now `blocked and visible` — PR #660 (merged) alerts after a 5-minute
dwell, and PR #661 (open) adds the routing seam that makes a fix expressible.

**Minimum sufficient remedy.** Not minimal — this needs the two-sidecar split
(one process per broker host). Phases 0 and 1 are done; 2 and 3 are not.

**Policy boundary.** Phase 3 deploys a second service and touches deployment
configuration. **OWNER POLICY DECISION — NOT A CORRECTNESS FIX.**

---

### F-OBS-01 — three load-bearing code citations pointed at unrelated lines

**Classification:** observability gap · **Severity:** low · **Confidence:** high · **Status:** proved, **fixed during this audit**

`heartbeat.js` cites `exec-engine.js` by line number four times, and those citations
are the *argument* for why `checkAccountAuthorization` reproduces the connectivity
gate's condition rather than the persisted `ok`. PR #661 moved `exec-engine.js` down
~51 lines and all four went stale. Re-stamped to 176 / 248 / 281-287 / 293.

Recorded because it is the mechanism by which a correct comment becomes a misleading
one with no code change and no test failure.

---

## 4. Top NON-findings — suspicions tested and rejected

These matter as much as the findings. Three of them are corrections to claims made
earlier in this session, and are recorded as corrections.

### N01 — H02 "silent strategy death": **DISPROVED at this SHA**

`strategies.js:21-27` loads 8 of its 12 computes through `loadCompute`, which returns
`() => null` on a missing or broken module. A dead strategy would then be
indistinguishable at runtime from one with no setup today — the process stays
healthy, the registry stays complete, the scan reports "no signal".

Tested directly (`agent/scripts/audit-strategy-invariants.mjs`, added by this audit,
read-only). Result: **0 of 12 are null placeholders.** Every entry resolves to a
named module function, and `compute.minBars` matches the registry for all twelve.

```
dead: []                       threwOnAnyCase: []
signalledOnFlatPrices: []      signalledOnZeroRange: []
signalledBelowMinBars: []      producedNonFiniteLevels: []
minBarsStampMissing: []
```

**The harness's own validity limit, stated plainly.** Its synthetic series produced a
positive control for only **2 of 12** strategies (`donchian_breakout`,
`rsi2_reversion`) — the other ten reject the generic series on their own quality
gates. Against those ten, "returned null on every degenerate input" is by itself
*vacuous*: a dead function would score identically. The result stands only because
two independent checks carry it:

- the null-placeholder **identity** check (source-text and function name), which does
  discriminate; and
- the repo's own suite, which contains a genuine non-null assertion for **all twelve**
  computes and passed green at this SHA.

Reported this way rather than as a clean pass because a harness that cannot fire is
not evidence that nothing fires.

### N02 — "/state/strategy-liveness ignores accountId": **FALSE at this SHA**

`state.js` passes `accountId: viewed.accountId` into `strategyLiveness(...)`. The
earlier claim in this session was wrong. Withdrawn.

### N03 — "/state/veto-breakdown ignores `days`": **FALSE at this SHA**

`state.js` forwards `days: req.query.days`, and `vetoBreakdown` clamps it to 1..90 and
builds `datetime('now', '-N days')` from it (`veto-breakdown.js:74-76`). The earlier
claim was wrong. Withdrawn.

### N04 — H01 "source-of-truth drift in the strategy list": **DISPROVED**

The registry at HEAD contains exactly the twelve strategies the prompt's reference
snapshot names, in the same order, with no additions or removals.

### N05 — position-writer authority is arbitrated, not assumed

`acting-layer.js` enforces two invariants with real mechanism, not convention: a
module-level single-flight map so a guardian tick joins the pass in flight rather
than starting a second one, and a dual gate (ledger stamp *plus* broker reconcile)
before any position is acted on. The file documents that both invariants were
previously false. This is the opposite of H08.

---

## 5. Hypothesis dispositions — all 18

| ID | Hypothesis | Disposition | Basis |
|---|---|---|---|
| H01 | Source-of-truth drift | **disproved** (strategy list) | registry vs prompt snapshot — exact match |
| H02 | Silent strategy death | **disproved** | invariant runner + repo positive controls |
| H03 | Live/backtest mismatch | **blocked** | needs bar-level fixtures from production data |
| H04 | Strategy starvation | **blocked** | needs `decision_log` |
| H05 | Wrong unit of analysis | **provisional** | `veto-breakdown.js` counts *skips*, not unique opportunities; prompt §10 requires opportunity identity. Not measurable here |
| H06 | Cross-account contamination | **CONFIRMED** | F-RISK-01 (proved by execution), F-CONN-01 |
| H07 | Diagnostic drift | **disproved** on the two claims tested | N02, N03 |
| H08 | Unenforced write authority | **disproved** | N05 — `acting-layer.js` arbitrates |
| H09 | Wrong trigger clock | **blocked** | needs runtime event timing |
| H10 | Detached stale work | **provisional** | `fast-monitor.js`'s `withBudget` abandons the WAIT not the WORK — documented in `acting-layer.js:15-22`. Single-flight now bounds the consequence |
| H11 | Node/C++ semantic drift | **partially disproved** | `backtest-parity.mjs` exit 0; `make test` exit 0. Trade-*sequence* parity not verified |
| H12 | P&L lineage defects | **blocked** | needs the trades/deals tables |
| H13 | Pending-order lifecycle gaps | **blocked** | needs runtime order rows |
| H14 | Defensive drift / winner truncation | **blocked** | needs MAE/MFE from closed trades |
| H15 | Awareness overreach | **not assessed** | out of reach without runtime |
| H16 | Capital fragility | **blocked** | needs balances and correlation matrix |
| H17 | Noise sensitivity | **partially executed** | 19 adversarial series × 12 strategies: no strategy signalled on flat, zero-range, sub-minimum or malformed input, and none threw |
| H18 | Failure-path dishonesty | **CONFIRMED then remediated** | F-CONN-01 was `silent unknown` for 12h; #660 makes it `blocked and visible` |

**7 blocked of 18.** Every blocked row names the missing evidence, per §21.

---

## 6. Strategy scorecard — all 12

Verdict column is edge status per §3.3. Every one is `EDGE UNPROVEN` because no
out-of-sample trade sequence was reachable; the difference between rows is what
*structural* evidence exists.

| # | Strategy | Default | minBars | Pending | Module live | Invariants | Positive control | Edge |
|---|---|---|---|---|---|---|---|---|
| 1 | `fib_618_fade` | **off** | 14 | yes | yes | 19/19 clean | repo (4 files) | UNPROVEN |
| 2 | `cup_handle` | on | 210 | no | yes | 19/19 clean | repo (2 files) | UNPROVEN |
| 3 | `inv_cup_handle` | on | 210 | no | yes | 19/19 clean | repo (2 files) | UNPROVEN |
| 4 | `ema_pullback` | on | 450 | no | yes | 19/19 clean | repo | UNPROVEN |
| 5 | `donchian_breakout` | on | 40 | no | yes | 19/19 clean | **harness + repo** | UNPROVEN |
| 6 | `rsi_meanrev` | on | 75 | no | yes | 19/19 clean | repo | UNPROVEN |
| 7 | `vwap_trend` | on | 30 | no | yes | 19/19 clean | repo | UNPROVEN |
| 8 | `vp_value` | on | 40 | no | yes | 19/19 clean | repo | UNPROVEN |
| 9 | `rsi2_reversion` | on | 104 | no | yes | 19/19 clean | **harness + repo** | UNPROVEN |
| 10 | `fib_confluence` | on | 40 | no | yes | 19/19 clean | repo (1 file, 1 assert) | UNPROVEN |
| 11 | `va_breakout` | on | 60 | no | yes | 19/19 clean | repo | UNPROVEN |
| 12 | `fvg_retrace` | **off** | 60 | no | yes | 19/19 clean | repo | UNPROVEN |

"19/19 clean" = returned `null` on all nineteen adversarial series (insufficient
history, exactly-minimum, flat, monotonic, zero-range, sawtooth, duplicated bars,
out-of-order timestamps, missing interval, NaN, null, Infinity, impossible OHLC, zero
volume, giant wick, price-scale change) and threw on none.

`fib_confluence` is the thinnest-covered armed strategy: one test file, one non-null
assertion. It is also the guard the owner measured at 1,039 vetoes. Worth noting
together.

---

## 7. What is BLOCKED, and the exact evidence needed

Per §5.190 and §18: each blocked item names its blocker and the read-only query that
would complete it. Executable SQL is in
`audit/algo-integrity-2026-08-06/evidence/data-queries.sql`.

| Prompt § | Deliverable | Blocker | Evidence needed |
|---|---|---|---|
| §9 | Backtest validity, walk-forward, bootstrap CIs, cost stress | no production bar data | bar snapshots per symbol/timeframe |
| §10 | Opportunity/veto funnel with unique opportunity identity | no `decision_log` | `decision_log`, `risk_events`, `opportunities` over ≥30d |
| §10.2 | Marginal veto counterfactual replay | as above + bars | vetoed rows *plus* the bars after each decision timestamp |
| §11 | Risk of ruin, correlated stress, drawdown distribution | no balances/positions | `accounts`, `trades`, `broker_snapshot_cache_json` |
| §12 | MAE/MFE, giveback, ratchet lag, exit counterfactuals | no `position_events` | `position_events`, `trades`, `trade_postmortems` |
| §13 | "Recent successful broker session, fresh tick, reconciled state" | read-tier credential; sidecar unreachable | one authenticated `GET /health` + `GET /positions` |
| §14 | Pending-order lifecycle branches | no `pending_orders` | `pending_orders` with provenance columns |
| §15 | Human awareness study (blinded chart review) | requires the human operator | owner time; charts rendered to decision timestamp only |

**None of these is marked passed.** Per §21, an unavailable test is `blocked`.

---

## 8. Investment / speculation classification (§16)

There is **no valuation pipeline** in this repository — no financial statements, no
normalised earnings, no balance-sheet strength, no margin-of-safety calculation. Every
strategy is price-and-volume only, on horizons from minutes to days.

Under Graham's test applied literally:

- **Thorough analysis** — partially met, on price evidence. Backtests exist and are run.
- **Safety of principal** — met in the bounded-survival sense, not the promise sense:
  per-trade risk %, daily loss cap, equity stop, position caps and broker-side
  brackets all exist and are enforced in code, and `validateOrderBracket` refuses a
  market order with no stop *or* no target in **both** engines.
- **Adequate return after costs** — **unproven.** This is the gap.

**Verdict: BOUNDED SPECULATION.** Per the prompt's §16, that is not a failure. It
would only be a failure if it were mislabelled as investment or if risk were
unbounded. Neither is the case: nothing in the codebase calls this investing, and the
risk is bounded by enforced caps.

The equity CFD positions (0066.HK, 0005.HK) are `UNCLASSIFIED — INSUFFICIENT
EVIDENCE`: they are equities, but held on price logic with no valuation input, which
under §3.1 makes them speculation unless a valuation model is present. None is.

---

## 9. Immediate actions

### P0 — make evidence trustworthy
1. **Nothing.** The evidence that exists is trustworthy; the problem is that most of
   it is unreachable. The P0 action is *access*, not repair — see P1.2.

### P1 — prevent unintended capital risk
1. **Fix F-RISK-01.** Return `isLive` from `getCtraderCreds`, derived from
   `creds.host`. One line + one regression test. Correctness fix, no policy content.
   This is the only confirmed money-path defect in this audit.
2. **Rotate `AGENT_SECRET` and `AGENT_SECRET_READ`** — both have appeared in a
   scratchpad file during this session's work. Owner action; no code change.

### P2 — restore correct signal and opportunity flow
3. **Finish the two-sidecar split** (F-CONN-01). Phases 0 and 1 shipped; Phase 2
   (side-aware roster, reconcile sweep, `rosterDrift`, `cpp_exec_demo` heartbeat) and
   Phase 3 (second service + C++ host pin) remain. Until then the demo accounts
   generate no evidence at all, and the 12 Aug decision has nothing to stand on.

### P3+ — deferred until measurable
4. Everything about veto calibration, winner truncation and management cost is
   deferred *because it is not yet measurable*, not because it is unimportant. The
   1.7% approval rate is the loudest signal in the system and this audit could not
   evaluate it.

---

## 10. Deferred OWNER POLICY DECISIONS — not correctness fixes

Each of these is labelled per §2. None was changed.

| # | Decision | Current state | Why it is policy |
|---|---|---|---|
| 1 | `dailyLossPct 0.03` → USD 16.16 cap on 43097342 | active | a risk limit |
| 2 | `risk_budget = $0.33` vs `usd_per_lot = $52.97` | blocks every entry on that account | min lot costs more than the whole budget: either raise risk or reduce lot |
| 3 | `fib_confluence` OFF (1,039 vetoes) | disabled | arming a strategy |
| 4 | `minRR 1.5` vs measured breakeven payoff (task #185) | active | a threshold |
| 5 | Two-sidecar Phase 3 deployment | not deployed | new service + env vars |
| 6 | Nine 0066.HK + six 0005.HK duplicate positions (#179/#184) | open | needs a full-tier credential to close |
| 7 | Re-authorise the four demo accounts | disconnected | account authorisation |

---

## 11. Files created and commands run

**Created (all read-only, all deterministic, none can place an order):**

- `agent/scripts/audit-strategy-invariants.mjs` — strategy invariant + H02 runner
- `audit/algo-integrity-2026-08-06/` — 16 reports, `evidence/`, `machine/`
- `instr/Result_Bot-Trade_Algorithmic_Decision_Integrity_Audit_2026-08-06.md` — this file

**Commands:** the ten in §2, plus the invariant runner and two ad-hoc reachability
probes. Full log with exit codes and durations in `evidence/commands.log`.

**Branch / PR status.** Per the prompt's §2 ("merge to `main`" is forbidden) and the
repository's standing branch instruction, this is committed to
`claude/handover-outstanding-file-1ktjs7` and delivered as a **draft PR**. It is not
merged. The audit branch name the prompt suggests (`audit/algo-integrity-YYYYMMDD`)
was **not** used, because the repository instruction pins the working branch; recorded
here as a deliberate deviation.

---

## 12. Red-team review of this audit (§22)

Performed as an explicit adversarial pass over this document's own claims.

| Reviewer question | Answer |
|---|---|
| Did it trust a comment instead of a call path? | For F-RISK-01, no — executed. For F-CONN-01's C++ half, **partly**: `engine.cpp:106-115` was read, not run. Recorded as a limit. |
| Did it mix SHAs? | The static evidence is all `0e64651`. The F-CONN-01 *live measurement* is from 05-08 12:26 UTC against deployed code, which is a different vantage point from a frozen checkout. Flagged in the finding. |
| Did it confuse signal / evaluation / opportunity / order / fill / trade? | It avoided the question by not computing any conversion rate. `veto-breakdown` counts skips, which is why H05 is `provisional` rather than disproved. |
| Did it treat unknown as zero? | No. 7 of 18 hypotheses are `blocked`, and the strategy scorecard says `EDGE UNPROVEN` rather than reporting an absent number as a pass. |
| Did it use future bars? | The invariance check only asserts determinism on identical input; it does **not** prove absence of look-ahead. Overstating it would have been the easy error. |
| Did it overlook a strategy that loaded as a null compute? | This was the primary hypothesis and it was tested by identity, not inference. |
| Did it hide starvation behind "no setup"? | It could not test starvation at all (H04 blocked) and says so. |
| Did it infer broker success from local intent? | No — and the one command that would have proved a broker session failed, which is reported as the audit's boundary rather than worked around. |
| **Did it overstate confidence from a small sample?** | **The near-miss.** The first version of the invariant runner reported a clean sweep across 12 strategies × 19 cases while every single call returned `null` — a dead strategy would have scored identically. Caught by asking what a positive control would look like; the finding is now reported with its own validity limit attached. |
| Did it recommend a policy change as a bug fix? | No — §10 separates them explicitly, and only F-RISK-01 is called a correctness fix. |
| Did it report a healthy system without proving useful work? | It reports gates green and edge unproven, which is the honest pairing. |

**Unresolved reviewer objection:** the C++ side of F-CONN-01 rests on reading
`engine.cpp`, not on running it. A test that stands up two engines and asserts that
`/connect` with a second host tears the first session down would close it. Not
written — that is Phase 3 work.

---

## 13. Direct answers to the prompt's closing questions

1. **Demonstrated edge, or a complex set of rules?** A complex set of rules whose edge
   is unproven *from this vantage point*. The measurement was not reachable.
2. **Which strategies are alive, reachable and sufficiently tested?** All 12 are alive
   and reachable. None is *sufficiently* tested in the edge sense. `fib_confluence` is
   the thinnest-covered armed strategy.
3. **Where does noise enter?** Not measurable without production data. What *is*
   shown: no strategy signals on flat, zero-range, sub-minimum or malformed input, so
   the obvious degenerate-data channel is closed at the strategy boundary.
4. **Where are valid opportunities lost?** One place is proved: the connectivity gate
   (`loop.js:1173`) skipped every demo-account dispatch for twelve hours — 965
   `account_probe` skips, 0 trades. The rest of the funnel is blocked.
5. **Where are bad trades correctly prevented?** `validateOrderBracket` refuses a
   market order with no stop or no target in **both** engines; `validateExecGuard`
   enforces halt and volume cap in both; `withAccount` refuses an order whose payload
   and credentials name different accounts. All three verified in source and covered
   by passing tests.
6. **Where are winners truncated?** Not measurable — needs MAE/MFE.
7. **Can Node and C++ act inconsistently on the same position?** Node-vs-Node is
   arbitrated by `acting-layer.js`. Node-vs-C++ **is not arbitrated by a shared lock**
   — the C++ TrailEngine ratchets on ticks while Node's profit keeper ratchets on its
   own clock. Both only ever tighten, which bounds the damage, but "both only tighten"
   is a property of the current code, not an enforced invariant. **Provisional.**
8. **Is principal protected against realistic correlated and gap risk?** Caps exist and
   are enforced. Whether they are *sufficient* is `BLOCKED` — that is the risk-of-ruin
   simulation, and it needs balances and a correlation matrix.
9. **Which operations are investments?** None. All are speculation; the bounded kind.
10. **Smallest evidence-backed sequence that improves expectancy without enlarging
    blast radius?** (a) fix F-RISK-01 — one line, removes a proven cross-side defect;
    (b) finish the two-sidecar split so the demo accounts produce evidence again;
    (c) *then* run the funnel and counterfactual analyses that this audit could not,
    and let those decide the veto calibration. Doing (c) before (b) would tune against
    a sample of zero.

---

*No live trading action was taken at any point in this audit. `exec-parity.js --order`
was never invoked. No credential, account mode, risk limit, strategy threshold or
environment variable was changed.*
