# Trade Cockpit — data endpoint spec

Status: **proposed, not built.** Written 2026-07-26 after the owner's
instruction that the cockpit must compute its display rather than show
static/demo data.

This document covers only the panels that **cannot** be made real from data the
app already has. Everything listed under "already real" below is live today and
needs nothing from this spec.

---

## 1. What is already real (no endpoint needed)

Handed over in-memory by the clicking surface (`cockpit-nav.bindPosition`):

| Panel / field | Source |
|---|---|
| symbol, side, lots, strategy | `/state/positions` row / broker position |
| entry, current SL, current TP | same |
| live price, live P&L | same (broker snapshot, ~30s) |
| signed R, R rails, PRICE·R tape | computed from entry/SL/price + side |
| IF SL / NOW / IF TP outcome strip | dollars-per-R from live P&L ÷ current R |
| market-open state, closed-market freeze | `market_open` (symbol_hours) |
| **FLEET** | **computed** — `cockpit-fleet.js` over the account's other open positions, R each, ordered by \|R\|, truthful `top N of M` |
| **MFE / MAE** | `monitored_positions.mfe_r` / `mae_r` when the surface supplies them |

## 2. What is still demo, and why

| Panel | Needs | Exists in DB today? |
|---|---|---|
| MFD chart (flown path) | OHLC bar history for the symbol since entry | **No** — bars are fetched per scan and not retained per position |
| EMA 9/20/50, VWAP | same bar history | No |
| Volume profile (POC / VA / LVN) | volume-by-price over those bars | No |
| PRICE·15m candles | last ~30 bars at 15m | No |
| TCAS traffic + MARKET SAYS | pairwise correlation of this symbol vs others | Partially — `/state/correlation` returns clusters, not pairwise coefficients vs one symbol |
| RVOL | current volume vs 20-bar average | No (needs bars) |
| Spread | live bid/ask spread vs backtest assumption | Sidecar has `SpotFeed`; not exposed per symbol |
| Latency | broker round-trip | Sidecar knows; not exposed |
| Tweak journal timeline | **an ordered history of position amendments** | **No — see §4, this is the real gap** |
| Armed actions | the profit-keeper's armed rules for this position | Partially — `monitored_positions` has `be_moved`, `scaled_out` flags but not "what is armed next" |
| Invalidation watch | live evaluation of each abort condition | Partially — `thesis_status`, `invalidation_trigger` are real strings; the per-condition checks are not stored |

## 3. Proposed endpoint

```
GET /api/positions/:id/cockpit?bars=15m&lookback=48h
Authorization: Bearer <AGENT_SECRET | device session>
```

`:id` — **decide the id space first.** Desk keys the cockpit by the *broker*
position id; the Performance tables key it by the `/state/positions` DB row id.
The route must accept one and document it; suggest the DB row id with
`?brokerId=` as an alternative lookup, since the DB row is the durable record.

### Response

```jsonc
{
  "position": {                  // already available; echoed so a cold deep
    "id": 4242,                  // link (no in-memory binding) still works
    "accountId": "43097342",
    "symbol": "0002.HK", "side": "BUY", "volume": 1092,
    "entry": 76.85, "sl": 76.325, "tp": 79.4,
    "price": 77.29, "pnl": 4.34, "openedAt": "2026-07-23T10:07:00Z",
    "marketOpen": true, "exchange": "HKEX", "nextOpenAt": null,
    "strategy": "vwap_trend", "digits": 2,
    "mfeR": 1.42, "maeR": -0.31,          // monitored_positions
    "thesis": "...", "thesisStatus": "intact",
    "invalidationTrigger": "..."
  },

  "bars": {                      // §2 rows 1-4, 6: the single biggest unlock
    "timeframe": "15m",
    "since": "2026-07-23T10:07:00Z",
    "rows": [{ "t": 1785000000000, "o": 76.9, "h": 77.1, "l": 76.8, "c": 77.0, "v": 1234 }]
  },

  "indicators": {                // server-computed so the client never
    "ema9": [76.9, 77.0],        // reimplements the agent's own maths
    "ema20": [], "ema50": [], "vwap": [],
    "rvol": 1.4,                 // current vs 20-bar average
    "volumeProfile": {           // POC / VA / LVN, price-bucketed
      "buckets": [{ "price": 77.25, "volume": 8123 }],
      "pocPrice": 77.25,
      "valueAreaLow": 77.05, "valueAreaHigh": 77.45   // 70% of volume
    }
  },

  "execution": {                 // sidecar-owned facts
    "spreadNow": 0.02, "spreadBacktest": 0.015, "latencyMs": 42
  },

  "tweaks": [                    // §4 — requires the new table
    { "at": "2026-07-23T14:20:00Z", "kind": "sl_moved",
      "from": 76.10, "to": 76.85, "reason": "trailing rule after +0.8R",
      "rAt": 0.82, "bar": { "o": 77.0, "h": 77.2, "l": 76.9, "c": 77.1 } }
  ],

  "armed": [                     // what fires next, from the profit keeper
    { "kind": "scale_out", "at": "+1R", "triggerPrice": 77.375, "progressPct": 62 }
  ],

  "invalidation": [              // per-condition live evaluation
    { "key": "rvol_floor", "label": "RVOL < 0.6×", "now": "1.4×", "ok": true }
  ],

  "correlated": [                // TCAS traffic + MARKET SAYS
    { "symbol": "HSI", "coefficient": 0.82, "window": "20d",
      "sameHeading": true, "trendBearing": 34 }
  ],

  "fleet": [                     // optional; the client already computes this
    { "positionId": 99, "symbol": "EURUSD", "r": 0.5 }
  ]
}
```

