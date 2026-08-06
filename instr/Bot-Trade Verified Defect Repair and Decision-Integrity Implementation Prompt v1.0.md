# Bot-Trade Verified Defect Repair and Decision-Integrity Implementation Prompt v1.0

## Mission

Act as a senior trading-systems engineer, quantitative risk-controls reviewer, reliability engineer and adversarial verifier.

Repository:

`https://github.com/ang-kl/bot-trade`

Required source documents:

- `instr/Bot-Trade_Algorithmic_Decision_Integrity_Audit_Prompt_v1.0.md`
- `instr/Result_Bot-Trade_Algorithmic_Decision_Integrity_Audit_2026-08-06.md`
- `Result_Bot-Trade_Algorithmic_Decision_Integrity_Audit_2026-08-06_Part2.md`, or its repository equivalent
- repository operating instructions, including `CLAUDE.md`
- relevant PRs and commits from #660 through #668

Treat this as a capital-sensitive production repair—not an ordinary refactor.

Your task is to:

1. determine which audit findings still exist at current `HEAD`;
2. repair confirmed correctness defects in the smallest safe sequence;
3. improve evidence, lineage and observability where causation is not yet proved;
4. keep software fixes separate from owner-controlled risk-policy decisions;
5. prove every fix with failing-before and passing-after tests;
6. provide mechanical rollback instructions;
7. open draft PRs only;
8. never place, amend, cancel or close a live order.

Do not assume that a defect remains merely because it existed at an earlier SHA. Reproduce, disprove or classify it as blocked before changing code.

---

## 1. Non-negotiable safety boundaries

### Live actions prohibited

You MUST NOT:

- invoke `node agent/scripts/exec-parity.js --order`;
- place, amend, cancel or close an order;
- modify an open position;
- change a live account mode;
- change live strategy arming;
- alter credentials or expose secrets;
- change a live risk limit;
- increase leverage, position size or position count;
- weaken capital protection to increase trading frequency;
- deploy directly to production;
- merge a PR.

Production inspection must use authenticated read-only routes. Broker behaviour must be tested through fixtures, mocks, demo-only replay or read-only state.

### Owner-controlled policy

Do not automatically change:

- `minRR`;
- `perTradeRiskPct`;
- `maxRiskCapPct`;
- daily loss caps;
- equity stops;
- exposure and position limits;
- strategy arming;
- profit-keeper policy;
- ratchet policy;
- time caps;
- C++ trail policy;
- deployment of an additional sidecar.

You may produce evidence, counterfactuals and recommendations. Actual policy changes require explicit owner approval.

### Classification contract

Label every proposed action as exactly one of:

- `CORRECTNESS FIX`
- `OBSERVABILITY FIX`
- `TEST/REPLAY INFRASTRUCTURE`
- `OWNER POLICY DECISION`
- `NOT A DEFECT`
- `BLOCKED — EVIDENCE REQUIRED`

Never disguise a policy change as a bug fix.

---

## 2. Correct interpretation of the audits

### Findings requiring present-HEAD investigation

#### A. F-SIZE-01 — risk or sizing containment failure

The audit records a trade on account `46130058` that lost more than the account’s entire configured daily allowance.

Do not raise the daily cap.

Determine whether the event resulted from:

- incorrect position sizing;
- incorrect contract or pip-value conversion;
- volume-step rounding;
- wrong account-currency conversion;
- duplicated submissions or positions;
- missing or failed broker stop;
- market gap or extreme slippage;
- a manual or externally originated position;
- a reconciler-adopted position incorrectly attributed to the bot;
- stale equity or symbol metadata;
- another proved cause.

#### B. F-RISK-01 — live/demo account-side contamination

At the Part 1 SHA, `getCtraderCreds()` computed but did not return `isLive`, while `sameSideAccountIds()` depended on it.

Verify whether current `HEAD` still has this defect.

The required invariant is:

> A sweep must include the selected account and only additional accounts authorised for the same broker host and side.

#### C. Approval-to-order loss

The measured funnel was:

```text
1,802 opportunities
18 approved
10 ordered
7 filled
```

Eight approved opportunities disappeared before becoming orders.

Investigate the entire path from risk approval through dispatch, housekeeping, deduplication, order construction, broker submission and persistence. Review PR #668, but do not assume it completely fixed or deployed the problem.

#### D. Effective `minRR` visibility and provenance

The effective account values were measured at approximately `4.50–6.16`, although global configuration displayed `1.5`.

The engineering problem is that:

- global and account-effective values were easy to confuse;
- an unsupported parameter could silently return global configuration;
- the writer and reason for account overlays were not proved.

