# Bot-Trade Calculated-Risk, Trade-Readiness and Defensive-Drift Audit

**Repository:** `https://github.com/ang-kl/bot-trade`  
**Target branch:** `main`  
**Mode:** `AUDIT-ONLY`  
**Primary question:** Has the accumulation of multiple safety, risk, monitoring and profit-protection PRs made the system excessively reluctant to take calculated risk or excessively quick to terminate valid trades?

---

## 1. Role

Act as an independent senior:

- algorithmic-trading systems auditor;
- quantitative risk reviewer;
- C++ and Node.js execution engineer;
- cTrader integration specialist;
- trade-lifecycle investigator;
- performance-measurement analyst;
- production reliability and data-integrity reviewer.

Do not approach this audit as a conventional search for “more safeguards”.

The repository already contains extensive safeguards. The principal concern is now whether individually defensible controls have accumulated into an excessively defensive system that:

- rarely enters otherwise valid trades;
- requires overlapping evidence for the same decision;
- repeatedly vetoes the same risk through different gates;
- exits winners before their thesis has time to develop;
- tightens stops faster than the strategy horizon warrants;
- values win rate at the expense of payoff and profit factor;
- suppresses trade frequency until performance targets become statistically unreachable;
- mistakes avoidance of losses for evidence of a profitable trading edge.

The correct objective is not maximum safety and not maximum trading frequency.

The objective is:

> **Take sufficient, intentional and bounded risk to realise positive expectancy, while preventing ruin, uncontrolled exposure and untraceable execution.**

---

## 2. Audit Question

Determine which of these three verdicts best describes the current system:

### A. Under-defended

The system can take unintended, oversized, duplicated, unprotected or incorrectly routed risk.

### B. Proportionately defended

The system accepts ordinary trading losses and uncertainty while preventing unacceptable capital loss and execution failure.

### C. Over-defended

The system blocks or prematurely terminates a material number of positive-expectancy opportunities without producing a proportionate reduction in drawdown, tail risk or capital-loss probability.

Do not choose a verdict from code-reading impressions.

Establish it through:

1. source-code tracing;
2. configuration tracing;
3. PR and commit-history analysis;
4. veto-frequency measurement;
5. historical trade and candidate-signal data;
6. counterfactual replay;
7. out-of-sample or walk-forward validation;
8. C++ versus Node behavioural comparison;
9. profit-retention and stop-reaction analysis.

---

## 3. Non-Negotiable Audit Rules

1. Freeze and record the exact commit SHA.

2. Do not change code, configuration, broker state or live trading settings.

3. Do not place, amend, cancel or close any live order.

4. Do not assume that a safety control is beneficial merely because it blocks or closes a trade.

5. Do not assume that a larger number of trades is desirable merely because the system presently trades too little.

6. Do not treat every losing trade as evidence that a gate should have stopped it.

7. Do not treat every missed winner as evidence that a gate was wrong.

8. Evaluate expected value, drawdown, risk of ruin, payoff and opportunity cost together.

9. Separate:
   - entry-quality controls;
   - capital-preservation controls;
   - trade-management controls;
   - performance-governance controls;
   - observability controls.

10. A monitoring or reporting control must not be counted as a trading veto unless it actually blocks, disarms, amends or closes.

11. A configured control must not be counted as effective unless its action branch is reachable and broker-acknowledged.

12. Comments and documentation describe intent. Code, configuration, durable state and broker evidence establish behaviour.

13. No recommendation may secretly change the owner’s risk policy.

14. Any proposed threshold change must be labelled:

```text
OWNER POLICY DECISION - NOT A CORRECTNESS FIX
```

---

# PART I - RECONSTRUCT THE CURRENT TRADING SYSTEM

## 4. Freeze the Baseline

Record:

```bash
git status --short
git branch --show-current
git rev-parse HEAD
git log -40 --date=iso --pretty=format:'%h | %ad | %s'
git diff --stat
```

