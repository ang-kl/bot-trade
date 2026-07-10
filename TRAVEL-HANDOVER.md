# bot-trade — Travel Handover

**As of 2026-07-11 · v0.1.140**

You're away. The bot runs itself. This is your one page to control it and know
it's healthy — no laptop needed.

---

## 1. Control it from your phone (Telegram)

Message your bot:

- **/status** — the whole picture: what's scanning, strategies on, armed
  combos, working pending orders, open positions, balance, last error.
- **/pending** — resting limit orders with their levels + expiry.
- **/pause** — stop scanning + auto-trading (pending orders at the broker
  stay and expire on their own). **/resume** turns it back on.
- **/killall** — panic button: pause everything AND cancel all pending
  orders. (Open positions are NOT closed — do that in cTrader.)
- **/chart EURUSD 4h** — get a chart image back (add `+ai` for a written
  read). **/news XAUUSD** — scheduled news for a symbol.
- **/autopilot suggest|auto|off** — the nightly evidence engine (see §3).
- **/arm fib_618_fade GBPUSD 12h** — arm a combo by thumb.

You outrank the bot always: /pause and /killall win over everything.

---

## 2. What's live right now

- **Account**: DEMO 5306502 (the one with your manual NAS100/Cocoa trades).
- **Autotrade**: ON. **Pending orders**: ARMED on the evidence set —
  EURUSD (3d, 1d, 12h) · GBPUSD (1d, 12h) · USDJPY (3d) · NZDUSD (4h) ·
  MSFT.US (12h, 4h).
- **Execution engine**: C++ (`EXEC_ENGINE=cpp`). Orders, monitoring,
  cancels, and backtests all run in the compiled sidecar. Rollback anytime:
  delete `EXEC_ENGINE` on Railway → back to the JS path, identical behaviour.

**Expect quiet.** Your armed timeframes are 12h–3d candles. Zones confirm
every few *days*, not hours. A silent first day is normal. You'll get a
Telegram ping the moment anything is PLACED or FILLED.

---

## 3. Strategy Autopilot (turn on before you go)

Send **/autopilot suggest** (proposes, you approve by /arm) or **auto**
(arms/disarms itself, max 4 changes/run, announces each, refuses LIVE
accounts). Every ~24h it backtests all 5 strategies × your watchlist,
saves a **charted HTML report** (equity curves + plain-words GO/NO-GO
reasoning), and pings you. Reports: Tune → Backtest → Past reports.

---

## 4. When you land — 3-minute health check

1. Telegram **/status** — anything unexpected?
2. cTrader demo 5306502 → History — any fills? P&L?
3. App → Trade → Risk manager decisions — every placement/veto with reasons.

---

## 5. Honest open items (not blocking, logged)

- **First real C++ fill still unobserved** — parity is proven on flat
  accounts; the first live fill is the true test. Watch Risk decisions for
  an `OK` line.
- **USDJPY sizing veto** showed a suspect `usd_per_lot` for JPY quotes —
  it blocks (safe), never mis-sizes. Needs an audit.
- **News is informational only** — shown on alerts, never gates a trade.
- **monitored_positions not account-scoped** — after an account switch the
  bot's old positions can still gate briefly until they close.

---

## 6. If something looks wrong

- Bot silent / app "login expired" → Railway likely redeployed; re-login on
  the Connect tab (secret or Telegram code). Trading is unaffected by the
  UI login.
- Runaway behaviour → **/killall**, then **/pause**. Nothing is lost;
  everything resumes with /resume.
- Real emergency → close positions in the cTrader app directly. It always
  wins; the bot re-syncs to the broker every cycle.

_The risk log keeps every receipt. Safe travels._
