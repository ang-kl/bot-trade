# Bot-Trade Agent-Graph Engineering Audit Prompt

**Repository:** `https://github.com/ang-kl/bot-trade`  
**Target branch:** `main`  
**Mode:** `AUDIT-FIRST, NON-PRODUCTION, EVIDENCE-PRESERVING`  
**Primary concern:** Determine whether repeated safety, risk, C++, profit-keeping, stop-loss and performance-governance PRs have made the system too reluctant to take calculated risk or too quick to terminate valid trades.

---

# 1. Mission

Operate as a graph of independent specialist agents rather than one monolithic agent.

The graph must determine whether `bot-trade` is:

- under-defended;
- proportionately defended;
- over-defended;
- or mixed by subsystem.

The audit must focus especially on:

- C++ execution and Node/C++ authority;
- C++ TrailEngine behaviour;
- profit-keeping policy;
- stop-loss creation, amendment and reaction;
- time caps and forced closures;
- entry-veto accumulation;
- strategy arming and disarming;
- profit-factor and win-rate goals;
- payoff-ratio preservation;
- trade-frequency suppression;
- risk-budget utilisation;
- evidence gaps caused by repeated PRs.

The purpose is not to maximise trading frequency.

The purpose is:

> **Take sufficient, intentional and bounded risk to realise positive expectancy, while preventing ruin, uncontrolled exposure and untraceable execution.**

---

# 2. Graph Principle

Use the following workflow:

```text
PRODUCER / TRIAGE
        |
        v
   SHARED BACKLOG
        |
        v
READY
  |
  v
DELEGATE
  |
  v
INDEPENDENT REVIEW
  |
  v
MECHANICAL GATE
  |
  v
SERIAL INTEGRATION
  |
  v
NON-PRODUCTION DEPLOYMENT
  |
  v
EXTERNAL UAT
  |
  v
RECONCILIATION
  |
  v
DONE
```

Failure paths:

```text
REVIEW FAILURE
   -> REPAIR
   -> return to INDEPENDENT REVIEW

MECHANICAL GATE FAILURE
   -> REPAIR
   -> return to MECHANICAL GATE

DEPLOYMENT OR UAT FAILURE
   -> BLOCKED
   -> HUMAN DECISION OR EXPLICIT RELEASE

CONTRADICTORY EVIDENCE
   -> BLOCKED
   -> HUMAN DECISION

UNSAFE OR LIVE-TRADING IMPACT
   -> BLOCKED
   -> HUMAN DECISION
```

No station may silently erase failed work.

Every package must preserve:

- original hypothesis;
- evidence collected;
- commands executed;
- files inspected;
- outputs produced;
- uncertainty;
- reviewer objections;
- gate failures;
- repair history;
- final disposition.

---

# 3. Core Graph Rules

## 3.1 Producer and consumer separation

One producer agent finds, scopes and packages work.

Consumer agents execute only bounded packages.

The producer must not implement, merge or approve its own packages.

## 3.2 Independent review

Whoever wrote or changed a package is not permitted to review it.

The reviewer must be a different agent instance or model.

## 3.3 Serial integration

Discovery and analysis may run in parallel.

Repository integration must be serial.

Only one integration worker may hold the repository write lock at a time.

## 3.4 Bounded work packages

No package may contain an entire subsystem unless decomposition would destroy a necessary cross-layer trace.

A package should normally cover one of:

- one workflow trace;
- one control family;
- one authority boundary;
- one historical counterfactual;
- one evidence or telemetry gap;
- one confirmed defect;
- one remediation PR.

## 3.5 Evidence before remediation

No package may enter implementation until:

1. the defect or policy conflict is evidenced;
2. the affected scope is known;
3. the minimum safe remedy is defined;
4. the regression test is specified;
5. owner-policy implications are separated;
6. rollback is defined.

## 3.6 No production trading actions

Agents must not:

- arm live autotrade;
- enable a live strategy;
- place orders;
- amend live stops;
- close live positions;
- alter live risk;
- switch account modes;
- change broker credentials;
- deploy unreviewed code to production.

## 3.7 Human authority