Record:

- exact SHA;
- repository version;
- dirty or clean state;
- current Node execution mode;
- current C++ execution mode;
- `EXEC_ENGINE`;
- C++ sidecar deployment status;
- live versus demo account status;
- enabled account roster;
- current strategy registry;
- enabled strategies;
- current autotrade matrix;
- pending-order matrix;
- current risk configuration;
- profit-keeper configuration;
- performance-breaker configuration;
- trading-goal configuration;
- strategy-autopilot mode;
- C++ trail status;
- relevant environment variables, with secrets redacted.

If deployed SHA and repository SHA differ, report:

```text
SOURCE/DEPLOYMENT SHA MISMATCH
```

Do not combine evidence from them.

---

## 5. Reconstruct the End-to-End Decision Path

Trace the actual path from market data to closure:

```text
account and symbol eligibility
→ market-hours eligibility
→ market-data availability and freshness
→ strategy enabled
→ strategy setup
→ timeframe and matrix eligibility
→ regime and volatility checks
→ signal-quality checks
→ risk sizing
→ currency conversion
→ exposure and margin checks
→ duplicate and cooldown checks
→ order intent
→ C++ or Node execution
→ broker acknowledgement
→ trade and position persistence
→ stop-loss protection
→ position monitoring
→ profit keeper
→ C++ trailing
→ time cap
→ loss cap
→ equity stop
→ breaker or disarm logic
→ broker closure
→ reconciliation
→ realised P&L
→ performance and goal reporting
```

For every stage record:

| Field | Required evidence |
|---|---|
| Stage | Stable stage name |
| Purpose | What risk or quality problem it addresses |
| Input | Required data |
| Threshold | Exact configured value |
| Scope | Strategy, symbol, account, position or portfolio |
| Outcome | Pass, veto, defer, amend, close, disarm or alert |
| Authority | Node, C++, database, broker or UI |
| Persistence | Where the result is recorded |
| Failure behaviour | Fail-open, fail-closed or unknown |
| Overlap | Other controls addressing the same risk |
| Operator visibility | How the owner can inspect it |

---

# PART II - AUDIT WHETHER THE SYSTEM HAS BECOME TOO RELUCTANT TO TRADE

## 6. Build the Complete Veto Funnel

Measure the full funnel over meaningful periods such as:

- latest FX day;
- latest 3 days;
- latest 7 days;
- latest 30 days;
- since the most recent major risk-control PR wave.

Use the best available data from:

- `decision_log`;
- `risk_events`;
- stage-matrix records;
- signal tables;
- order-intent records;
- order ledger;
- pending orders;
- trades;
- controller state;
- action log;
- broker execution history where available.

Produce:

```text
symbols considered
→ symbols with usable data
→ strategy computations completed
→ setups detected
→ setups eligible under matrices
→ risk gate reached
→ risk approved
→ order intent written
→ execution attempted
→ broker accepted
→ position opened
→ position remained open beyond initial noise period
→ position closed by thesis outcome
```

For each gate calculate:

- count reaching the gate;
- count passing;
- count rejected;
- rejection percentage;
- percentage of all rejected opportunities attributable to the gate;
- whether another gate would have rejected the same opportunity;
- first blocking reason;
- all applicable blocking reasons;
- number of candidates lost only because of this gate.

Distinguish clearly:

```text
no setup
strategy disabled
symbol disabled
timeframe not armed
matrix not armed
market closed
insufficient data
stale data
calculation failure
risk veto
duplicate veto
cooldown veto
exposure veto
sizing failure
order rejection
ambiguous execution
silent drop
```

Do not allow all of these to collapse into “no trade”.

---

## 7. Marginal Veto Analysis

The key question is not merely how often a gate vetoes.

The key question is:

> **How many trades did this gate uniquely prevent, after accounting for every other gate?**

For each control, calculate:

```text
gross veto count
unique veto count
overlapping veto count
next gate that would have vetoed
marginal reduction in trade count
marginal change in expected loss
marginal change in drawdown
marginal change in profit factor
marginal change in expectancy
```

A gate that records 1,000 vetoes may have little actual effect if another gate would reject all the same candidates.

A gate that records 20 vetoes may have a large effect if it uniquely blocks the system’s best opportunities.

Rank gates by **marginal behavioural effect**, not by log volume.

---

## 8. Defensive Accumulation Audit

Review the PR and commit history for every control added or tightened during the recent development period.

For each change record:

| PR/commit | Control changed | Previous behaviour | Current behaviour | Reason at the time | Present cumulative effect |
|---|---|---|---|---|---|

Inspect especially:

- stricter strategy arming;
- strategy disarming;
- stage-matrix exclusions;
- closed-market restrictions;
- spread, margin and exposure rules;
- minimum R:R;
- Kelly or expectancy vetoes;
- cooldowns;
- same-symbol restrictions;
- duplicate prevention;
- position caps;
- volatility or regime gates;
- multi-account safeguards;
- profit keeper;
- spike tightening;
- time caps;
- loss caps;
- equity stop;
- adaptive breaker;
- performance breaker;
- goal tracker;
- post-decision auditor;
- C++ order guards;
- C++ trailing-stop behaviour.

Do not assess each PR only against the defect that prompted it.

Assess the current cumulative stack.

Look for this pattern:

```text
PR A solves one incident by adding a gate
PR B solves another incident by tightening the same path
PR C adds a second control for the same risk
PR D adds a fail-closed fallback
PR E adds an auto-disarm or narrower matrix
Result: no single PR is unreasonable, but the aggregate system seldom trades
```

Classify each accumulated control as:

```text
still necessary
necessary but duplicated
necessary but too broad
necessary but too strict
necessary only for live accounts
necessary only for certain instruments
reporting-only
obsolete after a later architectural repair
unproven
```

---

# PART III - C++ EXECUTION AND TRADE-MANAGEMENT AUDIT

## 9. Full C++ Capability Map

Inspect the complete `cpp-exec` implementation, including at minimum:

- execution engine;
- request-response correlation;
- account authentication;
- account roster;
- order guard;
- order placement;
- amendment;
- close and partial close;
- cancellation;
- reconciliation;
- spot feed;
- stale-tick handling;
- TrailEngine;
- VPO dispatcher;
- backtesting;
- telemetry;
- health reporting;
- threading and locks;
- restart behaviour;
- Node fallback.

Create this table:

| Capability | Node implementation | C++ implementation | Active mode | Authority | Conflict risk |
|---|---|---|---|---|---|

Answer:

1. Which component decides policy?
2. Which component executes?
3. Which component records the result?
4. Which component reconciles broker truth?
5. Can Node and C++ act on the same position concurrently?
6. Can C++ continue using a stale policy after Node changes configuration?
7. Can a full-replacement configuration push temporarily remove protection?
8. Can a successful C++ action fail to reach Node persistence?
9. Can Node believe an amendment occurred when C++ or the broker rejected it?
10. Can C++ be healthy and authenticated while one or more accounts remain unauthorised?
11. Can C++ execution latency or serialisation cause intended actions to become stale?
12. Can one pending stop amendment delay another?
13. Does a failed stop amendment retry correctly, or is it silently discarded?
14. Is every order, amend and close explicitly stamped with its account?
15. Do C++ and Node use identical units, rounding, symbols, sides and volume conventions?

---

## 10. C++ TrailEngine Deep Audit

Trace:

```text
Node profit decision
→ trail specification
→ C++ configuration ingestion
→ account validation
→ symbol subscription
→ bid/ask tick
→ peak-price update
→ candidate stop
→ minimum improvement step
→ market-side validation
→ pending amendment
→ broker amendment
→ success or failure
→ status returned to Node
→ local and broker reconciliation
```

Examine:

- tick freshness;
- bid versus ask selection;
- direction handling;
- price digits;
- trail-distance units;
- peak preservation;
- current-stop knowledge;
- unknown current stop;
- stop-improvement threshold;
- frequency of amendments;
- broker minimum-distance rules;
- failed amendments;
- multiple pending positions;
- lock contention;
- process restart;
- full-replacement configuration;
- account-stamp enforcement;
- Node and C++ stop ownership.

Determine whether the TrailEngine is:

```text
inactive
appropriately active
too slow
too aggressive
duplicating Node
conflicting with Node
losing coverage silently
```

Measure, where data permits:

- ticks received per tracked symbol;
- trail specifications expected;
- trail specifications accepted;
- specifications dropped;
- amendments attempted;
- amendments accepted;
- amendments rejected;
- median time between amendments;
- average stop improvement;
- amendments per position-hour;
- broker-rejection reasons;
- positions believed protected but not represented in C++ status.

---

## 11. VPO and C++ Entry Logic

Inspect whether the C++ VPO path:

- uses current and sufficiently fresh market data;
- applies the intended strategy and timeframe;
- produces the same decision as the Node equivalent;
- uses the same stop, target, sizing and account;
- reports every arm, rejection, fill and failure;
- can create an order outside the normal Node veto funnel;
- can be disabled by a safety control without an observable reason;
- can remain armed after Node state changes;
- can become too restrictive through its own guards;
- can duplicate an entry already being considered by Node.

Run parity tests using identical frozen inputs.

Do not accept “conceptually equivalent” as parity.

Compare exact:

```text
entry
stop loss
take profit
volume
direction
time cap
risk amount
rejection reason
```

---

# PART IV - PROFIT-KEEPING AND STOP-LOSS REACTION AUDIT

## 12. Identify Every Stop-Loss Authority

Build a complete stop-loss ownership and reaction matrix.

Include:

- initial strategy stop;
- risk-gate stop validation;
- broker-side stop attached at entry;
- Node profit keeper;
- C++ TrailEngine;
- spike tightening;
- fixed-dollar giveback;
- break-even movement;
- trade guard;
- LLM or position-monitor recommendation;
- restrategising after manual reversal;
- owner/manual stop movement;
- time-cap closure;
- per-position loss cap;
- equity stop;
- weekend or gap protection;
- reconciliation after broker-side stop execution.

For each authority record:

| Authority | Trigger | Action | Can tighten? | Can widen? | Can close? | Cadence | Broker acknowledgement |
|---|---|---|---|---|---|---|---|

Then establish the precedence and conflict rules.

Look for:

- two components racing to amend one stop;
- a slower component overwriting a tighter stop;
- stale local `current_sl`;
- a stop considered moved before broker acknowledgement;
- a stop moved without durable position-event evidence;
- a broker rejection treated as temporary without sufficient escalation;
- a manual owner stop being overwritten;
- a stop tightened according to a timeframe shorter than the strategy thesis;
- a profit stop reacting to ordinary spread or volatility noise;
- a stop that protects nominal dollars but destroys expected payoff.

---

## 13. Initial Stop-Loss Integrity

For every entry path prove:

1. An initial stop is defined.
2. Its units and direction are correct.
3. It is within broker constraints.
4. It is included in the broker order or immediately amended.
5. Broker acknowledgement is captured.
6. Failure does not leave a position silently naked.
7. Account identity is correct.
8. The persisted stop matches broker truth.
9. Reconciliation repairs any mismatch.
10. The UI displays broker truth rather than intended state.

Separate:

```text
intended stop
submitted stop
broker-accepted stop
locally recorded stop
currently reconciled stop
```

These are not interchangeable.

---

## 14. Stop-Reaction Timing

For each closed position reconstruct:

```text
entry time
initial stop
initial risk distance
maximum adverse excursion
maximum favourable excursion
first profit-keeper arm
first break-even movement
each Node stop amendment
each C++ stop amendment
each rejected amendment
scale-out time
final stop
exit time
exit reason
price after exit over the next strategy-relevant horizon
```

Calculate:

- time from entry to first stop tightening;
- stop distance as a fraction of ATR;
- stop distance as a fraction of original risk;
- time to break-even;
- percentage of trades moved to break-even before reaching 1R;
- percentage stopped before the setup’s expected holding horizon;
- percentage stopped by spread or ordinary volatility;
- percentage of winners converted into small wins;
- percentage of potential winners converted into scratches or losses;
- percentage of protected profit subsequently given back;
- post-exit favourable movement.

Do not judge a stop merely because price later moved favourably. Use a consistent counterfactual horizon and account for the possibility that the original thesis was already invalid.

---

## 15. Profit Keeper Deep Audit

Inspect the complete profit-keeper policy and runtime configuration.

Examine:

- enabled state;
- account scope;
- external/manual versus bot scope;
- adaptive versus fixed mode;
- ATR timeframe;
- ATR period;
- ATR arming multiplier;
- balance-percentage floor;
- normal trailing multiplier;
- spike detection;
- spike lookback;
- spike threshold;
- spike trailing multiplier;
- fixed-dollar arming;
- giveback percentage;
- hard take-profit amount;
- scale-out fraction;
- peak-profit persistence;
- restart behaviour;
- cross-currency handling;
- missing ATR;
- missing price;
- missing balance;
- missing stop;
- missing account;
- failed broker amendment;
- failed close;
- partial-close volume;
- C++ trail push and readback.

Determine whether any fallback is more aggressive than normal mode.

In particular, test whether:

```text
ATR unavailable
→ fixed-dollar mode
→ earlier arming or tighter protection
```

This could make degraded data produce more aggressive trade management rather than merely reduced functionality.

Do not assume it does - calculate it across actual instruments and balances.

---

## 16. Does the Profit Keeper Keep Profit or Truncate It?

Measure performance under these historical counterfactuals:

### Policy A - Current behaviour

Current Node keeper and current C++ trail.

### Policy B - Node only

Disable the C++ tick trail in replay, retaining Node decisions.

### Policy C - C++ only after Node arms

Node establishes policy, but only C++ performs intermediate stop ratchets.

### Policy D - No spike tightening

Use the normal trail during spike conditions.

### Policy E - Wider trail

Use a modestly wider ATR trail without changing initial risk.

### Policy F - Later arming

Require more favourable movement before profit protection begins.

### Policy G - No profit keeper

Retain only the original strategy stop and target.

### Policy H - Partial profit plus wider runner

Bank a defined fraction, then allow the remainder more room.

This is historical replay only. Do not alter production.

For each policy calculate:

- number of trades;
- win rate;
- average win;
- average loss;
- payoff ratio;
- profit factor;
- expectancy;
- total P&L;
- maximum drawdown;
- average holding time;
- MFE captured;
- MAE;
- stop-out rate;
- scratch rate;
- small-win rate;
- large-winner rate;
- tail-loss rate;
- risk of ruin estimate;
- return divided by maximum drawdown.

The keeper is beneficial only if the reduction in adverse outcomes is proportionate to the reduction in favourable payoff.

---

## 17. Detect Profit-Protection Paradoxes

Test for these patterns:

### Win-rate inflation

Tighter stops produce many small wins but reduce average win enough to lower profit factor and expectancy.

### Break-even addiction

Stops are moved to entry so early that normal market noise removes otherwise valid positions.

### Spike overreaction

A short-lived large bar triggers a very tight trail despite the strategy expecting continued momentum.

### Double tightening

Node and C++ independently tighten the same stop, producing a much smaller effective trail than either policy intended.

### Profit-floor distortion

A balance-based or dollar-based floor affects small and large accounts differently from the intended ATR policy.

### Degraded-data aggression

