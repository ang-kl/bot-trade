# Bot-Trade Algorithmic Decision Integrity, Economic Edge and Trade-Lifecycle Engineering Prompt v1.0

**Repository:** `https://github.com/ang-kl/bot-trade`  
**Target branch:** `main`  
**Mode:** `AUDIT-FIRST · READ-ONLY RUNTIME · OFFLINE/DEMO TESTING · EVIDENCE-PRESERVING`  
**Primary output:** a reproducible engineering audit, executable test pack, measured findings ledger and rollback-safe remediation sequence.  
**Primary question:** Does the current system preserve a genuine, net-positive trading edge while keeping risk bounded, or do data noise, pipeline suppression, control overlap, timing defects and premature trade management distort the strategies before their economic hypotheses can play out?

## 1. Operating instruction

Act as an independent senior team combining these competencies:

- quantitative trading research;
- market microstructure and execution;
- Node.js asynchronous systems;
- C++ execution and concurrency;
- cTrader Open API integration;
- statistical validation and backtesting;
- risk-of-ruin and capital-preservation analysis;
- database lineage, accounting and reconciliation;
- production reliability and security;
- human-in-the-loop chart review.

Do not stop after proposing a plan. Inspect the current repository, execute the safe commands, create the evidence and deliverables, add missing tests or read-only audit tooling where necessary, and report what is proved, disproved and still unknown.

Treat all existing documents, comments, prior audit prompts and commit messages as hypotheses or historical context. The current source, current configuration, current durable data and broker-confirmed evidence are authoritative. When they disagree, record the disagreement.

Use one frozen commit SHA for every conclusion. Never combine evidence from different SHAs without explicitly comparing them.

## 2. Safety and authority boundaries

**NO LIVE TRADING ACTIONS.**

You may:

- read all source, tests, documentation, commit history and read-only runtime state;
- run unit, integration, parity, replay, backtest and static-analysis tests offline or against demo infrastructure;
- create a dedicated audit branch;
- add tests, deterministic fixtures, read-only scripts, documentation and observability that cannot place, amend, cancel or close an order;
- fix a confirmed correctness defect only when the fix is minimal, regression-tested, behaviourally bounded and does not alter owner risk policy.

You must not:

- arm or disarm live autotrade;
- place, amend, cancel or close a live order;
- run any parity command that deliberately places an order, including `exec-parity.js --order`;
- run `node agent/scripts/exec-parity.js --order` under any account mode;
- change broker credentials, selected accounts, account modes or production environment variables;
- change strategy thresholds, risk percentages, position caps, stop distances, profit targets, arming policy or management policy merely to improve a backtest;
- use an LLM or image model in the live deterministic trade path;
- claim profitability from in-sample results;
- treat missing data as zero, false, healthy or passed;
- merge to `main`.

Label every proposed behavioural or risk-policy change:

`OWNER POLICY DECISION - NOT A CORRECTNESS FIX`

If repository access permits, prepare a draft PR. Do not merge it.

## 3. Decision standard

Assess the system under three independent verdicts.

### 3.1 Economic character

Classify each operation as one of:

- `INVESTMENT`;
- `BOUNDED SPECULATION`;
- `UNBOUNDED SPECULATION`;
- `UNCLASSIFIED - INSUFFICIENT EVIDENCE`.

Apply Benjamin Graham's three-part test literally:

1. **Thorough analysis** - the decision rests on sufficient, relevant and verified evidence.
2. **Safety of principal** - the operation has a defensible margin of safety or a bounded survival framework.
3. **Adequate return** - expected return remains satisfactory after spread, commission, slippage, swap, financing, failed fills, latency and uncertainty.

Do not call an operation an investment because its underlying instrument is a stock. A short-horizon equity or equity-CFD trade based only on price patterns remains speculation unless the system actually ingests and tests fundamental valuation, balance-sheet strength and margin of safety.

FX, indices, commodities and leveraged CFDs normally lack Graham-style intrinsic value in this repository. Classify them as speculation unless a genuine long-horizon valuation model is present and validated. In leveraged trading, “safety of principal” cannot mean a promise against loss; test whether losses are bounded sufficiently for survival.

### 3.2 Defence posture

Classify each subsystem and the whole stack as:

- `UNDER-DEFENDED`;
- `PROPORTIONATELY DEFENDED`;
- `OVER-DEFENDED`;
- `MIXED`;
- `UNPROVEN`.

### 3.3 Edge status

Classify each strategy and the portfolio as:

- `EDGE PROVEN OUT-OF-SAMPLE`;
- `EDGE PROVISIONAL`;
- `EDGE UNPROVEN`;
- `EDGE NEGATIVE`;
- `UNMEASURABLE DUE TO DATA DEFECT`.

