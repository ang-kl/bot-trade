# Sydney, Tokyo and Hong Kong preparation — 5 October 2026

Verified through 4 October, 19:30 SGT. The approved bot release is running and its existing six-hour pre-open scan is active. **Per-account order readiness is Not Verifiable:** authenticated account-owned instrument, calendar, quote, assessment and queue snapshots remain unavailable. No new order setup or schedule is claimed.

| Cash-market reference | Pre-open / order acceptance (SGT) | Opening / continuous trading (SGT) | Calendar check |
|---|---|---|---|
| Sydney / ASX | 04:00 | Auction 06:59:00 in a randomised 15-second window; continuous from 06:59:45 with randomised 15 seconds | 5 October is absent from ASX’s 2026 closed-day list |
| Tokyo / TSE | 07:00 | Morning 08:00–10:30; afternoon 11:30–14:30 | Next published October closure is 12 October |
| Hong Kong / HKEX | 09:00–09:30 | Morning 09:30–12:00; afternoon 13:00–16:00 | Monday weekday rule; 5 October absent from official 2026 public holidays |

Sydney is on AEDT (UTC+11) on this date. Tokyo is UTC+9; Hong Kong and Singapore UTC+8. These are exchange cash references. Broker CFDs, FX and futures require their own account/instrument calendar; exchange opening times cannot certify them.

Official sources captured with URLs, receipt times and SHA-256 hashes in [market-reference](market-reference/):
- [ASX cash hours](https://www.asx.com.au/markets/market-resources/trading-hours-calendar/cash-market-trading-hours) and [2026 calendar](https://www.asx.com.au/markets/market-resources/trading-hours-calendar/cash-market-trading-hours/trading-calendar).
- [JPX trading hours](https://www.jpx.co.jp/english/equities/trading/domestic/01.html) and [market holidays](https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html).
- [HKEX securities hours](https://www.hkex.com.hk/Services/Trading-hours-and-Severe-Weather-Arrangements/Trading-Hours/Securities-Market?sc_lang=en) and [Hong Kong’s gazetted 2026 holidays](https://www.gov.hk/en/about/abouthk/holiday/2026.htm).

Existing preparation path:
1. The enabled scan universe narrows during weekend quiet hours, admitting crypto and symbols whose stored broker weekly schedule says their own next open is within six hours. Current logs show 1 of 60 symbols selected. Spike-priority crypto scans are an additional observed path.
2. Quiet hours end Monday 01:00 SGT. **This is a quiet-window boundary, not a broker opening time.**
3. The pre-open selection reads name-keyed `symbol_hours`. Actual entry admission reads the account’s own broker calendar, including holidays; UNKNOWN refuses entry. Current 0/0 holiday semantics are the already-resolved full local day, with the holiday’s own zone and DST.
4. The old pending-order and closed-market-limit producers remain retired. The scan does not rest new closed-market limits. Existing momentum/manual producers retain their own admission and ownership.
5. Any pre-open structure must be reassessed against fresh broker quotes/bars and the existing strategy, conviction, costs, SL/TP1, sizing, reservation and native-currency risk checks at the actual broker open.

Current scope uses existing registered instruments/accounts/settings, pending any owner correction. No scanner registry, arming, risk, funding or broker action was changed.

| Account | Broker host / currency from logs | Observed constraint |
|---|---|---|
| 46130058 | demo / USD | Margin headroom USD 11,075.01; four open positions |
| 47790949 | demo / USD | Margin headroom USD 10,466.92; four open positions |
| 46979908 | demo / USD | Margin headroom USD 274.68; two open positions |
| 43097342 | demo / SGD | FX rate unavailable for logged dispatch; one open position |
| 42993489 | live / SGD | FX rate unavailable; momentum not armed; no open positions |
| 43002148 | live / USD | Unfunded; momentum not armed; no open positions |
| 43069009 | live / USD | Unfunded; momentum not armed; no open positions |

Logged `tsmom_long` runs on four demo accounts. All 11 open positions have fresh SL/TP1 protection receipts. Available margin is not permission to bypass another gate. Full current Scan/Analyse/Trade settings still need authenticated reads.

The guardian watchlist contains AUS200, JPN225, HK50, CHINAH, regional FX names and Hong Kong equities. Its global 9 held names and 250 watchlist-only names do not establish account-owned broker IDs or entry enablement. [market-readiness.json](market-readiness.json) preserves those references with readiness and queue receipts explicitly unknown.

The remaining input is secure read access:
- Network HTTPS works with authorised network permission and the configured proxy.
- `GET /state/accounts` without a read credential returned **401 Unauthorized**.
- Cloud spec revision 13 reports no configured secret bindings.
- Configure `AGENT_SECRET_READ` through secure environment credential settings; never put the value in chat.
- Then run `python collect-readiness.py --out app-read-snapshots` in an authorised network-enabled command. The collector uses GET only, preserves the proxy, rejects redirects, bounds each response and records errors/cuts instead of interpreting them as zero. Its syntax has been checked; authenticated collection has not run.
- An optional `--identities` file accepts audited `[{"account":"46130058","symbolId":123}]` values. Supply IDs from the account’s own current map. No alias or global-map substitution is made.

Required next receipt per target instrument: registered account/host/symbolId, enabled cells, calendar observation/version/expiry/holiday/DST and next open, quote/bar timestamps and current costs, native-currency funds/FX and risk decision, durable setup/queue ID, and a fresh reassessment at open. A natural eligible broker fill needs its own protection/reconciliation receipt.

No authenticated assessment/queue receipt exists in this handback. Historical unknowns and natural market-event acceptance remain open.