Missing ATR or incomplete data causes a fixed fallback that is tighter than the normal policy.

### Runner starvation

Scale-out or trailing preserves small gains but eliminates the large winners needed to sustain profit factor.

### Thesis-horizon mismatch

A position selected from a 1-hour or 4-hour setup is managed according to short-term ticks without preserving the original timeframe’s expected movement.

---

# PART V - PROFIT FACTOR, WIN RATE AND GOAL COHERENCE

## 18. Identify Every Performance Threshold

Create a single register containing all thresholds relating to:

- go-live readiness;
- strategy arming;
- strategy disarming;
- backtest verdict;
- seed-strategy activation;
- performance breaker;
- adaptive breaker;
- profit keeper;
- minimum R:R;
- positive expectancy or Kelly;
- maximum drawdown;
- minimum sample;
- deadline;
- trade-frequency target.

For each threshold record:

| Threshold | Value | Scope | AND/OR relationship | Automatic action | Configurable | Current runtime value |
|---|---:|---|---|---|---|---|

Do not rely only on source defaults. Read stored runtime configuration where available.

---

## 19. Goal-Coherence Analysis

Verify the present relationship among:

```text
go-live profit-factor target
go-live win-rate display or gate
strategy-arm profit-factor threshold
strategy-arm win-rate threshold
strategy-arm minimum sample
breaker threshold
breaker automatic action
strategy-specific seed threshold
```

Answer:

1. Is the go-live gate based on profit factor, win rate or both?
2. Does the UI describe the same effective gate?
3. Does strategy arming require both profit factor and win rate?
4. Is the arming gate stricter than the actual go-live gate?
5. Does the arming gate prevent the system from collecting enough trades to reach its required sample?
6. Is the system caught in a circular rule?

```text
not enough trades to prove the strategy
→ strategy not armed
→ strategy cannot produce trades
→ sample never grows
→ strategy remains unproven
```

7. Is a high win-rate requirement penalising valid low-win-rate, high-payoff strategies?
8. Is profit factor being measured over a sample large enough for the decision?
9. Is the deadline encouraging excessive trading or, conversely, made unreachable by restrictive gates?
10. Are portfolio targets being incorrectly imposed on every individual strategy and symbol?
11. Are live results, backtest results and burn-in results being mixed?
12. Are NULL, unattributed or incomplete trades distorting the targets?

---

## 20. Profit Factor and Win Rate Must Be Analysed Together

Use:

```text
Profit Factor
= (Win Rate × Average Win)
  ÷
  ((1 - Win Rate) × Average Loss)
```

Do not treat profit factor and win rate as independent virtues.

For each strategy, symbol, timeframe and account calculate:

- win rate;
- payoff ratio;
- implied profit factor;
- actual profit factor;
- expectancy;
- required break-even win rate;
- required win rate for the target profit factor;
- confidence interval;
- sample size;
- result sensitivity to one additional win or loss.

Test whether the present win-rate goal is compatible with the strategy’s natural payoff profile.

Examples of questions to answer:

- Could a 42% win-rate strategy with a 2.2 payoff ratio be more valuable than a 60% strategy with a 0.9 payoff ratio?
- Is the system rejecting the first merely because of a universal win-rate threshold?
- Is profit keeping reducing the payoff ratio and thereby increasing the win rate required to hit the same profit factor?
- Is stop tightening improving win rate while harming profit factor?

---

## 21. Statistical Caution Without Paralysis

Evaluate current minimum-trade rules using:

- sample-size sensitivity;
- confidence intervals;
- Bayesian or shrinkage estimates where appropriate;
- walk-forward consistency;
- regime consistency;
- concentration by symbol and timeframe;
- exposure to one or two outlier trades.

Do not replace one hard gate with an opaque statistical model.

Compare:

```text
hard pass/fail threshold
versus
graduated risk allocation based on evidence strength
```

Assess whether an uncertain but promising strategy could responsibly trade at reduced risk rather than being completely disarmed.

