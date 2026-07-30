BOT-TRADE COCKPIT — LIVE WIRING AND DECISION-INSIGHT IMPLEMENTATION PROMPT
Version: 1.0
Date: 30 July 2026
Repository: ang-kl/bot-trade

<MISSION>
Review and implement the smallest safe set of changes needed to replace mock
cockpit values with authoritative or explicitly derived values. Preserve the
current visual information architecture. Make every displayed conclusion
traceable to facts, rules, timestamps and sources. The cockpit is an insight
and decision-support surface; it must not silently execute, amend or close
trades.
</MISSION>

<AUTHORITY_AND_PERMISSION>
The user authorises a read-only review and a proposed implementation prompt.
The coding AI may modify source only after the discovery checkpoint and a
recorded plan. It must not push, deploy, enable live trading, change broker
credentials, or make a visual/layout change without separate permission.

Locked without further permission:
- current cockpit layout and section order;
- desktop, iPad and iPhone geometry and breakpoints;
- card ratios, PFD/MFD columns, tabs, rulers, scroll areas and viewBox;
- labels, colours, tokens, typography, animation semantics and responsive rules;
- existing broker execution and risk semantics;
- existing account selector and authentication model.

If a capability cannot fit the existing surface, use an existing tooltip,
advisory row, journal expansion, armed-action row, invalidation row or MARKET
SAYS text. Do not add a card, panel, column, drawer, section, modal, chart,
button or layout branch. If that is insufficient, stop and request permission
with a concrete DOM/layout proposal.
</AUTHORITY_AND_PERMISSION>

<OPERATING_CONTEXT>
Re-read the current repository before coding. Relevant files include:
- src/cockpit/TradeCockpit.jsx
- src/cockpit/cockpit-data.js
- src/cockpit/cockpit-nav.js
- src/cockpit/cockpit-fleet.js
- agent/routes/state.js
- agent/routes/actions.js
- agent/db.js
- agent/services/position-events.js
- agent/services/profit-keeper.js
- agent/services/news-calendar.js
- agent/services/correlation.js
- agent/services/correlation-matrix.js
- agent/services/cluster-conviction.js
- agent/lib/indicators.js
- agent/lib/ctrader-ws.js
- src/lib/agent-api.js
- src/lib/useLiveTicks.js

Design authority, in order:
- design_handoff_trading_dashboard/BUILD-ORDER.md
- design_handoff_trading_dashboard/trade-cockpit-spec.md
- design_handoff_trading_dashboard/symbol-click-spec.md
- design_handoff_trading_dashboard/canvas-variants-spec.md
</OPERATING_CONTEXT>

<REVIEW_BASELINE>
Verify these findings against current source.

Already real or substantially real:
1. Symbol, side, lots, entry, current SL/TP, live price, live P&L and market
   state are supplied by the open-position surface and broker snapshot.
2. R, TP/entry/SL rails and position economics can be derived from those facts.
3. FLEET can be computed from other open positions through cockpit-fleet.js.
4. Server-side chart bars and several indicators already exist in
   POST /actions/chart.
5. Live spot prices already stream through GET /actions/stream-prices.
6. position_events exists, is retained, has tests and is written by several
   management paths.
7. The economic calendar is cached and filtered by symbol currencies.
8. Curated correlation clusters and a rolling Pearson matrix exist.

Partially wired or unsafe to treat as complete:
1. TradeCockpit currently calls cockpitFrame() and does not fetch a cockpit
   payload or subscribe to a cockpit state stream.
2. Click binding does not consistently carry durable database position identity,
   broker position identity, trade identity and account identity.
3. Existing correlation output is cluster metadata, not current-symbol
   pairwise evidence, and its account scope/stale behaviour must be verified.
4. position_events is recorded but is not exposed as the cockpit journal.
5. Existing news support is an economic calendar, not a complete fundamentals
   feed.
6. Spread, margin and latency need authoritative sources and freshness metadata.
7. Manage, Close and Fleet behaviours must not be assumed to be wired because
   their controls are visible.

