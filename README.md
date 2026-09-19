# bot-trade

> **Proprietary — all rights reserved.** This repository is public for reference only.
> No permission is granted to use, copy, modify or redistribute it; see [LICENSE](LICENSE).
> It places real orders and can lose money. No warranty, no liability, not financial advice.

Deterministic multi-strategy trading agent for cTrader (Pepperstone), with a 5-tab web control panel, a C++ execution sidecar, and full self-monitoring.

**How it decides:** entries are pure rules — no LLM in the trade path. Five registered strategies (Fib 61.8% fade — the default — Cup & Handle, EMA pullback, Donchian breakout, RSI mean-reversion) scan closed bars only; every proposal then passes a deterministic risk gate (`agent/services/risk.js`): risk-based sizing from balance × per-trade % (uncapped unless the owner caps it), min R:R, daily loss cap + equity stop, per-symbol cooldowns, max positions, margin/exposure checks with cross-pair USD conversion. Claude is used **only** for position monitoring and weekend gap checks — that spend is metered and capped (Desk → LLM spend).

## Architecture

| Piece | Where | What |
|---|---|---|
| Web UI | `src/` → Vercel | 5 tabs: **Desk** (chart wall, status, controllers, LLM spend, edge health), **Trade** (signals, positions, order log), **Accounts** (broker truth, all accounts), **Tune** (pipeline stage matrix, risk, watchlist, burn-in, backtest), **Connect** (agent + cTrader wiring) |
| Agent | `agent/` → Railway | 5-min main loop + 30s fast position monitor. SQLite on a Railway Volume (`DB_PATH=/data/agent.db`), Express API |
| C++ exec engine | `cpp-exec/` → Railway sidecar | Order place/amend/close/cancel + reconcile over a persistent broker session (`EXEC_ENGINE=cpp`), and the compute-heavy backtester. Probed via `GET /health` by the heartbeat monitor. Phased plan: `CPP-ROADMAP.md` |
| cTrader proxy | `api/ctrader.js` → Vercel | OAuth + browser-side data proxy |

## The controllers (all heartbeat-monitored)

Main loop (scan → risk gate → order → monitor) · fast position monitor (30s, volume-adaptive cadence + per-symbol overrides) · burn-in engine (micro-quant track-record mode: dynamic timeframes, pace-to-target) · pending-order manager · trade guards · profit keeper · adaptive breaker (3 losses on a strategy → rotate strategy/filters; cooldown pauses are for humans) · strategy autopilot · market-hours refresh (broker-truth `symbol_hours` table, daily, scales to 1,900+ symbols) · C++ engine liveness probe · protection audit · weekend watch (LLM) · equity stop · performance breaker (the last three registered 02-09-2026 — they ran before, unwatched). The full roster is `CONTROLLERS` in `agent/services/heartbeat.js`; a beat persists the controller's own `detail` of that run (`last_detail_json`), and `GET /state/heartbeats` returns `controllers`, `atrRefresh`, `rosterInvariant` and `execGuardSync` (the exec-guard sync's last failure, or null). A stalled controller alerts on Telegram within minutes (Desk → Controllers).

## Safety & truth systems