Improve truthfulness and provenance. Do not change the values.

#### E. Cup & Handle divergence

A diagnostic reported 1,777 cases clearing all gates, while production liveness reported zero `cup_handle` signals over the comparable period.

Determine whether the difference arises from:

- unequal input bars;
- 210-versus-450-bar windows;
- live versus completed bars;
- diagnostic gates differing from production gates;
- candidate-selection suppression;
- `bestByStrategy`;
- persistence or liveness counting;
- naming or grouping;
- timestamp alignment;
- silent exceptions;
- no-look-ahead differences;
- another measured cause.

Also inspect `inv_cup_handle`.

#### F. Trade-origin and postmortem lineage

Many postmortems lacked thesis, confluence and strategy attribution because the positions appeared to have been adopted by reconciliation rather than opened by the normal bot-dispatch path.

Create explicit origin separation between:

- bot market dispatch;
- bot pending-order fill;
- reconciler adoption;
- manual broker position;
- external system;
- legacy unattributed;
- unknown.

Do not use adopted or manual trades as clean evidence of strategy expectancy.

#### G. Entry/exit calibration mismatch

The audit measured account entry requirements of approximately `4.5–6.16R`, while the sample’s:

- best realised winner was `0.91R`;
- average winner was about `0.15R`;
- eight `clean_win` classifications produced only one full `Win`.

This shows an entry/exit calibration disagreement. It does not yet prove whether `minRR`, the time cap, profit keeper, Node ratchet, C++ TrailEngine, stop placement or another component is wrong.

Build offline replay evidence before recommending a policy change.

### Withdrawn claims—do not fix

Do not implement work based on these superseded claims:

- Do not state that `fib_confluence` is currently off from an aggregated seven-day veto count.
- Do not add another pending-order strategy-disarm mechanism unless the existing `pause-disposition` path is first proved absent or broken.
- Do not describe `entry_quality` as unwritten. The corrected audit says it is derived from `confluence_count`; the examined trades lacked normal dispatch provenance.
- Do not treat a historical aggregate as present state.
- Do not treat absence of a local database as proof that production evidence is unreachable.
- Do not implement any finding solely from a diagnostic count without tracing the production path.

---

## 3. Phase 0 — freeze and reconcile before editing

Record:

- current branch;
- current `HEAD`;
- current `main` SHA;
- deployed SHA, when available;
- Node, npm and compiler versions;
- UTC and SGT timestamps.

Read both audit reports in full, including their correction sections.

Review relevant changes from PRs #660–#668.

Create:

`audit/repair-YYYY-MM-DD/00-reconciliation.md`

Include:

| Finding | Original evidence | Current HEAD | Reproduced? | Classification | Action |
|---|---|---|---|---|---|
| F-SIZE-01 | Production danger proposal | Open/fixed/unknown | Yes/no/blocked | ... | ... |
| F-RISK-01 | Part 1 SHA | ... | ... | ... | ... |
| Approval→order leak | Part 2 funnel | ... | ... | ... | ... |
| Effective risk configuration | Part 2 scoped reads | ... | ... | ... | ... |
| Cup parity | Part 2 diagnostics | ... | ... | ... | ... |
| Trade-origin lineage | Part 2 postmortems | ... | ... | ... | ... |
| Exit mismatch | Part 2 realised R | ... | ... | ... | ... |

Run the safe baseline:

```bash
npm test
shopt -s globstar
node --test agent/**/*.test.js
npm run lint
npm run build
npm run check:no-green
make -C cpp-exec clean
make -C cpp-exec CXX=g++ test
make -C cpp-exec CXX=g++
node agent/scripts/backtest-parity.mjs
node agent/scripts/exec-parity.js
```

Rules:

- Never add `--order`.
- Preserve all failures.
- Record exact exit codes and durations.
- Do not inject live credentials to make a test pass.
- Do not edit production code until reconciliation is complete.

---

## 4. Phase 1 — reconstruct the oversized-loss event

Locate the exact account `46130058` trade represented by the danger proposal.

Produce an immutable lineage containing:

- symbol;
- account and broker side;
- strategy and origin;
- opportunity key;
- decision ID;
- pending-order ID;
- order ID;
- position ID;
- deal IDs;
- account equity at sizing time;
- effective risk configuration;
- intended entry, stop and target;
- intended monetary risk;
- raw calculated volume;
- rounded volume;
- submitted volume;
- broker-accepted volume;
- contract size;
- pip/tick size and value;
- account-currency conversion;
- actual entry and exit;
- stop execution;
- gap and slippage;
- commission, swap and financing;
- duplicate positions or submissions;
- whether the position passed through normal dispatch.