Mock/demo risk:
cockpit-data.js currently synthesises or hardcodes chart history, candles,
EMAs, VWAP, volume profile, traffic, MARKET SAYS, RVOL, spread, latency,
margin, news/weather annotations, armed actions, invalidation values, alerts
and fallback fleet. These must never be shown as live facts for a real position.

Core rule:
missing, stale, failed, ambiguous or unsupported data is UNKNOWN. It is not
zero, normal, clear, intact, within tolerance, no news, no correlation or a
fabricated default.
</REVIEW_BASELINE>

<DEFINITION_OF_DONE>
For a real bound position, every value is classified as:
LIVE, DERIVED, RULE, HISTORICAL, STALE, UNKNOWN or DEMO.

DEMO is permitted only in an explicit demo fixture or development mode. It is
never a fallback for a real bound position.

The user can answer:
- What position is this, in which account, and how fresh are its facts?
- What was the bot's thesis, strategy, side, entry plan and initial risk?
- What is the bot doing now and why?
- What is the next unattended action, trigger, distance and rule source?
- What would invalidate the thesis, and is each condition clear, breached,
  blocked or unmeasured?
- What market, correlation, execution, session or news conditions support or
  weaken the plan?
- What information is unavailable or stale?

No order is submitted, amended, closed, armed or disarmed by this task.
</DEFINITION_OF_DONE>

<NON_NEGOTIABLES>
1. No fabricated live data. Keep the old mock frame only as an explicit demo
   adapter or test fixture.
2. No silent account fallback. Carry and validate:
   accountId, dbPositionId, brokerPositionId, tradeId and symbol.
3. Broker truth wins; if broker and local values disagree, return a conflict
   state and both provenance details.
4. Timestamp all data that can stale. Use UTC ISO timestamps, age and status.
5. Deterministic before generative. An LLM may paraphrase a validated evidence
   bundle but may not invent facts, thresholds, sources, triggers or actions.
6. Do not call a model on every price tick. Cache explanations by evidence
   revision.
7. Do not add expensive broker handshakes to repaint or tick paths. Reuse the
   broker snapshot cache, server indicator functions and existing SSE stream.
8. Reuse position_events and recordPositionEvent(); do not duplicate tables or
   event writers.
9. Do not call the economic calendar fundamentals. If no fundamentals provider
   exists, report NOT_INGESTED.
10. Do not wire Manage or Close to a broker action in this task.
</NON_NEGOTIABLES>

<MANDATORY_DISCOVERY_CHECKPOINT>
Before changing code, produce:
A. current branch/commit and dirty-worktree status;
B. route mounts and authentication middleware;
C. position identity/account path from click to API;
D. schema and write sites for position_events;
E. reusable indicator, price, news, correlation and broker-health functions;
F. a field-by-field source, freshness, unknown-behaviour and UI-binding table;
G. files to change and files deliberately not changed;
H. test and rollback plan.

Do not code if account identity, endpoint mount, data authority or layout impact
is ambiguous. Ask a focused question or issue a PUSHBACK record.
</MANDATORY_DISCOVERY_CHECKPOINT>

<TARGET_DATA_CONTRACT>
Implement one read-only cockpit adapter using the existing agent route and auth
architecture. Recommended logical route:

GET /state/position/:dbPositionId/cockpit
  ?account=<validated-account-id>&timeframe=15m&lookback=48h

The response is one coherent snapshot with a revision and provenance. Adapt names
to current conventions only if semantics remain unchanged.

