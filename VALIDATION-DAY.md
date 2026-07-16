# Validation Day — one-day live checklist (v0.1.142 → v0.1.151)

Eleven releases shipped without a live observation. This is the payback day:
every feature earns a ✅ only from a REAL observation on the demo account
(5306502). No new features until this page is done.

## 0. Precondition — is the code actually live? (2 min)

- [ ] Railway → latest deploy built from the current `main` head commit.
      **If not, redeploy — nothing below counts until this passes.**
- [ ] App footer shows the matching version; Telegram `/status` answers.

## 1. Status truth (5 min, once)

- [ ] Desk status strip and Tune → Pipeline agree on Autotrade ON/OFF
      (flip it once on Tune; Desk chip follows within 20 s, and vice versa).
- [ ] `⏳ PENDING ARMED` chip shows on Desk while pending mode is armed.

## 2. Broker-true P&L (5 min, once)

- [ ] Desk "At the broker": every net P&L matches the cTrader app to the
      cent (incl. swap/commission breakdown line).
- [ ] "Closed at the broker — 7d" realised total matches cTrader History.
- [ ] After that first fetch: Tune → Pipeline timeframe table shows real
      WIN/LOSS cells (net_pnl backfilled — no more blank history).

## 3. Sizing engine (5 min, once)

- [ ] Watchlist "Auto lots" shows sane numbers for EVERY row — specifically
      USDJPY and NATGAS are numbers, not vetoes (both had sizing bugs).
- [ ] Risk decisions log: the next USDJPY/NATGAS evaluation shows a real
      `usd_per_lot` figure in its note, not `usd_per_lot_unknown`.

## 4. Profit Keeper — the day's centrepiece (arm in the morning)

- [ ] Tune → Pipeline → arm Profit Keeper (adaptive defaults, manual scope).
- [ ] Within one loop cycle the risk/action log records a KEEPER pass
      (no errors in Railway logs).
- [ ] On a manual position whose profit clears ~1×ATR: 🔒 Telegram ping
      arrives AND the new SL is visible in the cTrader app (broker-side).
- [ ] The SL only ever moves in the protective direction across the day.
- [ ] If a trail/lock is hit: position closes in profit; 💰 ping; the deal
      appears in "Closed at the broker" with correct net.

## 5. Per-position Manage sheet (10 min, once, small size)

- [ ] Open Manage on a 0.01-lot position: Modify/Protect/Chart/Details all
      render; live dot pulses during market hours.
- [ ] Set a native SL via Protect → visible in cTrader immediately.
- [ ] (Optional, tiny position) Close via the sheet → fills, logs, pings.

## 6. Autopilot & pending orders (passive — just observe)

- [ ] Autopilot (if mode ≠ off): tonight's run produces a report under
      Past reports — first evidence the revived engine works end to end.
- [ ] EURUSD pending limit still resting at the broker with correct params.
- [ ] **C++ first-fill watch** (open since the handover): if ANY bot order
      fills today, check Risk decisions for the `OK` line and cTrader for
      the position — that closes the oldest open item.

## Recording

Note failures with a screenshot + timestamp. One failure = one fix PR;
do not batch. At day's end the summary goes back into TRAVEL-HANDOVER.md
(§5) as either ✅ validated or a named open item.