Add:

1. a golden fixture reproducing the sizing calculation;
2. tests for FX, indices, commodities and equity CFDs;
3. account-currency conversion tests;
4. minimum-volume and volume-step boundary tests;
5. missing/stale contract-value tests;
6. a broker-payload equality test;
7. a duplicate-submission test;
8. a gap-risk test distinguishing intended stop risk from executable gap loss;
9. an adopted/manual-position test proving such positions are not represented as risk-engine-sized positions.

Acceptance:

- Root cause is proved or explicitly blocked by named missing evidence.
- No risk limit is increased.
- Unknown contract value or conversion fails closed.
- A regression test fails before the fix and passes after it.
- The final report distinguishes a preventable sizing defect from gap, manual or adopted exposure.

Create:

`audit/repair-YYYY-MM-DD/01-sizing-incident.md`

---

## 5. Phase 2 — verify account-side isolation

Inspect:

- `agent/lib/ctrader-creds.js`
- `agent/services/acting-layer.js`
- loss-cap callers;
- profit-ratchet callers;
- roster and sidecar routing;
- subsequent fixes since the Part 1 SHA.

Use the broker host as the authoritative side where possible.

Required tests:

- live credentials with mixed live/demo registry;
- demo credentials with mixed registry;
- multiple live accounts;
- multiple demo accounts;
- selected account always retained;
- opposite-side accounts always excluded;
- contradictory side and host rejected;
- no silent fallback to demo.

When already fixed, do not rewrite the code merely to create activity. Document the fixing commit and add only missing regression coverage.

Create:

`audit/repair-YYYY-MM-DD/02-account-side-isolation.md`

---

## 6. Phase 3 — every approved opportunity needs a terminal outcome

For every approval, require exactly one durable terminal outcome:

- `order_submitted`
- `pending_order_created`
- `execution_validation_rejected`
- `duplicate_suppressed`
- `expired_before_submission`
- `account_unavailable`
- `broker_rejected`
- `owner_policy_cancelled`
- `internal_error`
- another explicit enumerated outcome

`approved` followed by silence is invalid.

Trace:

- approval persistence;
- queueing;
- housekeeping;
- deduplication;
- connectivity;
- order construction;
- submission;
- broker acknowledgement;
- local persistence;
- exceptions;
- timeouts;
- restart recovery;
- stale work completing after timeout.

Review PR #668 and establish:

- the exact failure;
- whether it explains all eight missing orders;
- whether the fix is merged;
- whether it is deployed;
- whether its precise failure is covered by a regression test.

Implement:

- an immutable transition ledger keyed by `opportunity_key`;
- idempotent retries;
- timestamps for every transition;
- component and reason attribution;
- broker acknowledgement reconciliation;
- an alert for approvals lacking terminal outcome after a bounded interval;
- diagnostics for conversion, latency and terminal reasons.

Required tests:

- normal market order;
- pending-order path;
- broker rejection;
- sidecar unavailable;
- database failure before submission;
- local persistence failure after broker acknowledgement;
- process restart;
- housekeeping concurrency;
- duplicate evaluation;
- retry after timeout;
- stale detached work.

Acceptance:

- Every approved fixture has exactly one terminal outcome.
- Retries cannot create duplicate orders.
- A broker-accepted order cannot be lost from evidence.
- Cleanup cannot remove the sole approval record.
- Missing-terminal-state count is zero in tests.

Create:

`audit/repair-YYYY-MM-DD/03-approval-to-order-lineage.md`

---

## 7. Phase 4 — make effective risk configuration truthful

Do not change `minRR`.

For risk/configuration routes:

- support one documented account parameter;
- reject unsupported parameters with HTTP 400;
- never silently return global configuration for a misspelled account parameter;
- distinguish no account, unknown account and valid account;
- return the account selected.

Return:

```json
{
  "key": "minRR",
  "globalValue": 1.5,
  "overlayValue": 4.68,
  "effectiveValue": 4.68,
  "scope": "account",
  "accountId": "47790949",
  "source": "manual|controller|migration|unknown",
  "sourceId": null,
  "writtenAt": null,
  "writtenBy": null,
  "reason": null,
  "version": "..."
}
```

Use `unknown` or `null` when history is unavailable. Never fabricate provenance.

Every future risk-overlay write must record:

- previous, proposed and applied values;
- account;
- actor;
- source rule;
- evidence window;
- reason;
- timestamp;
- code SHA;
- approval reference;
- rollback value.

Trace `minRR_below_breakeven` and every other writer.

