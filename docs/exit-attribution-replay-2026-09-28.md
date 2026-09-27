# Exit attribution, costed replay and V3 release evidence

Implementation record, 28 September 2026. This records the authorised continuation; it does not amend the approved V3 policy or mark its acceptance groups complete. Main was `cf121d4`; draft PR #1170 was `aa59db0` when read. The changes below are local until an approved push and subsequent release.

## Six-stage reassessment

- **Intent:** correct false exit causes, then assess candidate exits using explicit costs, original entry risk and original size. Completion requires broker-linked attribution, reproducible offline results and an honest V3 gate report.
- **Interpretation:** the owner ordered continuation of the current build. This authorises local corrections and analysis. The separate explicit approval requirement for a push, deployment, production migration, account/profile mutation or trading activation remains in force. No production action occurred in this continuation.
- **Assumptions:** account-owned opening/closing orders and complete position-deal histories were read for all 23 statement closes. Rejected, unfilled deals are excluded. Native SL/TP legs are inferred from the actual closing order's bracket and fill; the API's combined SL/TP order type is not a separate trigger-reason field. A market order does not establish its initiating person or rule. Historical ATR/rank state, complete historical fee/rollover schedules and executable tick paths are unavailable for full V3 replay.
- **Invariants:** no change to entries, original stops, volume, caps, sizing, money records, broker protection, policy thresholds or scanner order authority. Wrong-account, unfilled, mismatched and late receipts cannot verify a close. Ambiguous or unfinished counterfactual trades cannot become fabricated wins or zero returns.
- **Execution:** the former assumption, "an open momentum book row proves a 3xATR stop fill," was false. The old test explicitly encoded it; that expectation was corrected to unknown. Price proximity alone no longer upgrades newly detected broker closes. Existing explicit closer/owner notes are preserved, and the broker evidence is retained separately. Legacy price-only machine labels can be superseded by verified order evidence.
- **Evidence:** focused regressions, real recovery-path integration, the full local gate and the frozen-cohort replay are recorded below. There is no `/flow-check` executable in the available repository; this is an explicit stage review, not a claim that an unavailable command ran.

## File changes

| File | Change and resulting behaviour |
|---|---|
| `agent/db.js` | Additive account/deal-keyed attribution queue and provenance table; no rewrite of monetary or risk columns. |
| `agent/services/broker-exit-attribution.js` | Validates account, order, position, symbol, side, filled volume, entry, exit and time against the same closing receipt. Distinguishes market, inferred TP, inferred SL and unproved cause. One paced order read per eligible account pass. |
| `agent/services/reconciler.js` | Removes book-ownership stop inference; scopes journal lookup; preserves legacy unscoped journals without borrowing a known different account. Replaces the exact false book stamp with an honest pending reason, then upgrades replaceable machine reasons using linked evidence. |
| `agent/services/cross-side-pnl.js` | Queues close receipts from existing window and position-history reads, including the lifecycle sweep for already-priced trades. The order read shares the existing deadline and unresolved-transport lock, after money/lifecycle work. |
| `agent/services/broker-history-import.js` | Queues complete closing receipts from an already-requested history import; adds no order call to the import. |
| `agent/services/broker-exit-attribution.test.js`, `agent/services/cross-side-pnl.test.js`, `agent/services/reconciler.test.js` | Regression and integration checks for ownership, account collisions, old rows, late replies, pacing, proof, idempotency and money/risk preservation. |
| `agent/lib/costed-exit-replay.js`, its test, `scripts/replay-exit-evidence.mjs` | Offline explicit-cost scenarios. Preserve original risk/size, refuse missing inputs, retain intrabar ambiguity, handle gaps adversely, charge partial-exit minima and leave open residuals censored. No production caller or execution authority. |

## Frozen evidence and results

The private source is 23 closes from five uploaded account statements, joined to account-scoped broker orders/deals and H1 bars. Price cutoff is **27 September 2026, 22:44:35 SGT**. Broker-history SHA-256: `ff6a5f6348c9215d009a009ac935b7256acefb3a9426d797b7b732925bef92ac`. Source data and account identifiers stay outside this repository.

The classifier returns **10 inferred SL, 10 inferred TP, 3 market**. Nine automated momentum TP fills were falsely recorded as book trailing stops. Market initiator is not established by this classifier. There are mirrored positions across accounts, so 23 account fills are not 23 independent setups.

| Frozen scenario, each run with two explicit cost assumptions | Trades | Closed at stop | Target hit | Still open at cutoff |
|---|---:|---:|---:|---:|
| Momentum: fixed 3R plus observed-cost reserve; original stop | 15 | 4 | 0 | 11 |
| COIN: end-of-H1 1R trail armed after 1R; original target | 3 | 0 | 0 | 3 |

The other five trades retain their factual baseline; no new exit rule was invented for them. The scenarios include manually exited positions where their strategy label selects the scenario, and the private report retains that channel distinction. They are not a clean automated-strategy qualification set.

Costs use each trade's observed round-trip commission split equally across entry and exit, its observed swap prorated over calendar holding time, and its actual-close conversion rate. Additional execution surcharges are zero and 0.02 original R per exit. These are retrospective sensitivity assumptions, not entry-time forecasts, historical rollover schedules or measured future fills. The long-only replayed cohorts use bid H1 prices at exit; gaps in data and intrabar chronology cannot establish tick execution.

Three-R geometry alone is **not** the full V3 partial/runner/ATR/rank policy. All open residuals have null final net, and no closed-only PF is reported. These results do not demonstrate higher profit, attainment of PF 1.71 or a qualified win rate. More bars alone would not fix the original attribution, size dispersion or missing management-state evidence.

