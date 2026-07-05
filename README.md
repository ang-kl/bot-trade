# bot-trade

Agent-driven forex strategy builder — v2 clean-slate rebuild of `ang-kl/abot`.

This is the **Phase 1 scaffold**. See [`HANDOVER-V2.md`](./HANDOVER-V2.md) for the full plan and the 8-phase roadmap.

## Run

```bash
npm install
npm run dev          # Vite dev server on :5173
npm run build        # Production build
npm test             # Vitest unit tests (indicators)
npm run check:no-green   # Accessibility gate
```

## Status

| Phase | Section | Status |
|---|---|---|
| 0 | Archive v1 | done in `ang-kl/abot` |
| **1** | **Scaffold + 3 keepers** | **this repo** |
| 2 | Keeper integration tests | TODO |
| 3 | Design system (`common/Card,Badge,Button,Input` + theme) | TODO |
| 4 | Settings page (4 tabs) | TODO |
| 5 | Agent Feed page | TODO |
| 6 | X API news client | TODO |
| 7 | Vault + Backtest | TODO |
| 8 | Quality pass | TODO |

## Stack

- React 19 + Vite 8 + Tailwind 4
- Vercel serverless functions in `api/`
- cTrader Open API (Spotware Connect)
- `@anthropic-ai/sdk` for sub-agent + lead orchestration
- Vitest for unit tests

## Env vars (Vercel)

| Var | Purpose |
|---|---|
| `ANTHROPIC_MAP_KEY_API` | Claude API |
| `CTRADER_CLIENT_ID` | Spotware Connect OAuth2 |
| `CTRADER_CLIENT_SECRET` | Spotware Connect OAuth2 |
| `X_API_BEARER_TOKEN` | X API v2 Basic |
| `DATA_LAYERS_SECRET` | shared secret for cron data fetchers |

## Accessibility — non-negotiable

User is red/green colour-blind. **NO GREEN ANYWHERE.**
- Blue `#2563eb` = up / long / positive / BUY
- Red `#dc2626` = down / short / negative / SELL
- White background

`scripts/check-no-green.sh` enforces this in CI from day one.