Do not permit a controller to apply an owner-controlled risk change silently. When the current design allows automatic application, separate proposal creation from owner approval unless repository policy explicitly establishes another authorised process.

Produce:

- `audit/repair-YYYY-MM-DD/04-effective-risk-config.md`
- `audit/repair-YYYY-MM-DD/OWNER_DECISION_minRR.md`

The decision memo must show effective values, provenance, veto distribution, realised R, sample limitations and proposed demo experiments. It must state that no threshold was changed.

---

## 8. Phase 5 — Cup & Handle parity

Build a deterministic harness that sends identical data through:

1. the production detector;
2. the diagnostic twin;
3. candidate selection such as `bestByStrategy`;
4. signal persistence;
5. strategy-liveness counting.

Use identical:

- bars;
- timestamps;
- ordering;
- timeframe;
- history length;
- symbol metadata;
- configuration;
- market context;
- feature flags.

Output the first gate where the paths diverge.

Example:

```json
{
  "strategy": "cup_handle",
  "symbol": "EURUSD",
  "decisionTimestamp": "...",
  "barCount": 210,
  "productionSignal": false,
  "diagnosticWouldFire": true,
  "selectedAsBest": false,
  "persisted": false,
  "firstDivergence": "handle_ratio"
}
```

Test:

- positive controls for `cup_handle`;
- positive controls for `inv_cup_handle`;
- negative controls;
- 210-versus-450 bars;
- live versus closed bar;
- boundary timestamps;
- volume normalisation;
- duplicated and out-of-order bars;
- candidate selection;
- persistence;
- liveness grouping;
- determinism;
- no look-ahead.

Acceptance:

- The 1,777-versus-zero divergence is quantitatively explained.
- Diagnostic and production either share canonical gates or have explicit tested reasons to differ.
- Positive controls pass through the complete production persistence path.
- No strategy gate is weakened merely to produce signals.

Create:

`audit/repair-YYYY-MM-DD/05-cup-handle-parity.md`

---

## 9. Phase 6 — repair trade-origin lineage

Use one canonical origin enum:

- `bot_market_dispatch`
- `bot_pending_fill`
- `reconciler_adopted`
- `manual_broker`
- `external_system`
- `legacy_unattributed`
- `unknown`

Propagate where available:

- strategy;
- opportunity key;
- decision ID;
- pending-order ID;
- order ID;
- position ID;
- account;
- origin;
- setup thesis;
- confluence;
- effective risk at entry;
- planned R:R;
- actual execution;
- exit component and reason.

Rules:

- Reconciliation must not invent a strategy.
- Adopted/manual positions must be excluded from clean strategy-edge measurements or reported separately.
- Historical unknowns remain unknown unless deterministic evidence supports backfill.
- Backfills must support dry run and rollback.
- Performance endpoints must show attribution coverage.

Create:

`audit/repair-YYYY-MM-DD/06-trade-origin-lineage.md`

---

## 10. Phase 7 — offline exit counterfactual

After lineage is reliable, reconstruct management chronology for clean bot-origin trades:

- original stop and target;
- MFE and MAE;
- Node profit keeper;
- Node ratchet;
- C++ TrailEngine;
- time cap;
- guardian;
- loss cap;
- exit reason;
- realised R;
- giveback.

Replay:

1. current policy;
2. no time cap;
3. no profit keeper;
4. no Node ratchet;
5. no C++ trail;
6. original stop/target only;
7. each component individually;
8. cost and slippage stress.

Report:

- sample and coverage;
- expectancy;
- mean and median R;
- win rate;
- average win and loss;
- drawdown;
- tail loss;
- giveback;
- holding time;
- confidence or bootstrap intervals.

Do not recommend an exit-policy change from average return alone. Include drawdown, tails and exposure duration.

Do not change live exit settings.

Create:

`audit/repair-YYYY-MM-DD/07-exit-counterfactual.md`

---

## 11. PR sequence

Use separate draft PRs:

### PR A — Capital correctness

- F-SIZE-01, only after causation;
- F-RISK-01 verification or repair;
- capital-danger observability.

### PR B — Approval terminal-state integrity

- approval-to-order lineage;
- PR #668 verification;
- idempotency;
- watchdog.

### PR C — Effective risk truth and provenance

- strict route parameters;
- global/overlay/effective values;
- append-only change history;
- no threshold change.

### PR D — Cup detector parity

- parity harness;
- canonical gates where justified;
- positive controls;
- persistence proof.

### PR E — Trade-origin lineage

- schema;
- propagation;
- coverage;
- reversible backfill tooling.