{
  meta: {
    schemaVersion, revision, fetchedAt, accountId, dbPositionId,
    brokerPositionId, tradeId, dataMode, overall
  },
  position: {
    symbol, side, lots, entry, sl, tp, price, bid, ask, pnl, pnlCurrency,
    openedAt, marketOpen, marketSource, mfeR, maeR, status
  },
  account: {
    currency, balance, equity, usedMargin, freeMargin, dailyLossCap,
    dailyLossUsed, source, asOf, status
  },
  bars: {
    timeframe, since, rows[{t,o,h,l,c,v}], source, asOf, status
  },
  indicators: {
    ema9[], ema20[], ema50[], vwap[], rvol,
    volumeProfile{buckets[], pocPrice, valueAreaLow, valueAreaHigh, status},
    source, status
  },
  execution: {
    spreadNow, spreadBacktest, spreadRatio, latencyMs, slippageAtEntry,
    status, facts[]
  },
  intention: {
    strategy, strategyVersion, source, side, conviction, thesis,
    entryRationale, initialRisk, targetPlan[], timeCapAt,
    currentDecision{state, action, reason, evidence[], asOf, source},
    nextAction{kind, trigger, triggerPrice, distance, eta, armed, ruleSource},
    invalidation[],
    explanation{text, mode, model, generatedAt, evidenceRevision}
  },
  journal[],
  correlation: {
    timeframe, lookback, builtAt, status, related[], clusters[],
    portfolioExposure[]
  },
  environment: {
    session{state, exchange, nextOpenAt},
    regime{label, direction, source, status},
    macroNews{events[], source, fetchedAt, cacheAgeMs, status},
    fundamentals{items[], source, status}
  },
  fleet{list[], total, status},
  advisories[],
  provenance{}
}

Use null plus status=unknown rather than guessed values. Each meaningful field
must have source, asOf/age where applicable, and a stable evidence or provenance
identifier.
</TARGET_DATA_CONTRACT>

<INTENTION_AND_INSIGHT_RULES>
Separate facts from interpretation.

FACTS:
broker price/P&L, entry/SL/TP, balance/equity/margin, bars, spread, latency,
event timestamps, correlation coefficients, stored thesis, stored guard, risk
decision, monitor review and position events.

DERIVED:
signed R, MFE/MAE/giveback, distance to trigger, ETA, VWAP relation, EMA slope,
RVOL, effective correlation, cluster loading, risk-to-stop and reward-to-target.
Include formula inputs and timestamp in provenance.

RULES:
guard_json, profit-keeper settings, loss cap, news gate, correlation threshold,
spread threshold, margin threshold and time-cap rule. A rule is not evidence
that its trigger is currently met.

INTENTION must explain what the bot is configured to do next, not what it hopes
will happen. A valid deterministic explanation resembles:
"Holding LONG because the stored thesis remains intact and the current monitor
review is clear. The next configured action is a 50% scale-out at +1R. No action
is taken because the trigger is not met. A high-impact USD release is 18
minutes away; new entries are blocked by the calendar gate, but this existing
position is not automatically closed by that gate."

Every sentence needs one or more evidence IDs. Do not write confirmed, normal,
all clear, thesis intact or path to TP without the underlying checks being
present and fresh.

Optional LLM explanation requirements:
- send only the structured evidence bundle, never credentials;
- require text, evidenceIds, uncertainty and generatedAt in validated JSON;
- validate evidenceIds against the bundle;
- label model, timestamp and evidence revision;
- cache by evidence revision;
- on failure, use deterministic explanation;
- never create or alter an order decision.
</INTENTION_AND_INSIGHT_RULES>

<IMPLEMENTATION_SEQUENCE>
Implement in order. Stop at every gate.

PHASE 0 — discovery and baseline
Verify source, routes, identities, data authorities, current tests and layout.
GATE: no unresolved identity or layout ambiguity.

PHASE 1 — identity and read-only endpoint shell
Carry dbPositionId, brokerPositionId, tradeId, symbol and accountId from
Performance, Desk, TradeGaugeWall and deep-link loading into the cockpit.
Add a read-only route using existing auth and requestedAccount/accountWhere
patterns. Reject wrong-account, ambiguous or missing identity.
GATE: two-account isolation test passes.

PHASE 2 — real position, account and execution snapshot
Map broker snapshot fields to the contract. Use real quote/deposit currency,
digits, lots, margin, P&L and SL/TP impact. Use bid/ask for spread. If no
backtest baseline exists, spreadRatio is UNKNOWN. Expose latency only from an
authoritative metric. Reuse the existing price SSE for tick-level updates.
GATE: real position paints broker facts; missing fields remain honest.