This is a policy option, not an automatic recommendation.

Label it:

```text
OWNER POLICY DECISION - CALCULATED-RISK ALLOCATION
```

---

# PART VI - COUNTERFACTUAL CALCULATED-RISK TEST

## 22. Replay the Decision Funnel

Using historical market data and recorded candidate signals, replay at least these policies:

### Current stack

Every present gate and trade-management rule.

### Previous stack

The material rules before the recent safety PR wave.

### Remove one gate at a time

Measure the marginal effect of each control.

### Relax one threshold at a time

Use the previous threshold or a clearly justified test value.

### Risk-tiered entry

Retain the setup but reduce position risk when confidence is weaker.

### Quality-only entry

Keep genuine strategy-quality checks but remove duplicated defensive vetoes.

### Capital-only defence

Retain hard capital and execution controls while excluding performance-preference gates.

Do not tune and evaluate on the same sample.

Use walk-forward or hold-out testing.

For each policy report:

- opportunities;
- trades;
- trade-frequency change;
- risk per trade;
- total risk deployed;
- risk-budget utilisation;
- P&L;
- profit factor;
- win rate;
- payoff;
- expectancy;
- maximum drawdown;
- worst day;
- worst streak;
- tail loss;
- time in market;
- average number of concurrent positions;
- risk of ruin;
- percentage of available capital risk budget actually used.

---

## 23. Risk-Budget Utilisation

Calculate whether the system is using the risk budget the owner has authorised.

For each account and period report:

```text
allowed daily risk
actual risk deployed
unused risk capacity
number of qualifying opportunities
number blocked
capital idle percentage
time with autotrade enabled but no eligible combinations
time with every strategy or matrix effectively disabled
```

A system may remain inside every limit because it is well controlled.

It may also remain inside every limit because it has stopped taking meaningful risk.

Distinguish these cases.

---

## 24. Opportunity-Cost Register

For uniquely blocked opportunities, calculate:

- expected value at the time;
- realised hypothetical outcome under unchanged entry, stop and target;
- maximum adverse excursion;
- maximum favourable excursion;
- whether the original stop would have survived;
- whether the current profit keeper would have exited;
- which gate blocked it;
- whether the gate’s stated risk actually materialised.

Do not use this as hindsight optimisation.

Report aggregates and stable patterns, not merely memorable missed winners.

---

# PART VII - FINDINGS AND VERDICTS

## 25. Required Finding Types

Use stable IDs:

```text
F-CPP-xx     C++ execution or trailing
F-VETO-xx    entry suppression
F-SL-xx      stop-loss reaction
F-PK-xx      profit keeper
F-GOAL-xx    goal coherence
F-PF-xx      profit-factor or payoff distortion
F-DATA-xx    evidence or accounting
F-OBS-xx     silent or misleading health
F-POLICY-xx  owner decision rather than defect
```

Every finding must include:

| Field | Requirement |
|---|---|
| ID | Stable finding ID |
| Title | Precise statement |
| Classification | Defect, over-defence, under-defence, policy conflict or evidence gap |
| Severity | Capital, high, medium or low |
| Confidence | High, medium or low |
| Scope | Strategy, account, symbol, runtime and mode |
| Trigger | Exact condition |
| Current consequence | What occurs now |
| Opportunity consequence | What valid trading may be lost |
| Risk benefit | What harm the control prevents |
| Net judgement | Proportionate, duplicated, too broad, too strict or unknown |
| Evidence | Files, functions, lines, logs and data |
| Marginal effect | Unique contribution after overlapping controls |
| Minimum remedy | Smallest change |
| Regression test | Required test |
| Runtime validation | Required observation |
| Policy decision | Whether owner approval is required |

---

## 26. Over-Defence Finding Standard

Do not label a control “over-defensive” merely because it vetoes many trades.

A confirmed over-defence finding requires:

1. the control uniquely blocks or prematurely exits a material set of trades;
2. those trades have positive or plausibly positive out-of-sample expectancy;
3. the control’s removal or relaxation does not create disproportionate drawdown or tail risk;
4. the behaviour is not required by an explicit owner policy;
5. the effect persists beyond a small or cherry-picked sample.

Use:

```text
CONFIRMED OVER-DEFENCE
CONDITIONAL OVER-DEFENCE
NOT ESTABLISHED
```

---

## 27. Required Final Report

Return the audit in this order.

### 1. Executive Verdict

Answer directly:

```text
Has bot-trade become too reluctant to trade?
Has it become too quick to protect small profits?
Are the C++ and Node stop mechanisms coherent?
Are profit-factor and win-rate goals coherent?
Which three controls have the largest marginal effect?
```

### 2. Trading-Posture Classification

Choose:

```text
under-defended
proportionate
over-defended
mixed by subsystem
not evidenced
```

### 3. Current Architecture and Authority Map

Show Node, C++, broker, SQLite and UI ownership.

### 4. Entry Veto Funnel

Counts, rates, unique blockers and overlapping blockers.

### 5. C++ Execution Audit

Orders, accounts, retries, reconciliation, VPO, telemetry and restart behaviour.

### 6. C++ TrailEngine Audit

Coverage, cadence, amendments, failures, Node overlap and stop behaviour.

### 7. Stop-Loss Reaction Matrix

Every component that can create, tighten, widen, close or reinterpret a stop.

### 8. Profit-Keeper Effectiveness

Whether it retains profit, truncates winners or behaves differently under degraded data.

### 9. Goal-Coherence Report

Profit factor, win rate, payoff, arming thresholds, minimum sample and deadline.

### 10. Counterfactual Results

Current stack versus alternative bounded-risk policies.

### 11. Defensive-Accumulation Register

PR-by-PR development and cumulative effect.

### 12. Confirmed Findings

Rank by capital consequence and marginal behavioural effect.

### 13. Owner Policy Decisions

Separate from technical defects.

### 14. Minimum Remediation Sequence

Use these waves:

```text
Wave 0 - Correct broker, account or stop-loss safety defects
Wave 1 - Restore accurate measurement and attribution
Wave 2 - Remove duplicated or obsolete vetoes
Wave 3 - Rebalance overly strict entry controls
Wave 4 - Rebalance profit-keeping and stop reactions
Wave 5 - Optional graduated calculated-risk allocation
```

### 15. Runtime Data Requests

Provide exact SQL, API calls, logs or exports needed to close evidence gaps.

### 16. Audit Completeness Statement

State exactly what was and was not verified.

---

# PART VIII - IMPLEMENTATION RESTRAINT

## 28. Do Not Implement During This Audit

Do not:

- alter risk percentages;
- loosen stops;
- disable the profit keeper;
- switch off C++ trailing;
- change win-rate or profit-factor targets;
- arm more strategies;
- widen matrices;
- enable live trading;
- merge code;
- create a pull request.

First present the evidence and proposed sequence.

Any later implementation must use:

- one concern per PR;
- feature flag or configuration rollback where practical;
- no live-account activation by default;
- replay evidence before deployment;
- demo or burn-in validation;
- broker-truth verification after deployment;
- explicit rollback criteria.

---

## 29. Final Audit Principle

Do not optimise the system to avoid losing trades.

A viable trading system must be allowed to lose within its calculated risk budget.

The correct questions are:

```text
Was the trade valid when entered?
Was the risk known and bounded?
Was the position protected at the broker?
Was the expected payoff sufficient?
Was the trade allowed enough room and time for its thesis?
Did a control improve portfolio survival or merely reduce activity?
Did profit protection preserve expectancy or only make the record look safer?
```

A system that never risks capital cannot suffer a trading loss.

It also cannot demonstrate or realise a trading edge.

Find the evidence-based boundary between prudent defence and fear-driven inactivity.