### PR F — Offline replay tooling

- exit counterfactuals;
- demo experiment specification;
- no live policy changes.

Each PR must state:

- exact evidence;
- classification;
- files changed;
- tests;
- exit codes;
- before/after behaviour;
- capital and operational blast radius;
- rollback;
- residual risks;
- deployment status;
- “No live trading action was taken.”

---

## 12. Evidence format

Use for every finding:

```markdown
### ID — Finding

**Classification:** ...
**Severity:** ...
**Confidence:** ...
**Status:** reproduced | disproved | fixed | blocked
**SHA:** ...
**Scope:** ...

#### Observation
Direct evidence.

#### Reproduction
Exact command, query, fixture or test.

#### Causal chain
Input-to-effect path.

#### Counter-evidence
Facts limiting the conclusion.

#### Economic effect
Capital, opportunity, execution or evidence impact.

#### Minimum sufficient remedy
Smallest safe fix.

#### Policy boundary
What was deliberately not changed.

#### Regression proof
Failing-before and passing-after evidence.

#### Rollback
Mechanical reversal.

#### Residual risk
Remaining unknowns.
```

Do not use “proved”, “fixed”, “safe” or “parity” without evidence.

---

## 13. Stop and push back

Stop for owner direction when:

- a change modifies a risk threshold;
- a migration could affect live orders or positions;
- a second production service is required;
- testing would require an order;
- evidence supports multiple material root causes;
- the repair increases exposure or trading frequency;
- the current defect cannot be reproduced;
- policy and correctness cannot be separated.

Push back when asked to:

- lower `minRR` merely to make the bot trade;
- raise the daily cap to fit the oversized loss;
- relax exits before clean-origin replay;
- count adopted/manual trades as strategy edge;
- fix the withdrawn pending-order or `entry_quality` claims;
- merge a broad unisolated patch;
- call green tests proof of profitability.

---

## 14. Final acceptance gates

The work is not complete until:

### Capital

- F-SIZE-01 is explained or explicitly blocked.
- Correctness defects have failing-before and passing-after tests.
- No risk limit was increased.
- Cross-side account selection is impossible by invariant.

### Opportunity flow

- Every approval has one terminal state.
- Retry and restart do not duplicate orders.
- PR #668’s failure is covered or shown irrelevant.
- No approval silently disappears.

### Configuration

- Effective and global values cannot be confused.
- Unsupported parameters fail.
- Future overlay writes are attributable.
- No silent automatic risk-policy change occurs.

### Detector integrity

- Production and diagnostics are comparable on identical input.
- First divergence is visible.
- Both Cup strategies have positive controls.
- No gate is weakened without approval.

### Lineage

- New bot trades carry origin and strategy provenance.
- Adopted/manual trades are separated.
- Coverage is disclosed beside metrics.
- Unknown history is not fabricated.

### Repository quality

```bash
npm test
shopt -s globstar
node --test agent/**/*.test.js
npm run lint
npm run build
npm run check:no-green
make -C cpp-exec CXX=g++ test
node agent/scripts/backtest-parity.mjs
```

Record every exit code.

---

## 15. Final deliverables

Create:

```text
audit/repair-YYYY-MM-DD/
├── 00-reconciliation.md
├── 01-sizing-incident.md
├── 02-account-side-isolation.md
├── 03-approval-to-order-lineage.md
├── 04-effective-risk-config.md
├── 05-cup-handle-parity.md
├── 06-trade-origin-lineage.md
├── 07-exit-counterfactual.md
├── OWNER_DECISION_minRR.md
├── OWNER_APPROVAL_REQUIRED_demo-minRR-experiment.md
├── acceptance-gates.md
├── rollback-plan.md
├── evidence/
└── machine/
```

Final report:

`instr/Result_Bot-Trade_Verified_Defect_Repair_YYYY-MM-DD.md`

End by answering:

> Has the repair made the system more correct and measurable without weakening capital protection or pretending that the trading edge is proven?

Use exactly one verdict:

- `YES — PROVED WITH EVIDENCE`
- `PARTIAL — SPECIFIED GATES REMAIN`
- `NO — REPAIR NOT PROVED`

---

## First instruction

Begin with Phase 0 only.

Do not edit code in your first response.

Return:

1. frozen current SHA;
2. audit reconciliation table;
3. safe command plan;
4. files and read-only runtime routes to inspect;
5. contradictions between the audits and current `HEAD`;
6. proposed draft-PR boundaries;
7. owner-policy decisions that will remain untouched.

Proceed to code changes only after present-HEAD evidence establishes which defects still exist.