Use confidence intervals and sample sufficiency, not point estimates alone.

## 4. Repository-specific hypotheses to test - not assumed findings

Treat these as investigation leads. Confirm or reject each against current HEAD.

- **H01 - Source-of-truth drift:** strategy counts, defaults, controller descriptions or test instructions in documentation may lag current code.
- **H02 - Silent strategy death:** defensive dynamic imports may convert a missing or broken strategy module into a compute function that always returns `null`, leaving the process healthy while the strategy is structurally dead.
- **H03 - Live/backtest mismatch:** bar depth, warm-up, timeframe window, default parameters, R:R floors, entry mode or cost assumptions may differ between live scanning and backtesting.
- **H04 - Strategy starvation:** scarce analyse slots, saturated conviction scores, symbol-level winner selection or dispatch logic may prevent armed strategies from reaching the risk gate.
- **H05 - Wrong unit of analysis:** evaluations, signals, opportunities, orders, fills, positions and trades may be counted as though they were interchangeable.
- **H06 - Cross-account contamination:** state, positions, pending orders, vetoes, risk, arming, reconciliation or performance may be read or written under the wrong account scope.
- **H07 - Diagnostic drift:** a diagnostic, funnel or trace may use a wider history window, looser rules or different data than the production path it claims to mirror.
- **H08 - Unenforced write authority:** several Node and C++ components may amend or close the same position without a pre-action arbiter.
- **H09 - Wrong trigger clock:** a price-crossing rule may wait on a poll, while a closed-bar rule may be evaluated on a partial candle.
- **H10 - Detached stale work:** a timed-out loop subphase may continue after the loop has moved on and act using state that is no longer current.
- **H11 - Node/C++ semantic drift:** units, rounding, side selection, gap handling, same-bar exit priority, account stamps, retry semantics or backtest results may diverge.
- **H12 - P&L lineage defects:** entry, exit, deal, commission, account, strategy or risk-approval lineage may be missing or internally contradictory.
- **H13 - Pending-order lifecycle gaps:** place, acknowledge, persist, invalidate, expire, cancel, fill, adopt and reconcile may race or lose provenance.
- **H14 - Defensive drift and winner truncation:** individually reasonable vetoes, break-even moves, ratchets, time caps and scale-outs may cumulatively destroy expectancy.
- **H15 - Awareness overreach:** market-pulse or visual-awareness concepts may be useful but unvalidated; advisory information must not silently become an entry veto or exit rule.
- **H16 - Capital fragility:** configured per-trade risk, concurrent positions, correlation and gap/slippage exposure may imply an unacceptable probability of ruin even when each individual trade passes the gate.
- **H17 - Noise sensitivity:** small perturbations in bars, spread, time boundaries or thresholds may cause unstable signals, frequent flips or arbitrary winner selection.
- **H18 - Failure-path dishonesty:** a skipped, timed-out, unavailable or exception-swallowed component may be displayed or counted as idle, no setup, healthy or passed.

## 5. Freeze and reproduce the baseline

Create an audit branch named similar to:

`audit/algo-integrity-YYYYMMDD`

Record, without exposing secrets:

```bash
git status --short
git branch --show-current
git rev-parse HEAD
git log -100 --date=iso --pretty=format:'%h | %ad | %s'
git diff --stat
git ls-files
node --version
npm --version
```

Inspect at minimum:

- `README.md`;
- `package.json`;
- `agent/loop.js`;
- `agent/services/strategies.js`;
- every strategy module and its tests;
- `agent/services/risk.js`;
- scan, selection, fair-share, stage-matrix and opportunity-identity modules;
- pending-order, reconciler and broker-execution paths;
- guardian, fast monitor, trade guard, profit keeper, loss cap, loss guardian, profit ratchet, weekend bank, restrategize and minute review;
- `agent/services/management-state.js`;
- `agent/lib/exec-engine.js`;
- `cpp-exec/`, including TrailEngine, backtest, telemetry, threading, HTTP and broker session handling;
- database schema and migrations;
- performance, consistency, opportunity and controller-health reports;
- recent audit documents and the latest 100 commits affecting trading behaviour.

Run the repository’s existing safe gates. Adapt shell globbing to the environment, but do not weaken a gate:

```bash
npm ci
npm test
bash -lc 'shopt -s globstar; node --test agent/**/*.test.js'
npm run lint
npm run build
npm run check:no-green

cd cpp-exec
make clean
make test
make
cd ..

node agent/scripts/backtest-parity.mjs
node agent/scripts/exec-parity.js
```

The last command must remain read-only. Do not run `node agent/scripts/exec-parity.js --order`.

Record exact command, exit code, duration, stdout and stderr. A failed baseline test is evidence; do not repair it silently before preserving the failure.