A human is required for:

- live-trading activation;
- risk-threshold changes;
- profit-factor or win-rate goal changes;
- strategy-arming policy;
- stop-loss widening;
- profit-keeper relaxation;
- C++/Node authority changes;
- accepting unresolved capital risk;
- overriding failed UAT;
- merging a package labelled `OWNER POLICY DECISION`.

---

# 4. Shared State Model

Every package must have a durable state.

Allowed states:

```text
TRIAGED
READY
DELEGATED
IN_PROGRESS
REVIEW
REPAIR
GATE
INTEGRATION_QUEUE
INTEGRATING
DEPLOYED_NON_PROD
UAT
RECONCILIATION
DONE
BLOCKED
REJECTED
SUPERSEDED
```

State transitions must be explicit.

No package may jump directly from `IN_PROGRESS` to `DONE`.

Minimum valid success path:

```text
TRIAGED
-> READY
-> DELEGATED
-> IN_PROGRESS
-> REVIEW
-> GATE
-> INTEGRATION_QUEUE
-> INTEGRATING
-> DEPLOYED_NON_PROD
-> UAT
-> RECONCILIATION
-> DONE
```

Audit-only packages that do not change code may use:

```text
TRIAGED
-> READY
-> DELEGATED
-> IN_PROGRESS
-> REVIEW
-> GATE
-> DONE
```

---

# 5. Package Schema

Every package must use this structure:

```yaml
package_id:
title:
parent_hypothesis:
audit_domain:
package_type:
  - discovery
  - trace
  - measurement
  - counterfactual
  - defect
  - remediation
priority:
risk_class:
  - CAPITAL
  - SECURITY
  - CORRECTNESS
  - DATA
  - RELIABILITY
  - OBSERVABILITY
  - POLICY
scope:
files_expected:
runtime_data_needed:
dependencies:
conflicts_with:
assigned_worker:
reviewer:
state:
created_at:
updated_at:
```

Package body:

```markdown
## Question

## Why this package exists

## In scope

## Out of scope

## Expected evidence

## Required commands

## Required source traces

## Runtime evidence required

## Stop conditions

## Deliverables

## Acceptance criteria

## Regression tests

## Policy decisions

## Rollback considerations

## Evidence ledger
```

---

# 6. Producer Agent

## 6.1 Role

The Producer is a vision, repository-orientation and browser-control agent.

It may:

- inspect the repository;
- inspect recent PRs and commits;
- map files and subsystems;
- identify audit hypotheses;
- create bounded packages;
- prioritise packages;
- identify dependencies;
- identify conflicts;
- route work to specialists.

It must not:

- edit production code;
- approve its own packages;
- merge changes;
- change runtime configuration;
- alter live trading.

## 6.2 Producer tasks

The Producer must first create a baseline package containing:

```bash
git status --short
git branch --show-current
git rev-parse HEAD
git log -60 --date=iso --pretty=format:'%h | %ad | %s'
git diff --stat
git ls-files
```

It must record:

- exact source SHA;
- deployed SHA if available;
- repository version;
- current execution engine;
- Node/C++ active modes;
- live/demo account modes;
- current strategy registry;
- current enabled strategies;
- current matrices;
- current risk settings;
- current profit-keeper settings;
- current goal settings;
- current breaker settings;
- current C++ trail status;
- current known audit reports.

The Producer then creates work packages for the domains below.

---

# 7. Mandatory Workstreams

The Producer must create separate packages for at least these workstreams.

## WS-01 - Entry Veto Funnel

Reconstruct:

```text
symbols considered
-> usable market data
-> strategy computation
-> setup detected
-> matrix eligibility
-> risk gate
-> order intent
-> execution
-> broker acceptance
-> position opened
```

Measure:

- first veto;
- all applicable vetoes;
- gross veto count;
- unique veto count;
- overlapping veto count;
- marginal reduction in trades;
- blocked opportunity outcomes;
- risk avoided.

## WS-02 - Defensive PR Accumulation

Inspect recent PRs and commits that added or tightened:

- risk gates;
- duplicate prevention;
- cooldowns;
- account checks;
- arming bars;
- disarming rules;
- time caps;
- loss caps;
- profit keeper;
- spike tightening;
- C++ trail;
- C++ guards;
- performance breaker;
- goal tracker;
- post-decision audit.

Determine cumulative effect, not only local correctness.

## WS-03 - C++ Execution Authority

Map:

- order placement;
- amendment;
- close;
- cancellation;
- reconciliation;
- account authentication;
- account roster;
- request-response correlation;
- Node fallback;
- broker acknowledgement;
- durable recording.

## WS-04 - C++ TrailEngine

Trace:

```text
Node policy
-> trail specification
-> C++ ingestion
-> account validation
-> tick
-> peak update
-> stop candidate
-> pending amend
-> broker response
-> C++ status
-> Node readback
-> broker reconciliation
```

## WS-05 - Stop-Loss Authorities

Identify every component that can:

- set a stop;
- tighten a stop;
- widen a stop;
- close because of a stop;
- reinterpret a stop;
- overwrite a manual stop.

## WS-06 - Profit Keeper

Audit:

- adaptive mode;
- fixed mode;
- fallback behaviour;
- ATR source;
- spike tightening;
- balance floor;
- trailing distance;
- hard take profit;
- scale-out;
- broker rejections;
- Node/C++ overlap;
- restart behaviour;
- cross-currency handling.

## WS-07 - Time Caps and Forced Exits

Audit whether time caps:

- match strategy timeframe;
- fire before thesis maturity;
- remain behind unrelated data gates;
- close unpriceable positions safely;
- create systematic early exits;
- interact with profit keeper and stop loss.

## WS-08 - Goal Coherence

Map:

- go-live profit-factor target;
- go-live win-rate target or display;
- `gateOn`;
- strategy-arming profit factor;
- strategy-arming win rate;
- minimum sample;
- breaker threshold;
- breaker action;
- strategy-specific seed thresholds;
- deadline;
- trade-rate assumptions.

## WS-09 - Payoff and Winner Truncation

Measure whether:

- tighter stops increase win rate but reduce profit factor;
- break-even movement happens too early;
- spike tightening removes runners;
- partial profits starve large winners;
- Node and C++ double-tighten;
- strategy timeframe and management timeframe conflict.

## WS-10 - Counterfactual Replay

Compare:

- current stack;
- pre-safety-PR stack;
- one-gate-removed;
- one-threshold-relaxed;
- Node trail only;
- C++ trail only after Node arm;
- no spike tightening;
- later profit arming;
- wider trail;
- no profit keeper;
- partial profit plus wider runner;
- graduated risk allocation.

## WS-11 - Risk-Budget Utilisation

Measure:

- authorised risk;
- actual risk deployed;
- idle capital;
- time enabled but unable to trade;
- strategies effectively disarmed;
- unused daily risk;
- opportunities blocked;
- time in market.

## WS-12 - Observability and Evidence Quality

Test whether the system can report:

- healthy while no useful work occurred;
- protected while no stop exists at the broker;
- all accounts while only one account was checked;
- zero while values are missing;
- closed while broker position remains open;
- strategy failure as no setup;
- order failure as no trade;
- C++ active while a required account is unauthorised.

---

# 8. Specialist Worker Roles

Workers are interchangeable, but each package must name a required competency.

Suggested competencies:

```text
C++ execution specialist
Node.js trading-pipeline specialist
quantitative performance analyst
SQLite and accounting specialist
broker-integration specialist
test and CI specialist
security specialist
UI/API contract specialist
counterfactual replay specialist
PR-history and architecture-drift specialist
```

A worker must:

1. accept only one bounded package at a time;
2. freeze the relevant SHA;
3. record commands before running them;
4. preserve raw evidence;
5. separate observation from inference;
6. label unavailable runtime evidence;
7. return a structured result;
8. not review its own result.

---

# 9. Worker Output Contract

Every worker returns:

```markdown
# Package Result

## Package identity

## Frozen SHA

## Question answered

## Executive answer

## Evidence

## Source trace

## Runtime evidence

## Measurements

## Counterfactual result

## Findings

## Contradictory evidence

## Unknowns

## Data requests

## Minimum safe remedy

## Owner-policy decisions

## Regression tests

## Suggested next package

## Evidence ledger
```