PHASE 3 — real bars and indicators
Reuse server-side indicator functions and the existing chart data path. Provide
15m bars from entry through lookback, with explicit partial-history status.
Compute EMA9/20/50, VWAP, RVOL and volume profile from the same bars. Preserve
the current MFD drawing, mapping, de-collision and PFD layout.
GATE: chart values can be checked against returned bars.

PHASE 4 — real tweak journal
Reuse position_events and existing write sites. Query by account and durable
position identity. Map events to the existing journal rows and markers without
inventing dates, OHLC or R values. Show unknown OHLC when no bar exists. Include
actor/source, from/to, priceAt, rAt, reason and detail through current tooltip or
journal expansion. An empty journal is honest for a new position.
GATE: seeded SQLite event appears once with exact source and values.

PHASE 5 — intention, armed actions and invalidation
Use trades, monitored_positions, guard_json, latest monitor review, decision/risk
logs, position_events, risk configuration and profit-keeper state. Produce
deterministic currentDecision, nextAction and invalidation states. Distinguish
configured, armed, triggered, executed, blocked, paused and unknown. Explain why
the bot is holding, waiting, managing or exiting, with evidence IDs and as-of
times. Render only through existing MARKET SAYS, ARMED ACTIONS, INVALIDATION
WATCH, ADVISORIES and journal expansion.
GATE: seeded position produces a reproducible supported explanation.

PHASE 6 — correlation and portfolio context
Combine curated clusters with the live pairwise matrix. Return coefficient,
signed/effective correlation, timeframe, lookback, builtAt, age and stale status.
Explain stack, hedge or divergence. Scope all held positions to the cockpit
account. Missing/stale/insufficient matrix means UNKNOWN or limited, never zero
traffic or fabricated agreement.
GATE: positive, negative, stale, missing and two-account tests pass.

PHASE 7 — environment, macro news and fundamentals status
Use broker symbol-hours plus existing fallback, with source. Use
news-calendar.js relevantEvents/newsWindowEvent and expose real title, currency,
impact, scheduled time, minutes from now, source, fetchedAt and cache age.
Distinguish existing-position management from new-entry gating.
Show WX only for an actual relevant event.
Do not call the calendar fundamentals. Without a configured fundamentals provider,
return fundamentals.status=not_ingested. Any future provider must be allowlisted,
cached, timestamped, attributable and feature-flagged.
GATE: live, stale, empty and provider-not-configured tests pass.

PHASE 8 — frontend adapter and refresh
Add one adapter that loads the snapshot and maps it to the existing render shape.
Retain layout and animations; a refresh must not reset an in-flight number roll,
historical path or journal state. Use existing SSE for ticks and bounded snapshot
refresh/patches for slower facts. Coalesce updates and stop when hidden/asleep.
Use an existing ADVISORY row for partial/stale/error status. DEMO DATA appears
only in explicit demo mode or an unbound route.
GATE: deep link, reload, close, tab switch, stale recovery, reduced motion and
layout checks pass.

PHASE 9 — optional model explanation
Only after deterministic insight passes. Use existing model-router/provider
conventions. Cache by evidence revision, log cost safely and keep deterministic
insight complete when the model is unavailable.
GATE: model failure cannot block the cockpit or trading loop.
</IMPLEMENTATION_SEQUENCE>

<UI_BINDING_WITHOUT_LAYOUT_CHANGE>
Keep existing elements and bind only their data:
- PFD: price, R, speed, VSI, heading and real rails.
- PRICE·15m: returned candles, VWAP and real rails.
- VOL: returned volume profile with POC/value-area/LVN status.
- MFD: real flown bars, stored plan, indicators, sourced terrain, actual news
  and actual TCAS evidence only.