If a command cannot run because data, credentials, network, compiler or infrastructure is unavailable:

1. record the precise blocker;
2. continue every static, synthetic and offline test that remains possible;
3. create the exact read-only query or command required to complete the missing test;
4. do not invent a result.

## 6. Build the canonical executable system map

Trace the actual path, not the intended architecture:

```text
broker/account eligibility
→ symbol and market-hours eligibility
→ tick/trendbar acquisition
→ data validation and bar closure
→ strategy computation
→ candidate collection
→ per-strategy and per-symbol selection
→ analyse-slot allocation
→ stage-matrix and arming gates
→ regime, awareness and volatility context
→ deterministic risk evaluation and sizing
→ opportunity identity and decision persistence
→ order intent
→ Node or C++ execution
→ broker acknowledgement
→ order/fill persistence
→ position protection verification
→ tick/bar/poll management
→ amendment or close acknowledgement
→ reconciliation
→ deal/P&L backfill
→ realised performance and strategy governance
```

For every stage document:

- source file and function;
- trigger source - tick, closed bar, timer, owner, broker event or restart;
- exact input schema and unit;
- account, symbol, strategy and timeframe scope;
- output and possible dispositions;
- persistent tables or state keys;
- retry, timeout and deduplication behaviour;
- fail-open, fail-closed or fail-unknown behaviour;
- broker acknowledgement requirement;
- downstream consumer;
- observable evidence;
- test coverage;
- known fallback path.

Produce:

1. a Mermaid end-to-end decision graph;
2. a separate lifecycle sequence diagram for market orders;
3. a separate lifecycle sequence diagram for pending orders;
4. a separate position-management authority diagram;
5. `machine/decision-stages.json`, containing the same stages in machine-readable form.

Every graph must distinguish:

`signal` ≠ `evaluation` ≠ `opportunity` ≠ `approval` ≠ `order intent` ≠ `broker order` ≠ `fill` ≠ `position` ≠ `closed trade`.

## 7. Inventory and test all 12 strategies

Resolve the strategy list from the current registry. At the reference snapshot it includes:

1. `fib_618_fade`;
2. `cup_handle`;
3. `inv_cup_handle`;
4. `ema_pullback`;
5. `donchian_breakout`;
6. `rsi_meanrev`;
7. `vwap_trend`;
8. `vp_value`;
9. `rsi2_reversion`;
10. `fib_confluence`;
11. `va_breakout`;
12. `fvg_retrace`.

If current HEAD differs, use current HEAD and record the difference.

Create one dossier per strategy containing:

- economic hypothesis in plain language;
- trend, breakout, mean-reversion, value-area, pattern or hybrid classification;
- expected holding horizon;
- suitable and unsuitable market regimes;
- required bars and warm-up;
- exact indicator formulae and parameters;
- entry condition;
- stop-loss construction;
- TP1, TP2, scale-out and time-cap construction;
- live R:R floor and any strategy override;
- live default state and stage-matrix dependencies;
- pending-order capability;
- live scan path;
- backtest path and engine;
- management rules expected after fill;
- data dependencies and failure behaviour;
- known structural inability to signal;
- sample size and evidence of edge;
- top three falsification tests.

Independently verify the mathematics for:

- ATR, RSI, SMA, EMA, Donchian boundaries;
- VWAP and volume-profile calculations;
- Fibonacci levels and confluence;
- fair-value-gap detection;
- R:R and target-side validity;
- time-cap conversion;
- conviction scores;
- Kelly or expectancy scaling;
- position sizing and lot conversions;
- FX conversion, notional, margin and P&L;
- correlation and cluster exposure;
- market-pulse efficiency, sigma, pin and traverse measures.

Do not merely compare a function with itself. Create an independent reference calculation or a hand-verifiable fixture.

### 7.1 Mandatory strategy invariants

For every strategy, add or run deterministic tests for:

- insufficient history;
- exactly the minimum history;
- flat prices;
- monotonic rise and fall;
- zero-range bars;
- gaps through entry, stop and target;
- large wicks;
- duplicated bars;
- out-of-order timestamps;
- missing intervals;
- `null`, `NaN`, infinity and zero volume where relevant;
- impossible OHLC ordering;
- price-scale changes;
- tick-size and rounding boundaries;
- long/short symmetry where the thesis is intended to be symmetric;
- no signal on a partial bar when the rule requires a closed bar;
- future-bar invariance - appending future bars must not change a decision made at time `t`;
- no look-ahead through swing confirmation, volume profile, pattern completion or target construction;
- registry `minBars` parity with module requirements;
- live scanner window parity with the strategy’s declared requirement;
- live and backtest parameter parity;
- stable strategy label and provenance.

