# bot-trade

> **Proprietary — all rights reserved.** This repository is public for reference only.
> No permission is granted to use, copy, modify or redistribute it; see [LICENSE](LICENSE).
> It places real orders and can lose money. No warranty, no liability, not financial advice.

A rules-based multi-strategy trading agent for cTrader: a Node service that decides, C++ sidecars that hold the broker sessions and execute, scanners that mirror the feed, and an independent verifier that audits every position. Entries and exits are deterministic; no language model sits in the trade path.

## Where things are

| Piece | Path |
|---|---|
| Node agent (decisions, risk gate, monitoring, API) | `agent/` |
| Web control panel | `src/` |
| C++ execution gateways and scanners | `cpp-exec/` |
| Independent position verifier | `cpp-verify/` |
| Plans, handovers, measurements | `docs/` |

## Read next

- The detailed README (architecture, controllers, safety systems, environment variables, model tiers): [`docs/1st_README.md`](docs/1st_README.md)
- The architecture page with every service, clock and protection layer: [`docs/architecture-2026-10-03.html`](docs/architecture-2026-10-03.html)
- Working rules for anyone changing this repository: [`CLAUDE.md`](CLAUDE.md)

## Run and test

```bash
npm install && npm run build          # web panel
cd agent && npm install && node index.js   # agent on :3001
npm run check:no-green                # accessibility gate
node --test "agent/**/*.test.js"      # agent tests
npx vitest run                        # web tests
```

The owner is red/green colour-blind: **no green anywhere** in the UI (blue = up/long, red = down/short); `scripts/check-no-green.sh` enforces it.
