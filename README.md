# bot-trade

Deterministic Fibonacci 61.8% fade trading agent for cTrader, with a 3-tab web control panel.

**How it decides:** entries are pure rules (no LLM) — fractal swing detection → 61.8% retracement zone → fade entry with SL beyond the swing origin and TP at the swing end. Signals are evaluated on closed bars only, legs smaller than 3× ATR(14) are ignored, and a deterministic risk gate (`agent/services/risk.js`) sizes or vetoes every trade: Kelly-scaled volume, min R:R 1.5, daily loss cap, per-symbol re-entry cooldown, margin/exposure checks. Claude is used only to monitor open positions and run weekend gap checks.

## Architecture

| Piece | Where | What |
|---|---|---|
| Web UI | `src/` → Vercel | 3 tabs: **Trade** (signals, positions, risk log), **Tune** (toggles, risk limits, watchlist), **Connect** (agent + cTrader wiring) |
| Agent | `agent/` → any Node host | 5-minute loop: fib scan → risk gate → cTrader order → position monitor. SQLite state, Express API |
| cTrader proxy | `api/ctrader.js` → Vercel | OAuth + browser-side order/data proxy |
| Backtest | `agent/scripts/backtest-fib.js` | Walk-forward test of the exact production rule |

## Run

```bash
npm install
npm run dev              # UI dev server on :5173
npm run build            # production build
npm test                 # vitest unit tests
npm run check:no-green   # accessibility gate

cd agent && npm install && node index.js   # agent on :3001
```

## How to test (in order — each stage proves one layer)

1. **Unit tests**: `npm test`.
2. **Agent boots locally** — create `agent/.env`:
   ```
   AGENT_SECRET=pick-any-secret
   ANTHROPIC_MAP_KEY_API=sk-ant-...   # only used for position monitoring
   CTRADER_CLIENT_ID=...              # register an app at openapi.ctrader.com
   CTRADER_CLIENT_SECRET=...
   ```
   `node agent/index.js`, then `curl http://localhost:3001/health` → `status: ok`.
3. **UI connects** — open the UI → **Connect** tab → URL `http://localhost:3001` + secret → *Test connection* → `REACHABLE`.
4. **cTrader demo account** — get a demo token from the Spotware OAuth playground; Connect tab → push token + `ctidTraderAccountId` (leave "Live" unchecked); save a symbol map (e.g. `{"EURUSD": 1}` — IDs vary by broker); Tune tab → add symbols, set balance.
5. **Scan pipeline** — Trade tab → *Scan now*. Signal rows = pipeline works; "No 61.8% reaction zone found" = works, no setup; `SCAN ERROR: ...` = credentials/symbol-map problem.
6. **Validate the edge** (do not skip):
   ```bash
   node agent/scripts/backtest-fib.js --symbol EURUSD --all-timeframes --bars 3000
   ```
   Replays the exact production rule with next-open fills, 0.02% round-trip cost, SL-before-TP sequencing. **If 4h/1d don't show a positive profit factor, don't arm autotrade.**
7. **Dry-run** — leave Autotrade OFF for several days; watch signals and risk-manager decisions on the Trade tab against the live market.
8. **Demo autotrade** — arm Autotrade (demo account only). Real order flow, fake money. Go live only after weeks of demo P&L agree with the backtest.

## Env vars

| Var | Where | Purpose |
|---|---|---|
| `AGENT_SECRET` | agent | Bearer auth between UI and agent (required) |
| `ANTHROPIC_MAP_KEY_API` | agent + Vercel | Claude API — position monitor / weekend checks |
| `CTRADER_CLIENT_ID` / `CTRADER_CLIENT_SECRET` | agent + Vercel | Spotware Connect OAuth2 app |
| `VITE_AGENT_URL` / `VITE_AGENT_SECRET` | Vercel (build) | Default agent connection (overridable per-browser on the Connect tab) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | agent | Optional signal/trade alerts |
| `DB_PATH` / `PORT` / `FRONTEND_URL` | agent | SQLite path, listen port, CORS origin |

Access token + account ID are pushed at runtime via the Connect tab and stored in the agent's SQLite DB.

## Accessibility — non-negotiable

User is red/green colour-blind. **NO GREEN ANYWHERE.**
- Blue `#2563eb` = up / long / positive / BUY
- Red `#dc2626` = down / short / negative / SELL

`scripts/check-no-green.sh` enforces this in CI.