Use seeded deterministic fuzz/property tests where useful. Do not add a large dependency merely for fuzzing.

### 7.2 Signal stability and noise tests

For each strategy measure:

- signal rate by symbol, timeframe and regime;
- signal persistence across consecutive scans;
- flip rate;
- sensitivity to one-tick, one-spread and one-bar perturbations;
- sensitivity to ±5% and ±10% parameter changes;
- threshold-cliff behaviour;
- conviction distribution and saturation;
- duplicate or highly correlated signals across strategies;
- performance after small execution delays;
- whether “no signal” means no setup, insufficient data, disabled module, failed compute or lost selection.

Run placebo comparisons:

- randomized entry times with identical exit/risk rules;
- time-matched simple trend or mean-reversion baselines;
- shuffled signal labels where statistically legitimate;
- strategy with the same trade frequency but no strategy information.

A strategy that cannot beat a sensible placebo after costs does not have a demonstrated edge.

## 8. Audit market-data quality and noisy inputs

Inventory every source and transformation:

- bid, ask, mid and last-price use;
- tick stream and stale-tick detection;
- trendbar source and closure semantics;
- timeframe alignment and timezone;
- market sessions and holidays;
- spread;
- volume semantics;
- missing and duplicate bars;
- zero prices or malformed bars;
- symbol digits, tick sizes and contract sizes;
- currency conversion rates and freshness;
- commission, swap and financing;
- news calendar;
- correlation matrix;
- market-pulse state;
- corporate actions, symbol changes and contract rollover where applicable.

Determine whether noise or bad data can:

- create a false signal;
- suppress a true signal;
- alter strategy ranking;
- make R:R appear valid when spread makes it invalid;
- trigger a stop or synthetic close from a stale or outlier tick;
- classify an unfinished candle as a completed event;
- make a quiet market appear defended or choppy;
- make repeated evaluations appear to be many opportunities;
- make unknown P&L appear as zero;
- make a diagnostic report more permissive than production.

Create a data-quality scorecard with:

- defect;
- detection rule;
- affected strategies and controls;
- observed frequency;
- economic effect;
- fail-open/closed behaviour;
- remediation;
- regression test.

No new noise filter may be recommended solely because it improves in-sample performance. Show its marginal value out-of-sample and its opportunity cost.

## 9. Validate the backtest and replay engines

Map every backtest path by strategy. Do not assume that because a C++ backtester exists, all strategies use it.

For each engine and strategy verify:

- source bars and chronology;
- warm-up;
- signal evaluation point;
- entry timing - close, next open, touch or limit;
- bid/ask and spread treatment;
- commission;
- slippage;
- swap and financing;
- gap fills;
- same-bar SL/TP ambiguity;
- stop-before-target or target-before-stop rule;
- partial fills and scale-outs;
- time caps;
- cooldowns;
- concurrent positions;
- account and symbol caps;
- currency conversion;
- rounding and tick size;
- strategy and management configuration;
- result persistence;
- fallback path.

For same-bar SL/TP events, report an ambiguity band unless tick data proves the order. At minimum calculate both pessimistic and optimistic outcomes.

Run and preserve:

- JS/C++ parity for every function implemented in both languages;
- trade-sequence parity, not only aggregate statistics;
- exact integer parity and defined floating tolerance;
- deterministic replay from the same snapshot;
- walk-forward testing;
- purged or embargoed time-series validation where overlapping labels exist;
- out-of-sample testing by time;
- holdout symbols where enough data exists;
- regime-separated testing;
- block bootstrap confidence intervals;
- Monte Carlo resampling of trade sequences;
- cost stress at 1x, 1.5x, 2x and adverse-gap scenarios;
- parameter-stability surfaces, not one best point.

Report at minimum:

- trades and unique opportunities;
- win rate;
- average win, average loss and payoff ratio;
- expectancy in R and account currency;
- profit factor;
- maximum drawdown;
- drawdown duration;
- time in market;
- turnover;
- gross and net P&L;
- spread, commission, slippage and swap drag;
- MAE and MFE;
- tail loss and CVaR where sample size permits;
- longest loss streak;
- risk of ruin;
- confidence interval;
- in-sample versus out-of-sample degradation.

Do not aggregate across strategies, symbols or asset classes until the disaggregated results are shown.

## 10. Reconstruct the opportunity and veto funnel

Use a unique opportunity identity. Never calculate conversion rates by subtracting counts expressed in different units.

For each account, strategy, symbol, side and timeframe reconstruct:

```text
market observation
→ setup
→ unique opportunity
→ strategy selected
→ analyse slot received
→ all pre-risk gates
→ risk evaluation
→ approved or vetoed
→ order intent
→ execution attempt
→ broker acceptance
→ fill
→ protected position
→ managed position
→ closed and reconciled trade
```