Every finding must include:

| Field | Requirement |
|---|---|
| ID | Stable finding ID |
| Classification | Defect, over-defence, under-defence, policy conflict or evidence gap |
| Severity | Capital, high, medium or low |
| Confidence | High, medium or low |
| Trigger | Exact reachable condition |
| Current effect | What happens now |
| Opportunity effect | What valid trading may be lost |
| Risk benefit | What harm the control prevents |
| Marginal effect | Unique effect after overlap |
| Evidence | Files, functions, lines, logs and data |
| Minimum remedy | Smallest correction |
| Policy decision | Human approval required or not |
| Regression test | Required proof |
| Rollback | Safe reversal |

---

# 10. Independent Review Station

## 10.1 Reviewer independence

The reviewer must not be the worker who produced the package.

Where practical, use a different model family.

## 10.2 Review questions

The reviewer must test:

- Was one exact SHA used?
- Is the finding reachable?
- Is the consequence proportionate?
- Was missing data mistaken for zero?
- Was an alert mistaken for enforcement?
- Was one account mistaken for all accounts?
- Was a monitor mistaken for successful work?
- Was a comment treated as proof?
- Was a losing trade treated as proof that a veto was needed?
- Was a missed winner treated as proof that a veto was wrong?
- Were overlapping vetoes separated?
- Was marginal effect measured?
- Was profit factor analysed with payoff and win rate?
- Was C++/Node authority established?
- Was broker acknowledgement distinguished from local intent?
- Was owner policy separated from correctness?
- Is the minimum remedy smaller than the proposed redesign?

## 10.3 Review verdicts

Allowed verdicts:

```text
ACCEPT
ACCEPT WITH MINOR REPAIR
REPAIR REQUIRED
BLOCKED - MISSING EVIDENCE
BLOCKED - POLICY DECISION
REJECT - NOT ESTABLISHED
SUPERSEDED
```

A reviewer must state exact reasons.

---

# 11. Mechanical Quality Gate

The Gate is not a subjective reviewer.

It verifies required structure and reproducibility.

For audit packages, the Gate checks:

- package schema complete;
- frozen SHA recorded;
- commands recorded;
- evidence references present;
- unresolved assumptions labelled;
- reviewer is independent;
- finding IDs stable;
- no missing acceptance criteria;
- no production changes;
- no secret leakage;
- no unsupported capital claims;
- no self-approval.

For code packages, the Gate must run the repository's full validation suite:

```bash
shopt -s globstar
node --test agent/**/*.test.js
npx eslint .
npx vitest run
npm run build
npm run check:no-green
```

Where relevant, also run:

- C++ build;
- C++ unit tests;
- Node/C++ parity tests;
- schema migration tests;
- real-SQL tests;
- account-stamping tests;
- ambiguous-order tests;
- stop-amend rejection tests;
- restart tests;
- multi-account tests;
- stale-price tests;
- null-P&L tests;
- health-exposure tests.

The Gate records:

```text
command
exit code
duration
test count
failure count
artifact location
```

A green Gate does not erase a source finding outside the tested contract.

---

# 12. Repair Station

Repair is a separate package state.

Repair must:

- address only stated reviewer or Gate failures;
- preserve prior evidence;
- append a repair note;
- avoid unrelated refactoring;
- return to the failed station;
- not skip independent review;
- not rewrite history to make the first attempt appear successful.

Repair output:

```markdown
## Repair reason

## Original failure

## Exact changes

## Evidence retained

## New tests

## Residual risk

## Return station
```

---

# 13. Shared Lock and Serial Integration

## 13.1 Shared lock

All repository writes require a shared integration lock.

Only one package may be in `INTEGRATING`.

## 13.2 Integration order

Integrate in dependency order:

```text
truth and identity
-> broker correctness
-> stop-loss safety
-> observability
-> duplicate or obsolete controls
-> threshold or policy experiments
-> UI changes
```

## 13.3 Integration worker

The integration worker must:

- confirm package acceptance;
- confirm Gate success;
- confirm no conflict with packages already merged;
- rebase or update from current main;
- rerun affected tests;
- make one bounded commit or PR;
- record resulting SHA;
- release the lock.

The integration worker does not independently expand scope.

---

# 14. Non-Production Deployment

Accepted code changes must first deploy to:

- local test environment;
- isolated Railway service;
- demo cTrader account;
- or another non-production environment.

Deployment must record:

- source SHA;
- environment;
- account mode;
- configuration;
- feature flags;
- deployment time;
- health result;
- controller status;
- broker connectivity;
- C++ status;
- trail status;
- data-migration result.

No package moves to UAT without matching source and deployed SHA.

---

# 15. External UAT

UAT must be performed by an agent or human that did not implement the package.

UAT must verify externally observable behaviour.

Examples:

## Entry-veto UAT

- candidate reaches expected stages;
- first and all veto reasons are visible;
- unique blocker is identifiable;
- no false `no setup` result;
- no unexpected live action.

## C++ execution UAT

- correct account;
- correct symbol;
- correct direction;
- correct volume;
- correct stop and target;
- request-response correlation;
- durable order intent;
- broker acknowledgement;
- reconciliation.

## Profit-keeper UAT

- arms at expected threshold;
- normal trail distance correct;
- spike trail correct;
- no premature fallback;
- Node and C++ status agree;
- broker stop matches;
- failed amend visible;
- no stop widening.

## Goal UAT

- effective runtime goal matches UI;
- `gateOn` is clear;
- profit factor, payoff and win rate reconcile;
- sample size is visible;
- target does not silently block evidence generation.

UAT outcomes:

```text
PASS
FAIL - REPAIR
BLOCKED - ENVIRONMENT
BLOCKED - DATA
BLOCKED - HUMAN DECISION
```

---

# 16. Reconciliation Station

After UAT, reconcile:

```text
intended change
implemented code
deployed SHA
runtime configuration
broker behaviour
database state
UI state
logs
alerts
tests
UAT observation
```

The package is not done until these agree or a discrepancy is explicitly accepted by a human.

Reconciliation must answer:

- Did the intended control act?
- Did it act on the correct account?
- Did the broker accept it?
- Did local state record broker truth?
- Did the UI display broker truth?
- Did another controller counteract it?
- Did the change alter trade frequency?
- Did it alter payoff or stop reaction?
- Did it create a new silent path?

---

# 17. Blocked and Human Escalation

A package becomes `BLOCKED` when:

- live data is required but unavailable;
- deployed SHA differs;
- broker history is required;
- contradictory evidence remains;
- owner policy is required;
- a live-risk change is proposed;
- UAT cannot be completed;
- capital impact cannot be bounded;
- Node/C++ authority cannot be established;
- the remediation would widen stop loss;
- a threshold change lacks out-of-sample evidence.

The escalation must contain:

```markdown
## Decision required

## Why the graph cannot decide safely

## Options

## Evidence for each option

## Risk of action

## Risk of inaction

## Recommended reversible next step
```

The human may:

```text
APPROVE
REJECT
REQUEST MORE EVIDENCE
APPROVE NON-PRODUCTION TEST ONLY
ACCEPT RESIDUAL RISK
DEFER
```

---

# 18. Audit-Specific Calculations

## 18.1 Profit factor

Use:

```text
Profit Factor
= Gross Profit / Gross Loss

Equivalent:
Profit Factor
= (Win Rate x Average Win)
  /
  ((1 - Win Rate) x Average Loss)
```

Do not optimise win rate independently from payoff.

## 18.2 Marginal veto effect

For each gate calculate:

```text
gross vetoes
unique vetoes
overlapping vetoes
trades restored if removed
change in profit factor
change in expectancy
change in maximum drawdown
change in tail loss
change in risk-budget utilisation
```

## 18.3 Profit-retention effect

For each exit mechanism calculate:

```text
MFE
realised P&L
MFE captured percentage
time to first tighten
distance at first tighten
post-exit movement
winner-to-scratch conversion
large-winner suppression
drawdown reduction
```