- MARKET SAYS: deterministic summary from correlation, regime and evidence.
- bullet bars: RVOL, spread, margin and latency with freshness state.
- TWEAK JOURNAL: position_events.
- RISK BUDGET: account snapshot and risk configuration.
- ARMED ACTIONS: current guard/profit-keeper rules and next triggers.
- INVALIDATION WATCH: stored and evaluated invalidation conditions.
- ADVISORIES: freshness, conflicts, blockers, news and evidence gaps.
- FLEET: account-scoped real positions with real click-to-swap identity.

Use existing info tooltips and row expansion for source, timestamp, formula and
uncertainty. Do not add cards or move elements.
</UI_BINDING_WITHOUT_LAYOUT_CHANGE>

<SAFETY_AND_ACCOUNT_TESTS>
At minimum test:
- account A cannot receive account B position, balance, fleet, correlation or
  event rows;
- identity mismatch returns safe not-found/conflict;
- short R, rails, MFE/MAE and progress are directionally correct;
- empty, partial, stale and failed bars never become synthetic candles;
- indicator arrays align with bar timestamps;
- journal order, source, from/to, reason and detail are preserved;
- retried management events do not create misleading duplicates;
- missing/stale correlation is UNKNOWN, not 0 or same-heading;
- positive and negative effective correlation classify correctly;
- news cache failure and age are visible;
- fundamentals not_ingested is distinct from no fundamental event;
- broker/local conflicts are reported;
- ticks do not regenerate bars, journal or intention revision;
- no fresh broker session is opened per repaint;
- no token, secret or cross-account data is exposed;
- Manage and Close have no broker side effect;
- desktop, iPad and iPhone layout acceptance checks remain green in both themes.
</SAFETY_AND_ACCOUNT_TESTS>

<FEATURE_FLAGS_AND_ROLLBACK>
Use additive changes and a reversible adapter boundary:
- live cockpit read flag;
- frontend live-adapter flag;
- optional explanation flag, OFF by default;
- optional fundamentals-provider flag, OFF until configured.

Rollback must be one controlled flag/config change to the previous stable adapter.
Do not delete position_events, lose history, alter broker execution or run a
destructive migration. Keep the old mock fixture until live mode passes an
observation period.

Before enabling live mode record current commit, migration state, endpoint
health/latency, sample payload hashes, screenshot/layout comparison and the exact
rollback command.
</FEATURE_FLAGS_AND_ROLLBACK>

<AI_PUSHBACK_PROTOCOL>
Push back when:
- account or position identity is ambiguous;
- authoritative data is missing, stale or contradictory;
- the display would require inventing a number or narrative;
- a route could expose another account or use an unsafe fallback;
- a broker call would be added to a hot repaint/tick path;
- a layout change is necessary but unauthorised;
- a model call would enter execution, risk or protective management;
- tests cannot prove rollback or unknown-outcome behaviour.

Use this exact format:
<PUSHBACK>
  <issue>specific blocker</issue>
  <evidence>file, route, test or observed behaviour</evidence>
  <risk>what could be wrong or unsafe</risk>
  <safe_alternative>smallest useful alternative</safe_alternative>
  <decision_needed>what the owner must approve or clarify</decision_needed>
</PUSHBACK>

Never silently resolve a blocker by substituting a mock value.
</AI_PUSHBACK_PROTOCOL>

<REQUIRED_DELIVERABLES>
Return:
1. field-source/provenance matrix;
2. endpoint contract and actual mounted URL;
3. files changed and files not changed;
4. schema/migration statement;
5. account-isolation evidence;
6. test commands and results, separating environment failures from code failures;
7. screenshot/layout comparison confirming no unauthorised visual change;
8. mock/demo values removed from the live path;
9. feature flags and rollback procedure;
10. known unknowns, especially fundamentals, latency, stale correlation or
    unavailable broker fields;
11. PUSHBACK records and decisions required.

Do not claim fully live, AI confirmed, thesis intact or safe to trade unless the
evidence and tests support that exact statement.
</REQUIRED_DELIVERABLES>

<START>
Begin with PHASE 0 discovery only. Do not change the layout. Do not wire broker
actions. Do not invent missing market or fundamental information.
</START>