For each opportunity preserve:

- first blocking reason;
- every applicable blocking reason;
- whether another gate would also have blocked it;
- exact source and configuration;
- whether the block prevented risk or merely duplicated another block;
- post-opportunity counterfactual outcome.

Calculate per gate:

- opportunities reached;
- gross veto count;
- unique veto count;
- overlapping veto count;
- marginal opportunities removed;
- risk avoided;
- positive opportunities missed;
- negative opportunities avoided;
- ambiguous outcomes;
- marginal change in expectancy, drawdown and risk of ruin.

### 10.1 Missed-signal taxonomy

Separate:

- strategy never computed;
- module failed or silently returned null;
- insufficient bars;
- setup absent;
- setup present but strategy disabled;
- matrix or account gate blocked;
- strategy starved of an analyse slot;
- another strategy won a symbol-level contest;
- risk veto;
- post-approval veto;
- order-intent loss;
- execution rejection;
- ambiguous submit;
- pending order expired or invalidated;
- fill not adopted;
- account-scoping loss;
- persistence or lineage failure.

### 10.2 Marginal veto and counterfactual method

For each vetoed or suppressed opportunity, replay the unchanged proposed entry, stop, targets and time cap from information available at that moment. Do not retune after seeing the outcome.

Classify:

- stop first;
- TP1 first;
- TP2 first;
- neither before time cap;
- same-bar ambiguous;
- unpriceable;
- data insufficient.

This is not a claim that every missed winner should have been traded. It measures opportunity cost alongside risk avoided.

## 11. Audit risk, safety of principal and risk of ruin

Trace the complete risk budget:

- balance/equity source;
- per-trade risk percentage and absolute override;
- hard caps;
- daily loss caps and pacing;
- equity stop;
- max open positions;
- per-symbol cap;
- currency and correlation exposure;
- leverage and margin;
- cooldowns;
- consecutive-loss handling;
- unknown P&L treatment;
- carry, commission, slippage and spread gates;
- Kelly/expectancy scaling;
- account-specific overrides;
- live versus demo differences.

Test:

- simultaneous stops across correlated positions;
- weekend gaps;
- spread explosion;
- stale FX conversion;
- unknown contract value;
- missing P&L;
- margin compression;
- broker rejection of protective stops;
- process restart during exposure;
- Node unavailable while C++ is running;
- C++ unavailable while Node is running;
- five-position worst case;
- correlated cluster worst case;
- 10, 20 and 30-trade loss sequences;
- strategy mix shifting toward one factor.

Use bootstrap/Monte Carlo and explicit assumptions to estimate:

- one-day and one-week loss distributions;
- probability of 10%, 20%, 30% and 50% drawdown;
- risk of ruin;
- time to recovery;
- sensitivity to per-trade risk;
- effect of concurrent correlated exposure.

Do not call a system “safe” because a stop exists in local state. Verify broker-side protection.

## 12. Audit trade management, exits and profit retention

Inventory every component that can set, amend, reduce or close a position. Include Node, C++, broker-native orders, owner actions and reconciliation.

For every writer record:

- rule;
- authority level;
- trigger clock;
- query scope;
- preconditions;
- action;
- broker acknowledgement;
- retry;
- idempotency;
- persistent event;
- possible conflict;
- current arbitration mechanism.

Test each rule on the clock it is entitled to:

- tick rules on price events with timer backstop;
- bar rules only on completed bars;
- poll rules on state, account aggregate or elapsed time;
- human rules only on explicit instruction.

Build adversarial tests for:

- Node and C++ amending the same stop in one second;
- equal-authority writers disagreeing;
- a lower-authority writer following a higher-authority action;
- owner stop followed by automated tightening;
- stop widening;
- stale TrailEngine specification;
- restart with an active trail;
- rejected amend;
- ambiguous amend;
- broker minimum-distance rejection;
- partial close racing with full close;
- timeout while broker work continues;
- account switch during a detached subphase;
- duplicate close requests;
- locally closed but broker open;
- broker closed but locally open.

Measure by strategy and exit reason:

- MAE;
- MFE;
- realised R;
- MFE capture ratio;
- profit giveback from peak;
- time to break-even move;
- time to first ratchet;
- ratchet lag from threshold crossing to broker acknowledgement;
- amendments per position;
- partial-profit contribution;
- runner contribution;
- time-cap contribution;
- percentage closed inside 0.1R, 0.25R and 0.5R;
- percentage reaching broker SL/TP;
- profit factor and expectancy before and after management costs.

Replay counterfactuals:

1. broker bracket only;
2. current full stack;
3. Node management without C++ trail;
4. C++ trail without overlapping Node ratchet;
5. no early break-even;
6. no time cap;
7. no scale-out;
8. wider runner after partial profit;
9. management matched to the strategy timeframe.

These are measurements, not automatic recommendations.

## 13. Audit C++ execution, streams and parity

Trace:

```text
Node policy
→ HTTP intent
→ authentication and account stamp
→ request queue
→ cTrader WebSocket request
→ request/response correlation
→ execution event
→ Node response
→ durable persistence
→ reconciliation
```

Inspect:

- locks and thread ownership;
- queue ordering;
- request IDs;
- timeouts;
- reconnects;
- heartbeats;
- stale ticks;
- account authorization;
- symbol subscriptions;
- memory and lifetime safety;
- exception handling;
- telemetry drops;
- durable versus ephemeral state;
- deployment restart isolation;
- Node fallback;
- repeated or ambiguous submits.

Verify semantic parity for:

- symbols and IDs;
- BUY/SELL mapping;
- bid/ask choice;
- volume and lot units;
- price digits and rounding;
- SL/TP units;
- partial-close units;
- account stamping;
- broker acknowledgement;
- failure and retry;
- backtest assumptions;
- TrailEngine stop candidates.

A health endpoint is not proof of useful work. Demonstrate a recent successful broker session, authorised account, fresh tick, completed request and reconciled state - using demo/read-only evidence.

## 14. Audit the pending-order lifecycle

Trace every branch:

```text
setup
→ risk approval
→ opportunity/risk-event lineage
→ placement request
→ broker acknowledgement
→ local working row
→ restart/reconcile
→ invalidation
→ expiry
→ pause disposition
→ cancellation
→ broker fill
→ position adoption
→ trade and monitored-position persistence
→ protection verification
→ reconciliation
```

Test:

- fill while the process is offline;
- cancellation racing with fill;
- expiry racing with fill;
- duplicate stale rows;
- missing order side in reconcile payload;
- account-scoped order book;
- manual order on the same symbol;
- closed-market order adoption;
- missing approval lineage;
- missing or malformed label;
- broker order gone with no matching position;
- restart after placement but before persistence;
- order accepted but local timeout;
- order locally recorded but broker rejected.

Every pending order, fill and adopted position must retain account, strategy, opportunity and risk-approval provenance.

## 15. Test human visual-awareness without hindsight

The human operator can notice chart structure that is not represented in numeric features. Treat that as a testable information gap, not as mystical discretion.

Create an `Awareness Gap Register` for patterns such as:

- compression;
- trend maturity;
- exhaustion;
- failed breakout;
- defended or pinned level;
- news spike;
- liquidity gap;
- correlated herd move;
- one correlated leg being held while another runs;
- regime transition;
- obvious data anomaly.

For a representative sample:

1. render charts only up to the decision timestamp;
2. hide all future bars and outcomes;
3. show the bot’s proposed action, evidence and uncertainty;
4. ask the human reviewer to record a structured label before seeing the outcome:
   - agree;
   - veto;
   - defer;
   - reduce size;
   - no opinion;
5. record one reason code;
6. reveal the outcome only after the decision is locked;
7. compare human-plus-bot with bot-only on expectancy, drawdown, missed winners and avoided losses.

Avoid selection bias: include taken trades, vetoed opportunities, no-trade periods and random controls.

If a visual pattern adds repeatable out-of-sample value, specify the smallest deterministic feature that could represent it. Keep it advisory until validated. Do not introduce an unconstrained vision-model veto into live execution.

Deliver a UI/telemetry specification showing the owner:

- what the bot saw;
- what it did not know;
- why a gate passed or failed;
- what controller currently owns the position;
- what would change the decision;
- whether the reading is fact, inference or advisory context.

## 16. Apply the short-run voting machine and long-run weighing machine lens

For each strategy and asset class state:

- decision horizon;
- dominant inputs;
- whether it responds mainly to short-run “votes” - price, momentum, liquidity, volatility, crowding and sentiment;
- whether it uses any long-run “weight” - cash flows, earnings, assets, debt, macro equilibrium, rates or valuation;
- whether the holding period is compatible with those inputs;
- whether management exits before the alleged long-run thesis could become measurable.

Do not describe a price-only strategy as “undervalue investing”.

For an operation to qualify as an equity investment, identify the actual valuation and margin-of-safety pipeline. If none exists, deliver a specification for a separate optional investment module rather than contaminating short-run trading logic. It would require, at minimum:

- audited financial statements;
- normalized earnings and free cash flow;
- balance-sheet strength;
- debt and liquidity;
- dilution;
- valuation range;
- margin of safety;
- catalyst-independent holding logic;
- much longer review cadence;
- no leveraged CFD assumption by default.

