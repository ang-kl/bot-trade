# Performance, protection and scanner plan — revision 2

22 September 2026 · Review and proposed priorities · Documentation only

## 1. Scope and authority

This is a separate second revision of the performance-card reassessment. It preserves the original document and reconciles its proposals with the existing P0–P8 trading coverage backlog. It is a plan for review, not an instruction to execute changes now.

**Current user direction: do not build yet.** No application changes, builds, tests, merges, deployments, broker amendments, configuration changes or trading activation are authorised by this document. Earlier implementation instructions do not override this hold.

Sources:

- [Original reassessment at its reviewed commit](https://github.com/ang-kl/bot-trade/blob/1ff654f54d2635dcb87ea86e5fee5098e63d10f0/docs/performance-cards-reassessment-2026-09-22.md), from draft PR #1002.
- [Existing coverage priorities](tick-momentum/coverage-followup-2026-09-21.md), including the dated independent protection audit.
- Source review of the performance page, account-risk consumers, scan loop, bar cache, tick workers and recorder.

The original reassessment is not in this local branch. Its PR version was read directly; this revision does not imply that #1002 has merged. PR #1002 was draft/open and #1003 open/unmerged at the 09:07 SGT status check. Live observations below have their own timestamps and must not be treated as current merely because this document is newer.

## 2. Main decisions proposed

1. Protect existing positions and correct account identity before increasing trading or scan capacity.
2. Keep the mandatory TP1 requirement. Resolve the momentum strategy's null-target proposal explicitly; do not bypass the entry guard or automatically remove existing targets.
3. Separate heavy scanning from protection when measurements justify it. Start with a timeframe worker using existing logic; do not commit to two additional C++ services yet.
4. Correct reporting and accounting independently of strategy promotion. Sparse valid data, missing data and stopped trading are different states.
5. Validate already-implemented research corrections against real inputs. Do not repeat #985 or treat empty replay trials as evidence of losses.
6. Preserve existing priority identifiers. Use dependencies and smaller work packages instead of renumbering the backlog or combining unrelated changes in one large PR.

## 3. Corrections to the original reassessment

| Original premise or proposal | Revision after review | Why it matters |
|---|---|---|
| The proposed work is all observability-only. | Account-scoping changes in risk and permit decisions can change which entries pass. Separate them from display changes and preserve thresholds. | A reporting label must not conceal a trading-behaviour change. |
| Sparse cards mean the cards work correctly. | Low close counts explain some empty cells, but do not establish accounting correctness. The hourly opening calculation uses closed trades and can omit still-open trades. | Fix the population and labels, not just the presentation. |
| Historical balances can be inferred from current balance and closed P&L. | Label such values as reconstructed unless reconciled with historical snapshots, cashflows, adjustments and currency. | Deposits and withdrawals are not trading returns. |
| Replace low-sample grids with insufficient evidence. | Retain factual counts and P&L; mark statistical conclusions as insufficient. Distinguish valid zero, small sample and unavailable/stale data. | Low sample size does not make observed activity disappear. |
| Change to 7/30 days because 24 hours is sparse. | Offer longer comparison windows without silently redefining “today” or changing defaults merely to fill the display. | The operator must know exactly what period is shown. |
| Two closes imply 22 empty hourly buckets. | They imply at least 22; both closes could occupy one bucket. | Avoid false precision. |
| Filesystem free space proves no volume is needed. | Verify mount, actual service quota, persistence and retention requirements first. | Host filesystem counters do not establish usable durable allocation. |
| A 2 GiB recorder setting caps total disk usage. | Retention removes eligible sealed segments; active segments, torn files and other files are outside that simple bound. | Total disk protection needs separate evidence. |
| Two recording samples bound future daily volume and retention. | Treat them as dated observations and planning scenarios, not bounds or a 500-symbol benchmark. | Market activity, symbol coverage and overhead vary. |
| RECORDING proves collection is healthy. | Report subscriptions, event progress, source timestamps, gaps, market session and probe errors. A failed disk probe is unknown. | Enabled configuration is not proof of flowing data. |
| More C++ scanners will solve the delays. | Attribute CPU, broker waits, queues and database latency before choosing process count or language. | Process multiplication can duplicate work and worsen shared limits. |

The original forecast of tomorrow's close count is removed. No activity target should encourage trading to populate a dashboard.

## 4. Dated baseline and remaining uncertainty

The independent audit at **08:47 SGT**, on production `a82740d` (#1001), reported 39 positions across seven accounts, zero missing SL and two missing TP1: one on account suffix 9908 and one on 0949. This is a historical audit, not confirmation that those same positions remain open now. Refresh the detailed broker audit before proposing any amendment. Recorded targets behind the market must not be replaced with arbitrary prices to make coverage green.

Recording and shadow observation were previously verified on both services. The last verified entry mode was TIME_BASED, tick entry readiness was zero, and tick trailing remained disabled. A merged protection patch does not prove tick management is active.

Disconnected Controllers views were verified to show UNVERIFIED. Authenticated account switching and management views remain unverified after the browser session was lost. Deployment success does not close this acceptance gap.

Two sampled scan profiles around 08:59–09:00 SGT took approximately 11.2 and 14.6 seconds, with 63–67% classified idle. Sampled monitor profiles took about 12.1 seconds with 69–83% idle. These observations justify investigating waits and scheduling; they neither locate every bottleneck nor establish percentile latency or a one-second monitoring guarantee.

## 5. Priority order and dependencies

P0–P8 retain their meanings from the existing coverage plan. Substeps organise work without creating a second numbering system. The table is an impact order, not a requirement to block all read-only diagnosis behind one unresolved policy decision.

| Priority | Proposed work and impact | Dependency / completion evidence |
|---|---|---|
| **P0 — Existing protection** | Refresh all-account broker coverage; identify each missing/invalid SL or TP1 and its owner. Resolve exceptions through the approved target policy. Direct effect on open-position protection. | Fresh position-level evidence; broker-confirmed amendments where authorised; explicit unresolved exceptions. Preserve valid stops and human ownership. |
| **P1 — Protection transaction capacity** | Finish the existing #1003 review and acceptance; do not create a duplicate fix. This reserves capacity for prerequisite and confirmation reads in stop amendments. | After the build hold is lifted: required gates and evidence that protection transactions succeed while ordinary reads are throttled. Merge/deploy remains on hold now. |
| **P2 — Account identity** | Define one account-specific snapshot contract, then fix risk/permit consumers and their reporting consumers in separate reviewable changes. Can change entry eligibility. | Correct account/feed identity, currency and freshness; cross-account contamination checks; explicit missing/stale-data policy. No fallback to another account or silent risk-limit change. |
| **P3 — TP1 policy and entry blockers** | Resolve momentum proposals with null TP1 against the mandatory-target rule. Show ordered blockers for each account, including upstream caps that mask later failures. Changes strategy/entry behaviour. | Agreed TP1 semantics, preserving SL and optional TP2 policy; valid proposals pass existing guards and invalid ones remain blocked. No automatic removal of existing caps. |
| **P4 — Tick protection readiness** | Verify account-scoped configuration, feed identity, quote/configuration age, writer ownership and read-back. Assess recorder/storage truth separately from activation. | P1 and applicable P2 contracts; bounded protection latency and failure behaviour; scoped readiness evidence for each service/account. Tick-entry activation has a separate research gate. |
| **P5 — Verification, reporting and runtime** | P5a: authenticated Controllers and independent checks. P5b: correct performance populations/accounting and blocker explanations. P5c: profile load, then consider scanner extraction. P5d: define useful account equity/protection history. | Account-specific displays use P2 contract. Profiling/read-only UI diagnosis can start independently once authorised; extraction needs measured contention and a data contract. Each substep gets separate acceptance. |
| **P6 — Research evidence** | Validate merged simulation/statistics/empty-replay corrections on current datasets; compare identical profile hashes and attributable inputs. No strategy change. | Explain warm-up, purge capacity, rejected events and actual decision opportunities. Report empty/insufficient separately from losing. Preserve validation thresholds and label candidate statistics. |
| **P7 — Strategy/configuration decisions** | Publish effective configuration and strategy/blocker matrix; propose sunset or promotion from valid evidence. Changes require their own review. | P3 policy clarity and P6 evidence. Distinguish deliberate retirement, invalid configuration, unavailable data and statistical rejection. |
| **P8 — Symbol capacity** | Stage expansion toward an eligible account universe; 500 symbols is a capacity goal to test, not an unconditional account setting. | P0–P5 applicable safety/identity gates, scanner load evidence, broker budgets and per-account tradability. Halt expansion if protection freshness degrades. |
| **Maintenance — Storage verification** | Verify production disk trend, mount/quota/persistence and recorder retention behaviour. Reuse merged fixture cleanup. | Evidence covers active/sealed/torn segments, logs, database/WAL and temporary files. If actual disk pressure threatens protection, elevate the incident to P0. |

### Execution sequence after a separate instruction to build

1. Refresh protection evidence and finish the existing protection correction; establish the account identity contract. Read-only profiling and blocker discovery may proceed alongside these tasks.
2. Resolve account-risk consumers and TP policy. Correct reporting with the same contract, without bundling UI work into consequential risk changes.
3. Demonstrate tick-protection prerequisites and authenticated UI truth. Validate existing research outputs in parallel; tick SL management does not require proof of profitable tick entries.
4. Decide scanner extraction from measurements, then run a shadow-only parity and load evaluation. Expand symbols only after acceptable protection behaviour under load.
5. Consider strategy promotion and tick entries through their own evidence gates. Neither scanner deployment nor a green dashboard constitutes that evidence.

An exception on one account must remain visible and receive appropriate handling. It must not automatically disable valid existing protection elsewhere. Define activation scope and failure handling explicitly rather than introducing a blanket account lockout in a reporting change.

## 6. Work inventory: reuse, do not rebuild

| Work | Review baseline | Next action proposed |
|---|---|---|
| #985 and research follow-ups | Simulation, MTM, candidate block bootstrap, profile attribution and empty-replay diagnostics merged. | Validate datasets/results under P6; do not implement the same machinery again. |
| #992 / #993 | Target-refusal visibility and account-scoped broker positions/history/cache merged. | Reuse these; #993 does not close remaining global risk-snapshot reads. |
| #994–#1001 | Independent protection reads, broker-target preservation, bounded book reads, honest unknown states, verifier/calendar fixes and tick amendment read-back landed. | Verify runtime acceptance and remaining edge cases; avoid repeating completed fixes. |
| #1003 | Protection-budget follow-up exists and is unmerged. | Finish that change later; do not replace it with a parallel implementation. |
| #1002 | Original reassessment is a draft document. | Use this revision for plan review; do not treat its recommendations as shipped behaviour. |
| Temporary fixture cleanup | Cleanup for the two large fixture producers already merged. | Verify production disk behaviour; broader deletion is not part of this plan. |
| Existing bar cache and tick workers | Shared bar fetching/cache and C++ symbol-sharded workers already exist. | Extend or isolate existing mechanisms only where measured need warrants. |

## 7. Scanner architecture decision

**Recommendation: separate responsibilities first; defer the decision to provision two additional C++ services.** Timeframe analysis and tick analysis have different scheduling needs, but two logical roles do not automatically require two new deployments.

| Responsibility | Proposed boundary | Authority |
|---|---|---|
| Timeframe scanning | Candidate worker triggered by relevant bar boundaries/incremental updates; begin with existing JavaScript strategy logic to limit parity risk. | Emits timestamped, versioned candidates; cannot place orders. |
| Tick scanning | Reuse incremental C++ symbol workers, preserving per-symbol ordering, bounded queues and gap recovery. Isolate into another process only if contention warrants it. | Emits candidates and health evidence; cannot bypass account risk. |
| Account coordination | Apply account eligibility, effective strategy configuration, risk, sizing and entry permission to candidates. | Owns admission and duplicate-intent prevention. |
| Execution and protection | Maintain independent priority for fills, reconciliation and SL/TP transactions. | Retains explicit per-position management ownership. |
| Independent verification | Continue cpp-verify broker checks and visible stale/error states. | Reports broker truth without relying solely on the writer's success message. |

Before extraction, measure p95/p99 protection latency, scan coverage/age, queue age, drops, data gaps, broker/auth wait, database time, event-loop delay, CPU and memory. Agree latency/freshness limits from the actual protection requirement; the sampled durations above are not acceptance thresholds.

Reuse shared market data only when broker, environment/feed, instrument identity, timeframe and relevant configuration match. The existing bar cache uses symbol ID and period; a shared worker needs a stronger identity contract. Do not assume matching ticker names across accounts imply identical instruments or feeds. Keep account-specific eligibility and risk downstream.

Avoid duplicate scanning per account when inputs genuinely match. Preserve session calendars, warm-up and explicit partial-bar semantics. Use actual pooled-connection configuration and measured broker limits; do not infer connection behaviour from an old source comment or create unrestricted scanner sessions.

Candidates require source time, expiry, configuration/strategy version and stable identity. Retries must not duplicate orders. Scanner failure, queue saturation or a stalled synchronous database must not block protection. Recovering from a data gap requires the appropriate re-warm before declaring a signal valid.

A future extraction must demonstrate candidate parity on frozen inputs, bounded resources and protection latency under peak load, plus safe shutdown/restart and rollback. These are future acceptance checks, not tests run for this revision. Rewrite only measured compute bottlenecks in C++ after parity is established.

## 8. Performance and operational reporting

Use three distinct states: **verified zero activity**, **valid but statistically small sample**, and **unavailable/stale/unverified**. Keep observed counts and P&L visible in the first two. Do not report unavailable values as zero.

Correct hourly opening counts to include the intended population, including still-open trades where the label means all openings. Specify time zone, session boundaries and date window consistently. Explain realised P&L separately from floating P&L, and balance separately from equity.

If minute history is needed, first inventory existing snapshots/events. A proposed account series should retain account/feed identity, broker/source timestamps, balance, equity, floating P&L, exposure, currency, cashflows, protection coverage and freshness. It is not a substitute for closed-trade outcomes or independent additional research observations. One-minute sampled drawdown is not the exact intra-minute maximum.

Keep fills and SL/TP amendment events separate from periodic snapshots. Historical returns need cashflow-aware accounting; reconstructed balances must be labelled until reconciled.

Controllers should show recording, shadow evaluation, tick protection and tick entries as four separate statuses per applicable service/account. Show last successful observation and failure reason. “Enabled”, “ready” and “observed active” must not be interchangeable.

The blocker view should reuse existing refusal/health evidence. Report the observed first blocker and label deeper diagnostics as evaluated or not evaluated. Do not claim a downstream gate passed just because an upstream gate stopped the request.

## 9. Recorder and storage acceptance

Verify actual service storage allocation and persistence before concluding that a volume is required or unnecessary. Include retention requirements and restart recovery. Account for all relevant disk users, not only recorded payload bytes.

Report configured state, subscribed symbols, event progress/age, segment generation, gaps and disk-probe validity separately. Zero events during a closed market differs from zero subscriptions during an expected active session. Failed probes remain unknown; stale observations retain their timestamps.

Use dated recording samples for explicit scenarios with stated assumptions. Do not extrapolate 53-symbol observations into a guaranteed 500-symbol rate or promise retention days without measuring eligible traffic and overhead.

## 10. Original proposal crosswalk and change boundaries

| Original #1002 priority | Revised destination | Boundary preventing duplication or confusion |
|---|---|---|
| P1 — performance cards | P5b | Correct populations/accounting and preserve valid sparse information before cosmetic simplification. |
| P2 — account scope | P2, consumed by P5 | One shared identity contract; separate risk integration from UI integration. |
| P3 — why nothing traded | P3 and P5b | Diagnose ordered blockers without relaxing guards or conflating blocked with unprofitable. |
| P4 — recorder truth | P4 diagnostics and Maintenance | Reporting truth is separate from activating tick protection or entries. |
| P5 — runbook | Maintenance and each relevant work package | Update operational instructions with verified behaviour; remove unsupported storage and activity claims. |

Do not combine account-risk changes, TP policy, dashboard accounting, scanner extraction and storage migration into one implementation PR. They have different trading consequences and rollback needs. Share contracts and evidence instead of duplicating code across separate changes.

## 11. Decisions to settle before consequential implementation

- **TP1 meaning:** distinguish a broker target that closes the remaining position from an application-managed partial TP1 and optional TP2. Define the momentum policy consistent with mandatory TP1 and existing position ownership; do not invent target prices in a repair.
- **Missing account evidence:** document intended stale/missing-snapshot behaviour in risk consumers before replacing global reads. Preserve thresholds and explicitly review any fail-open/fail-closed change.
- **Freshness and load:** agree protection latency, candidate expiry and quote/configuration age limits, then benchmark the proposed scanner boundary against them.
- **Volume confirmation:** if used, identify whether the feed provides traded volume or tick activity. They are not interchangeable. Validate any new entry filter separately; do not introduce it through a scanner refactor.
- **Storage:** decide required retention and restart durability from measured allocation and traffic, not host free-space alone.
- **Research:** retain current acceptance thresholds. Adopting a new statistical validation method or promoting a strategy is a separate decision from exposing candidate statistics.

**Review outcome:** protection first, account correctness next, explicit TP policy before expanded entries, honest reporting and measured isolation before capacity growth. This revision adds no runtime behaviour and schedules no execution.