### Streaming

```
WS /api/positions/:id/cockpit/stream
```

Frames patch the payload rather than replacing it, so the cockpit never
re-animates a whole frame on a single tick:

```jsonc
{ "type": "tick",   "price": 77.31, "pnl": 5.10, "r": 0.24 }
{ "type": "bar",    "timeframe": "15m", "row": { "t": …, "o": …, "c": … } }
{ "type": "tweak",  "row": { … } }        // appended live
{ "type": "armed",  "rows": [ … ] }        // replaced wholesale
```

Cadence: ticks at most 1/s (coalesce), bars on close, tweaks on write.
Subscribe on open, tear down on close, and on a FLEET/TCAS swap close the old
socket **before** the new instrument's animations begin (BUILD-ORDER §7).

## 4. The one schema change this needs: `position_events`

The tweak journal is the only panel with **no recoverable source**.
`monitored_positions` keeps current flags (`be_moved`, `scaled_out`) and the
*latest* review (`last_check_at/action/reasoning`) — not a timeline.
`action_log` is a generic HTTP log (method/path/body). `decision_log` records
decisions *upstream of the risk gate* (scan skips, lesson cool-offs), not
amendments to a live position.

So a journal built from today's tables would either show scan skips mislabelled
as tweaks, or two boolean flags with no times. Both are worse than showing
nothing.

```sql
CREATE TABLE IF NOT EXISTS position_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL DEFAULT (datetime('now')),
  account_id   TEXT,
  position_id  TEXT,               -- broker position id
  trade_id     INTEGER REFERENCES trades(id),
  symbol       TEXT NOT NULL,
  kind         TEXT NOT NULL,      -- sl_moved | tp_moved | scale_out | trail_armed
                                   -- | trail_tightened | lot_trimmed | paused | resumed
  from_value   REAL,
  to_value     REAL,
  r_at         REAL,               -- R at the moment of the event
  price_at     REAL,
  reason       TEXT,               -- human sentence, same discipline as decision_log
  actor        TEXT,               -- autopilot | monitor | trail_engine | manual | telegram
  detail_json  TEXT
);
CREATE INDEX IF NOT EXISTS idx_position_events_pos ON position_events(position_id, at);
```

Write sites (all must be non-throwing, same rule as `recordDecision`):

- `profit-keeper` — every SL ratchet, scale-out, trail arm/tighten
- `loop.js` broker-action executor — amend/close outcomes
- C++ `TrailEngine` — reports its ratchets back via the existing status route
  so Node records them (the sidecar must not write the DB directly)
- Telegram manual actions and the `/actions/*` routes

Retention: prune with the existing housekeeping sweep, same 90-day window as
`decision_log`; these are diagnostic, not bookkeeping.

## 5. Suggested build order

1. **`position_events` + write sites.** Independent of the endpoint, and it
   starts accumulating history immediately — the journal is empty until it
   does, so this should land first regardless of everything else.
2. **Bar retention per open position** (`bars` in the payload). Unlocks the
   chart, EMAs, VWAP, volume profile, PRICE·15m, RVOL and true MFE/MAE in one
   move — the largest single win.
3. **`GET /api/positions/:id/cockpit`** returning position + bars + indicators,
   with `tweaks` from step 1. Cockpit swaps its mock adapter for this and the
   DEMO DATA advisory shrinks accordingly.
4. **Execution facts** (spread, latency) exposed from the sidecar.
5. **Pairwise correlation** for TCAS/MARKET SAYS — needs a decision on window
   and source before it can be specced further.
6. **WebSocket** last: the cockpit already polls a frame every 2.2s, so the
   socket is a refinement, not a prerequisite.

Until each step lands, the corresponding panel stays demo **and says so** —
the amber DEMO DATA advisory in the cockpit names exactly which values are live
and which are not, and that list is derived from the data, not hardcoded.
