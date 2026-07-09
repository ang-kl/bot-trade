# abot v2 — Handover

> **Fresh-chat instructions**: Read this file in full before taking any action. Do **not** re-litigate the decisions below — they are locked. Start at **Phase 0**. Before creating the new repo in Phase 1, ask the user to confirm the name. Before Phase 6, ask the user for the X API bearer token.

## Goal
Clean-slate rebuild of `ang-kl/abot`. Less code, higher quality. Replace 9 cluttered pages with one **Agent Feed** (Google-News story cards) + one **Settings** page (4 tabs).

## Locked decisions (do not re-ask)
- **New repo**: `abot2` (ask before creating)
- **Archive v1**: commit `abot-v1-final.zip` + tag `v1-final` to `ang-kl/abot` branch `claude/clone-abot-project-jHwU6`
- **Port from v1**: cTrader integration, sub-agent prompts, indicator math
- **News**: X API v2 Basic (`X_API_BEARER_TOKEN`)
- **Stack**: React 19 + Vite 8 + Tailwind 4 + Vercel (same as v1)

## Three keepers (copy from v1)
| From v1 path | To v2 path |
|---|---|
| `api/ctrader.js` + `server/ctrader-monitor.js` | same paths, strip dead code |
| `src/lib/indicator-calc.js` | same path, add vitest suite |
| `api/advisor.js` L231–620 (4 sub-agents + lead 5W1H prompt) | split into `api/prompts/*.txt` |

## Hard rules
- **NO GREEN** anywhere (user is red/green colour-blind). Blue `#2563eb` = up/long/BUY, Red `#dc2626` = down/short/SELL.
- **Demo-only** by default. Server refuses `isLive:true` unless explicit.
- **No file > 300 lines**. No component > 5 props. YAGNI strict.
- **Target**: ≤ 8k lines total (v1 is ~22k).
- Every LLM call = its own file in `api/prompts/`.

## 8 phases
0. **Archive v1** — `git archive` → zip → commit → tag `v1-final` → push.
1. **Scaffold** — create `abot2` repo, Vite app, folder tree below.
2. **Port the 3 keepers** — cTrader, indicators, prompts. Unit-test each.
3. **Design system** — `common/Card, Badge, Button, Input` + `theme.jsx` (4 themes: Dark / Light / Sepia / System).
4. **Settings page** — 4 tabs: cTrader (OAuth + account), Watchlist (drag-edit, per-symbol sub-agent toggles), News (X bearer + cashtags), Risk/Guard (arm, daily caps).
5. **Agent Feed page** — story cards (WATCHING / PENDING / LIVE / WON / LOST / CANCELLED) + sticky Agent Brief + Ask Dock (reuses `/api/chat`). Pure `lib/story-builder.js` maps `(position, execState) → story`. Actions wire to existing `place-order` / `amend-position` / `close-position`.
6. **X API v2** — `api/news-x.js`, 5-min LRU cache, monthly counter, keyword sentiment (no LLM per tweet), injected into `news-analyst` prompt.
7. **Vault + Backtest** — minimal. localStorage preset + CSV stats (8 metrics, no chart).
8. **Quality pass** — CI grep for `green|#10b981|#22c55e`, line-count gate, all themes, mobile 375px.

## Folder tree
```
abot2/
  api/{ctrader,advisor,news,news-x,chat}.js
  api/prompts/{news-analyst,technical-analyst,history-reviewer,macro-analyst,lead-agent}.txt
  server/ctrader-monitor.js
  src/pages/{Feed,Settings,Vault,Backtest}.jsx
  src/components/AgentFeed/{StoryCard,AgentBrief,AskDock,ProgressBar,TimelineStrip,TightenSLDialog,Editorial}.jsx
  src/components/Settings/{CTraderTab,WatchlistTab,NewsTab,RiskTab}.jsx
  src/components/common/{Card,Badge,Button,Input}.jsx
  src/lib/{indicator-calc,ctrader-client,story-builder,theme,strategy-store}.{js,jsx}
```

## Env vars (Vercel)
`CLAUDE_API_KEY`, `CTRADER_CLIENT_ID`, `CTRADER_CLIENT_SECRET`, `X_API_BEARER_TOKEN`, `DATA_LAYERS_SECRET`

## Story card anatomy (Feed page)
```
▲ BOUGHT 0.01 BTCUSD at $67,245
Agent • 3 min ago • Confidence 8/10

<2-3 sentences from position.reasoning.why + thesis>

SL 66,745 ──●── TP 68,100   now 67,310  +$0.65  31%→TP
[⏹ Stop] [? Why] [⇧ Tighten SL] [⋯]

▸ Live updates (executionLog filtered by symbol)
```

## v1 reference
- Repo: `ang-kl/abot` @ branch `claude/clone-abot-project-jHwU6`
- Live: `https://cbot-trade.vercel.app`
- Demo account: Pepperstone 5203012
- `CLAUDE.md` in v1 root has full v1 context if needed

## First action for cBot 03 chat
Start **Phase 0**: archive v1 as `abot-v1-final.zip`, commit it to the current branch, tag the commit `v1-final`, and push. Then pause and wait for the user to confirm before starting Phase 1.