## 18.4 Calculated-risk utilisation

Calculate:

```text
authorised risk
risk deployed
risk unused
time capital remained idle
valid opportunities
unique blocks
time strategies were effectively unable to trade
```

---

# 19. Counterfactual Package Requirements

Counterfactual packages must compare at least:

```text
A - Current stack
B - Previous material stack
C - Remove one gate
D - Relax one threshold
E - Node keeper only
F - C++ trail only after Node arm
G - No spike tightening
H - Later profit arming
I - Wider trail
J - Original stop and target only
K - Partial profit plus wider runner
L - Graduated risk allocation
```

Use hold-out or walk-forward evaluation.

Do not tune and score on the same period.

Report:

- trades;
- win rate;
- average win;
- average loss;
- payoff;
- profit factor;
- expectancy;
- total P&L;
- maximum drawdown;
- tail loss;
- risk of ruin;
- time in market;
- risk deployed;
- MFE captured;
- stop-out rate;
- large-winner rate.

---

# 20. Finding Standards

Use stable families:

```text
F-CPP-xx
F-VETO-xx
F-SL-xx
F-PK-xx
F-TIME-xx
F-GOAL-xx
F-PF-xx
F-DATA-xx
F-OBS-xx
F-POLICY-xx
```

Over-defence may be labelled only when:

1. a control uniquely blocks or exits a material set;
2. the affected trades have positive or plausibly positive out-of-sample expectancy;
3. relaxation does not create disproportionate drawdown or tail risk;
4. the behaviour is not an explicit owner policy;
5. the pattern persists beyond a cherry-picked sample.

Use:

```text
CONFIRMED OVER-DEFENCE
CONDITIONAL OVER-DEFENCE
NOT ESTABLISHED
```

---

# 21. Final Graph Deliverables

The graph must produce:

## 21.1 Executive verdict

Answer:

- Has the system become too reluctant to trade?
- Has it become too quick to protect small profits?
- Are Node and C++ stop mechanisms coherent?
- Are profit-factor and win-rate goals coherent?
- Which three controls have the greatest marginal effect?
- Which safeguards remain essential?
- Which controls are duplicated, obsolete, too broad or too strict?

## 21.2 Graph backlog

Show every package and state.

## 21.3 Dependency graph

Show package dependencies and blocked paths.

## 21.4 Entry-veto funnel

Show counts, unique blockers and overlapping blockers.

## 21.5 C++ authority map

Show policy, execution, persistence and reconciliation ownership.

## 21.6 Stop-loss reaction map

Show every stop authority, cadence and precedence.

## 21.7 Profit-keeper counterfactual

Show protection benefit versus winner truncation.

## 21.8 Goal-coherence report

Show profit factor, win rate, payoff, sample and arming relationships.

## 21.9 PR accumulation register

Show how repeated PRs changed cumulative behaviour.

## 21.10 Remediation graph

Use these waves:

```text
Wave 0 - Broker, account and stop-loss correctness
Wave 1 - Truth, attribution and observability
Wave 2 - Remove duplicated or obsolete controls
Wave 3 - Rebalance excessive entry defence
Wave 4 - Rebalance profit keeping and stop reactions
Wave 5 - Optional graduated calculated-risk allocation
```

## 21.11 Human decision register

List all unresolved policy choices.

## 21.12 Audit completeness statement

State:

- source SHA;
- deployed SHA;
- files inspected;
- runtime systems accessed;
- tests run;
- packages completed;
- packages blocked;
- confirmed findings;
- conditional findings;
- unresolved evidence gaps.

---

# 22. Final Operating Principle

Parallelise discovery.

Bound implementation.

Separate authorship from review.

Use a mechanical gate.

Integrate serially.

Deploy only to non-production first.

Require external UAT.

Reconcile against broker truth.

Preserve failed evidence.

Escalate policy and live-risk decisions to a human.

Do not optimise the system merely to avoid losing trades.

A viable trading system must be permitted to lose within an intentional and bounded risk budget.

The graph must establish whether each control improves survival and expectancy, or merely reduces activity and makes the system appear safer.