- **Order log** — every order attempt (auto, burn-in, manual, pending, test fill), fill or veto, with source and reason. One standard table everywhere (Trade/Desk/Accounts): Time | Symbol | Result | Source | Side | Qty | Entry | Stop Loss | Take Profit (full ladder: #n · price · lot) | Reason | Chart.
- **Reconciler + tamper watch** — broker truth wins: adopts untracked bot fills, imports external positions, detects positions closed at the broker, and flags MANUAL CHANGES to tracked positions (reversal / volume / hand-moved SL-TP). A reversal is re-strategized: fresh 1×ATR SL + minRR TP amended at the broker, with a momentum verdict on the new direction; owner-moved levels are audited, never fought (`agent/services/restrategize.js`).
- **Equity stop** — daily drawdown breach closes all bot positions and disarms autotrade.
- **LLM spend** — per-call token usage priced in USD (day × purpose × model), monthly projection, once-a-day Telegram alert on an owner-set cost cap.
- **Alpha decay** — rolling expectancy per strategy (recent vs prior trade windows) + expectancy by signal→fill lag, so a dying edge is cut on evidence.
- **Strategy autopilot arm bar** (`agent/services/strategy-autopilot.js`, 02-09-2026) — the bar is config, not code: `autopilot_arm_bar_json` (`minPf`/`minWin`/`minTrades`, clamped) via `POST /actions/autopilot { armBar }`, read back at `/state/config.autopilot`. Each sweep computes a shrinkage prior over ALL verdicts with trades (`sweepShrinkPrior`: mean WR and mean PF, PF capped at 5 for the mean, null under 30 verdicts) and pulls every combo toward it with the weight of 20 phantom trades (`shrinkVerdict`, w = n/(n+20)) before judging it against the bar. An armed combo is dropped once its shrunk PF falls under 85% of the arm bar (`DISARM_PF_FRACTION`), not only on NO-GO. A strategy the live evaluators (edge watchdog, adaptive breaker) disarmed stays off the arm list for 24 h (`LIVE_DISARM_COOL_OFF_MS`) — the backtest cannot out-vote live money for a day.
- **Arming scope** (`armedScopeGate`, `agent/lib/timeframes.js`) — the matrix wins over the timeframe list: a symbol the matrix names is gated by its matrix cells alone; the list gates symbols the matrix does not name, and everything when there is no usable matrix. `4d` is in the default list.
- **Divergence tracker** (`agent/services/divergence.js`, `GET /state/divergence?days=`, Tune → DivergenceCard beside the autopilot control) — measurement only, no actuator reads it. `combo_arms` snapshots the backtest evidence a combo was armed on (backfilled from the action log at boot, then reconciled with the live matrices every boot — live pairs with no verdict are recorded as `unevidenced`); `autopilot_verdicts` keeps a bounded verdict history; `autopilot_sweep_hist` keeps one binned PF/WR/n row per sweep. The report gives, per armed combo, backtest vs live PF/WR/expectancy and execution cost (slippage in R, spread as a fraction of the stop); every bot close classified by evidence level (`combo` / `symbol_tf` / `strategy_only` / `none`); and backtest optimism (mean backtest − live WR and PF over combos with ≥10 live closes, plus `pooled` and `byStrategy` trade-weighted figures that reach a usable sample sooner). Bot closes are keyed on `trades.origin`.
- **Position journal** (`position_events`) — every event carries `state_from`/`state_to`. States advance opened → be_moved → scaled_out → trail_armed → trail_tightened and never go back; close, loss-cap close and reversal end at `closed:<kind>`. `GET /state/exit-counterfactual` reports `byState`: the as-traded outcome split by the last state before the exit, with mean R at that transition.
- **Trade audit stamp** (`stampRealisedAudit`, `agent/services/trade-consistency.js`) — one helper re-stamps `realised_rr` and `pnl_price_mismatch` after every price or money write (close, P&L backfill, broker-history import, broker-price reconcile); `restampClosedTrades` re-runs it over every closed row once per version at boot (`trade_audit_restamp_version`). Dispatch keeps `proposal_entry_price` (the intended entry, so slippage survives the fill being reconciled over `entry_price`) and `analysis_id` (the prediction the order came from); `broker_sl_initial` is the stop as the broker first held it, stamped from the fill ACK or the first reconcile pass before any break-even move.
- **Per-account evidence** — `strategyRollingEdge`, `strategyPerfStats`, `computeSlWidenFactors`/`loadLessonTuning` all take an `accountId`; a per-account gate that read a pooled number could earn one account a floor on another's record. The earned floor measures W over the admitted band only — closes whose planned bracket was under `EARNED_FLOOR_RR_BAND` (3.0).
- **Protection audit** — one record per account (`acct:<id>:protection_audit_last_json`), merged into a whole-book view partitioned by freshness: counts sum over fresh records, stale accounts are named in `staleAccounts` with their own age rather than averaged in, and the pre-per-account global record is treated as a fossil, not a stale account.

## Run

```bash
npm install
npm run dev              # UI dev server on :5173
npm run build            # production build
npm test                 # vitest unit tests
npm run check:no-green   # accessibility gate (see below)

cd agent && npm install && node index.js   # agent on :3001
node --test "agent/**/*.test.js"           # agent test suite
```

## How to test (in order — each stage proves one layer)

1. **Unit tests**: `npm test` and `node --test "agent/**/*.test.js"`.
2. **Agent boots locally** — create `agent/.env`:
   ```
   AGENT_SECRET=pick-any-secret
   CLAUDE_API_KEY=sk-ant-...   # only used for position monitoring
   CTRADER_CLIENT_ID=...              # register an app at openapi.ctrader.com
   CTRADER_CLIENT_SECRET=...
   ```
   `node agent/index.js`, then `curl http://localhost:3001/health` → `status: ok`.
3. **UI connects** — Connect tab → URL `http://localhost:3001` + secret → *Test connection* → `REACHABLE`.
4. **cTrader demo account** — OAuth via the Connect tab (demo first); pick the account; the symbol map and market-hours table populate themselves.
5. **Scan pipeline** — Trade tab → *Scan now*. Signal rows = pipeline works; "no setup (any strategy)" = works, no setup.
6. **Validate the edge** (do not skip): Tune → Backtest (runs as a background job — page switches don't kill it; C++ engine when armed). If the profit factor isn't positive, don't arm autotrade.
7. **Dry-run** — Autotrade OFF for days; watch signals, vetoes (Order log), and the stage matrix counts.
8. **Demo autotrade / burn-in** — arm Autotrade (+ Burn-in for a paced 200-trades-in-2-days track record at 0.01–0.05 lots). Real order flow, fake money. Validation milestone: first broker fill CLOSED 2026-07-16 (`VALIDATION-DAY.md`). Go live only after demo P&L agrees with the backtest.

## Env vars

| Var | Where | Purpose |
|---|---|---|
| `AGENT_SECRET` | agent | Bearer auth between UI and agent (required) — full tier: authorizes every route, including orders/closes/config writes |
| `AGENT_SECRET_READ` | agent | Optional (D12, 2026-07-27): a second, lower-privilege bearer token that only authorizes `GET` (read-only/dashboard) routes — never an order, amend, close, or config write. Unset by default; every route behaves exactly as before until this is set. Safer to embed in a public build (`VITE_AGENT_SECRET_READ`) than the full secret, since a leak only exposes account data, not control. |
| `CLAUDE_API_KEY` | agent + Vercel | Claude API — position monitor / weekend checks, and the Risk page's Re-Risk when Claude is chosen |
| `ANTHROPIC_MODEL` | agent | Optional Claude model override. NOT tiered — the three `OPENAI_MODEL_*` vars below name OpenAI models |
| `OPENAI_API_KEY` | agent | OpenAI API. When set, OpenAI is the primary provider for every automatic LLM call |
| `OPENAI_MODEL_DEFAULT` | agent | **Cheapest tier — the great majority of calls.** Position monitor, weekend watch, screener search. Renamed from `OPENAI_DEFAULT_MODEL` (2026-07-30); the old name and the older `OPENAI_MODEL` are still read as fallbacks, in that order, so a box with only the old var keeps calling the model it already called. Unset everywhere ⇒ `gpt-5-nano` |
| `OPENAI_MODEL_PREMIUM` | agent | Moderate reasoning / better writing. Unset ⇒ falls back to the DEFAULT tier, never up to a costlier guess |
| `OPENAI_MODEL_REASONING` | agent | Rare, high-value, genuinely hard: the Risk page's Re-Risk (financial analysis). Unset ⇒ falls back to DEFAULT |
| `CTRADER_CLIENT_ID` / `CTRADER_CLIENT_SECRET` | agent + Vercel | Spotware Connect OAuth2 app |
| `EXEC_ENGINE` / `EXEC_URL` / `EXEC_SECRET` | agent | `cpp` routes orders through the C++ sidecar at `EXEC_URL` |
| `EXEC_URL_LIVE` / `EXEC_URL_DEMO` | agent | Optional per-broker-host sidecars. One sidecar process holds ONE broker host for its whole life, so live and demo accounts cannot share one. Unset (the default) = both sides use `EXEC_URL` and behaviour is identical to before. The order path, the connectivity gate (`loop.js`), the reconcile sweep, `/state/account-phases`, the heartbeat probe and the account-authorisation alert are all side-aware as of Phase 2, and a second sidecar reports under the `cpp_exec_demo` controller. **`EXEC_URL` must still be set** when these are used — unrouted callers (`backtestRemote`, `/depth`) resolve to it. The sidecar enforces its own side too: set `CTRADER_HOST` on it and it refuses a `/connect` naming any other host (unset = unpinned = today). |
| `VITE_AGENT_URL` | Vercel (build) | Default agent connection (overridable per-browser on Connect) |
| `VITE_AGENT_SECRET_READ` | Vercel (build) | Default agent secret for a fresh browser — READ TIER ONLY (D12, 2026-07-27). Safe to embed in the public bundle: a leak exposes account/dashboard data, never control. Full (order/close/config) access always requires pasting the real `AGENT_SECRET` into Connect, saved to that browser's `localStorage`. `VITE_AGENT_SECRET` / `VITE_AGENT_SECRET_AUTOPILOT` are no longer read by the frontend — remove them from the Vercel build once this is set. |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_OWNER_CHAT_ID` | agent | Alerts: vetoes, stalls, tampering, spend caps. There is no per-fill alert — `sendTradeAlert` had no caller and was deleted 02-09-2026 (#815) |
| `DB_PATH` / `PORT` / `FRONTEND_URL` | agent | SQLite path (**set to a mounted volume in production** — `/data/agent.db`), listen port, CORS origin |

Access token + account ID are pushed at runtime via the Connect tab and stored in the agent's SQLite DB.

### Model tiers

Routing lives in `agent/lib/model-router.js` and implements
[`llm_ai_doc/AI_Model_Router_Instruction.md`](llm_ai_doc/AI_Model_Router_Instruction.md):
default to the cheapest model, escalate only when the task needs it, never
default to the most expensive one, and keep the routing in code rather than in
env vars.

| Task | Tier |
|---|---|
| `position_monitor`, `weekend_watch` | DEFAULT — the highest-volume calls in the system, and a fallback opinion: entries and the risk gate are deterministic and the stop/target already sit at the broker |
| `screener_search` | DEFAULT — matching a query against a known symbol list |
| `summarise`, `rewrite`, `email`, `trade_lesson` | PREMIUM |
| `risk_reassess`, `financial_analysis`, `coding`, `architecture` | REASONING |

A caller may force the reasoning tier with any of `requiresMultipleSteps`,
`hasLargeCodebase`, `hasManyDocuments`, `userRequestedExpertMode`. Nothing
escalates on a heuristic — a flag has to be set deliberately, because a router
that quietly escalates spend defeats the point.

`GET /health` reports `llmProvider` and `llmTiers` (each tier's resolved model
**and which env var supplied it**), so the active configuration is verifiable
without shell access.

## Accessibility — non-negotiable

User is red/green colour-blind. **NO GREEN ANYWHERE.**
- Blue `#2563eb` = up / long / positive / BUY
- Red `#dc2626` = down / short / negative / SELL

`scripts/check-no-green.sh` enforces this in CI.