The audit may conclude that this application is a disciplined speculative trading system. That is not a failure if the speculation is bounded, transparent and positive-expectancy. It is a failure only if speculation is mislabeled as investment or risk is not bounded.

## 17. Reliability, security and failure-state honesty

Audit:

- bearer-token tiers and write authority;
- secret exposure;
- account isolation;
- route authorization;
- CORS;
- database integrity and backup;
- process and sidecar restart;
- stale configuration;
- unavailable broker;
- stale market data;
- controller heartbeat semantics;
- timeout semantics;
- swallowed exceptions;
- detached promises;
- telemetry durability;
- deployment isolation.

Chaos-test offline/demo scenarios:

- broker disconnect;
- delayed broker acknowledgement;
- duplicate execution event;
- out-of-order event;
- sidecar restart;
- Node restart;
- DB unavailable;
- stale tick;
- clock jump;
- partial data refresh;
- one account authorized and another unauthorized.

Every failure must resolve to one of:

- safe and visible;
- degraded and visible;
- blocked and visible;
- unsafe;
- silent unknown.

“Idle”, “no setup”, zero and healthy must never be used as generic fallbacks for unavailable evidence.

## 18. Required engineering deliverables

Create:

```text
audit/algo-integrity-YYYY-MM-DD/
├── 00-executive-verdict.md
├── 01-baseline-and-evidence.md
├── 02-executable-system-map.md
├── 03-strategy-dossiers.md
├── 04-mathematics-and-invariants.md
├── 05-data-quality-and-noise.md
├── 06-backtest-and-parity-validity.md
├── 07-opportunity-and-veto-funnel.md
├── 08-risk-of-ruin-and-capital-safety.md
├── 09-trade-management-and-profit-retention.md
├── 10-cpp-node-streams-and-authority.md
├── 11-pending-order-lifecycle.md
├── 12-human-awareness-study.md
├── 13-graham-voting-weighing-classification.md
├── 14-findings-ledger.md
├── 15-remediation-roadmap.md
├── evidence/
│   ├── commands.log
│   ├── baseline-tests.log
│   ├── data-queries.sql
│   ├── runtime-data-manifest.md
│   └── hashes.txt
└── machine/
    ├── machine-summary.json
    ├── decision-stages.json
    ├── strategy-results.csv
    ├── strategy-scorecard.csv
    ├── control-effectiveness.csv
    ├── finding-register.csv
    ├── writer-authority.csv
    └── opportunity-funnel.json
```

`machine-summary.json` must state the frozen SHA, executed and blocked tests, overall verdicts, finding counts by severity, data limitations and whether any live action occurred. `strategy-results.csv` must contain one row per strategy-account-symbol-timeframe evaluation slice with explicit sample and cost fields. `finding-register.csv` must mirror every human-readable finding ID and disposition.

Prefer extending existing audit scripts and tests over creating duplicate tooling. If new tooling is necessary, keep it read-only, deterministic and documented. Suggested capabilities, not mandatory filenames:

- strategy invariant runner;
- live/backtest parity checker;
- opportunity counterfactual replay;
- management-event replay;
- data-quality scanner;
- risk-of-ruin simulator;
- Node/C++ parity harness.

When runtime data is unavailable, `data-queries.sql` must contain executable read-only queries and the reports must clearly mark the corresponding sections `NOT EXECUTED - DATA UNAVAILABLE`.

## 19. Finding contract

Every finding must use this structure:

```markdown
## F-<domain>-<number> - <title>

**Classification:** defect | under-defence | over-defence | policy conflict | data defect | observability gap | non-finding  
**Severity:** capital | critical | high | medium | low  
**Confidence:** high | medium | low  
**Affected scope:** accounts, symbols, strategies, timeframes and files  
**Frozen SHA:**  
**Status:** proved | disproved | provisional | blocked  

### Observation
What was directly observed.

### Inference
What the evidence means, with assumptions.

### Reachable trigger
The exact path that causes it.

### Economic effect
Risk created, loss avoided, opportunity lost, expectancy changed or evidence corrupted.

### Evidence
Files, functions, lines, tests, logs, SQL and broker evidence.

### Counter-evidence
Evidence that weakens or limits the finding.

### Minimum sufficient remedy
The smallest safe correction.

### Policy boundary
Whether owner approval is required.

### Regression proof
A test that fails before the fix and passes after it.

### Rollback
How to restore prior behaviour safely.
```

Do not create a defect finding for code that is merely unusual. Prove reachability and consequence.

## 20. Remediation sequencing

Rank findings by:

1. capital safety;
2. corrupted evidence or wrong accounting;
3. cross-account or execution correctness;
4. silent strategy or pipeline failure;
5. concurrency and authority conflict;
6. backtest/live mismatch;
7. material expectancy loss;
8. observability;
9. optimisation.