## Scanner proposal prepared, not applied

Read-only health at **28 September 05:06:39 SGT** showed both gateways connected, three live and four demo accounts, 53 tick symbols on each, bracket/target guards enabled, recording/shadow true and tick placement false. Current feeds use accounts ending **3489** and **9908**; current profiles use **9009** and **0058**. Selected account remains 9908; the 690 timeframe profiles belong to 0058.

An exact private proposal preserves all 796 profiles and adds 53 tick profiles for each current feed account, resolved through that destination account's own symbol map: **902 profiles, 330,150 bytes**, within the existing 1,024-profile / 512-KiB bounds. The real registry validator accepted it in an isolated in-memory database, restored the exact old revision from its rollback, refused a running bridge and refused a stale revision. The initial evidence extract omitted some timeframe map entries and was refused; the complete extract was then used. The validator and bounds were unchanged.

- Previous revision: `d1de0d9879cb83f66c321b1a8fbb7c5ea3ff08291495335c5a5e4afb812d1fe5`.
- Proposed revision: `c3da37c4ff2c59864761e684d8b90a000b9bc4ca925491c6f1f9c7bbf63825e1`.
- Compact proposal SHA-256: `9fab5f37e3409f3fec6388717c95124fd6aed3273ba51e56887fcb6489df5e95`.

Application needs a fresh feed/map/revision check, an approved bridge-off/profile-register/bridge-on operation and actual comparison readback. This proposal covers the current feed anchors; a future gateway feed-account change still needs reconciliation. Selecting 0058 is a separate previously chosen operation and does not move a retained tick feed. Nothing in the proposal enables tick trading.

## V3 acceptance still open

- The collector/T4/readiness branch is undeployed. New attribution is also undeployed; the production database has not been corrected by these local changes.
- The final partial-fill then cancel/expiry case still retains its conservative reservation. Safe resolution needs terminal order evidence, a subsequent fresh absence-of-remainder snapshot, counted filled exposure and a valid partial-volume plan. A native bracket alone does not prove TP1 enrollment. No reserve was cleared to bypass this.
- Full production desktop/phone DevTools trace and natural fill/partial-close acceptance remain unverified. Earlier warm-page observations are not that trace.
- The dated performance window, later broker/session/calendar readbacks and outcome/holdout evidence in the approved V3 plan cannot be replaced by local tests. PF 1.71 is not established. Open owner decisions remain recorded in the current handover; this report does not silently answer them.

The 05:00 SGT readiness target was missed. Local source/replay completion and full V3 production acceptance are separate facts.

## Verification record

Final source gate, **28 September 05:24 SGT**: 30 isolated latency checks, six hygiene checks and 7,140 remaining tests passed, three skipped, zero failed; private TMPDIR empty. Total backend: **7,176 passed / 3 skipped**. Frontend: **1,311 passed across 136 files**. Full ESLint and final changed-source ESLint, build, colour check and whitespace check passed. Build retains its large-chunk advisory; this is not a browser performance result. Source SHA-256 over 1,020 JavaScript/MJS files was identical before and after the final run: `f6fb6f7ed74440a9edee581e7d818c4b120d0b53407e29ecddb518ea3ffe649e`.

The first complete backend run passed 30 isolated latency checks, 6 hygiene checks and 7,137 remaining tests with 3 skips. A later full rerun was interrupted without a verdict and is not counted as a pass. The focused account-isolation follow-up initially exposed two legacy unscoped-journal regressions; the implementation was corrected, preserving those assertions, and the 103 focused checks then passed. The final frozen run above supersedes intermediate runs for release evidence. No new independent checker or remote final-head CI result is claimed.

Commands: `node scripts/run-agent-tests.mjs`; `npx eslint . --max-warnings 0`; `npx vitest run`; `npm run build`; `npm run check:no-green`; `node scripts/replay-exit-evidence.mjs <private-evidence-directory> <private-output.json>`.

## Invariants report

| Invariant | Verdict | Evidence / limit |
|---|---|---|
| Exact account-owned filled receipt before broker cause is verified | Passed in tested source | Mismatch/rejected-deal regressions and real account backfill integration. |
| No attribution from book ownership or price proximity for a new close | Passed in tested source | Reproduced false-book regression; new-close-near-TP regression. |
| Late replies do not verify or overlap; retry paced | Passed in tested source | Real reader timeout test, durable pending queue and unit deadline test. |
| Money, original risk, size and explicit owner notes preserved | Passed in tested source | SQLite before/after equality; replay original-risk/volume checks; no broker write path. |
| Costs explicit; gaps/ambiguity/open residuals not fabricated | Passed for the stated offline scenarios | Seven replay tests and 36 scenario records. Assumed costs are not certified historical execution. |
| Scanner draft uses destination-account identities and preserves authority | Passed locally | Real registry apply/rollback/CAS/bridge checks; production proposal unapplied. |
| Actual feed/profile alignment | Failed in recorded production state | Health and registry reads above still disagree. |
| Full V3 partial-fill lifecycle, live performance and empirical target | Not Verifiable | Undeployed source, remaining lifecycle case and missing/calendar-dependent evidence. |

Release reversibility: local commits can be reverted; the additive attribution table can be left unused by a code rollback. A production correction would change machine-generated reason text while retaining supporting receipts. Scanner rollback is a whole-set CAS payload and requires the same bridge discipline. A rollback is a separate production action, never an implicit bypass of approval.