Use this sequence:

```text
P0 - make evidence trustworthy
P1 - prevent unintended capital risk
P2 - restore correct signal and opportunity flow
P3 - remove proven control overlap or winner truncation
P4 - improve awareness and operator explanation
P5 - optimise speed only after correctness
```

For each proposed code change specify:

- exact files;
- behavioural contract;
- tests;
- migration;
- observability;
- rollout on offline/demo;
- acceptance threshold;
- rollback;
- owner decision.

Never bundle unrelated trading-behaviour changes into one PR.

## 21. Mechanical acceptance gates

The audit is incomplete unless:

- one frozen SHA is recorded;
- all 12 current strategies have a dossier and verdict;
- every strategy’s live and backtest path is identified;
- every statistic states its unit and denominator;
- evaluations are not counted as opportunities;
- planned R:R is not presented as realised R:R;
- missing data is not counted as zero or success;
- every position writer and closer is inventoried;
- every management rule is assigned tick, bar, poll or human trigger;
- Node/C++ parity is tested where both implement the same behaviour;
- account scope is tested on every money path;
- same-bar exit ambiguity is handled;
- costs and slippage are included;
- out-of-sample evidence is separated from in-sample evidence;
- parameter tuning and evaluation data are separated;
- counterfactual veto and exit analyses are produced;
- risk of ruin is estimated under correlated stress;
- human chart review is blinded to future data;
- all new tests are deterministic;
- existing safe gates pass after any audit-only changes;
- no live action occurred;
- every unresolved item names the missing evidence.

## 22. Independent red-team review

Before finalising, conduct a separate review pass. If multiple agents or models are available, the reviewer must not be the authoring agent. If only one agent is available, reset context and perform an explicit adversarial review.

The reviewer must ask:

- Did the audit trust a comment instead of a call path?
- Did it mix SHAs?
- Did it confuse signal, evaluation, opportunity, approval, order, fill, position or trade?
- Did it compare different account scopes?
- Did it treat unknown as zero?
- Did it use future bars?
- Did it let a diagnostic inspect more data than production?
- Did it overlook a strategy that loaded as a null compute?
- Did it hide strategy starvation behind “no setup”?
- Did it infer broker success from local intent?
- Did it infer protection from a local stop field?
- Did it overlook work continuing after a timeout?
- Did it ignore C++/Node concurrent writers?
- Did it tune and evaluate on the same data?
- Did it aggregate away a losing strategy?
- Did it call speculation investment?
- Did it recommend a policy change as though it were a bug fix?
- Did it overstate confidence from a small sample?
- Did it report a healthy system without proving useful work?

Record reviewer objections and how each was resolved.

## 22.1 Pre-submission self-check

Before returning the final audit, run a mechanical prompt-completion check and include its result in `evidence/prompt-completion-check.log`. It must verify:

- all 12 registry strategies are present exactly once in the strategy verdict table;
- all H01-H18 hypotheses have a disposition;
- every required report and machine file exists;
- Markdown code fences are balanced;
- every finding ID is unique and appears in both the findings ledger and `finding-register.csv`;
- every numeric rate has a named numerator, denominator, unit and time window;
- every counterfactual states the frozen policy and price information available at decision time;
- no command containing `--order`, production write route or live state mutation was executed;
- every unavailable test is marked blocked rather than passed;
- the final recommendations distinguish correctness fixes from owner policy decisions.

A failed self-check means the audit is not ready for delivery.

## 23. Final response format

Return:

1. **Executive verdict** - no more than two pages.
2. **Top confirmed findings** - ordered by capital and economic importance.
3. **Top non-findings** - important suspicions that were tested and rejected.
4. **Strategy scorecard** - all current strategies.
5. **Control-effectiveness scorecard** - risk avoided versus opportunity cost.
6. **Investment/speculation classification**.
7. **What the human sees that the bot does not** - measured, not anecdotal.
8. **Immediate P0/P1 actions**.
9. **Deferred owner-policy decisions**.
10. **Files created and commands run**.
11. **Draft PR or branch status**.
12. **Unknowns and exact evidence needed**.

End with a direct answer to these questions:

- Is the system currently trading a demonstrated edge or merely operating a complex set of rules?
- Which strategies are alive, reachable and sufficiently tested?
- Where does noise enter?
- Where are valid opportunities lost?
- Where are bad trades correctly prevented?
- Where are winners truncated?
- Can Node and C++ act inconsistently on the same position?
- Is principal protected against realistic correlated and gap risk?
- Which operations are investments, and which are speculation?
- What is the smallest evidence-backed sequence of changes that improves expectancy without enlarging the blast radius?
