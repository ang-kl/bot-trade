# Risk page revamp — phone first (10-10-2026)

Claude · № 12,812 10-Oct (ordered № 12,810 · owner "go ahead, merge when green and send the screenshots"; claude-builder).
Mockup (private Artifact): https://claude.ai/artifact/NcR9KyX4H4DcqvdpCanjn1

## Task (owner, TIOAMCC)

- **Task:** revamp https://sg-trade.up.railway.app/risk; refer to the Performance page's "Accounts — capital safety" card and three Risk page cards.
- **Invariant:** change the UI, not the logic.
- **Output:** new UI today.
- **Material:** sourced from professional practice, for a small phone.
- **Close:** the new Risk page, merged and deployed.

## What changed

| Area | Before | After |
|---|---|---|
| Top of page | Scope pill row wrapped over 4 lines on a phone, then a wide table | Header with save state and section jumps; **Capital safety now** first, one row per account, most at risk first |
| Capital safety | Only on Performance | Also here: engine daily stop, % used bar with OK/WARN/BREACH words, money left today, "stop larger than the balance" warning |
| Advice ("Settings vs the Record") | Raw commands on screen; a no-value proposal printed `perTradeRiskPct: null` | Worst first; command in a closed panel; no command for a no-value proposal; the engine's own daily stop shown beside advice whose arithmetic uses a different cap |
| Account overrides | "41 ACCOUNT OVERRIDES" then a run-on line with `[object Object]` | "41 pinned · 2 differ from Global", the two differences listed with the Global value, the rest under a disclosure |
| Daily stop tile | Draft formula (no floor, no tiers): $150 on …7342 | With an account selected: the engine's reading (USD 400, floor) |
| Editors | 3-column desktop grid (270 / 1fr / 270) | 2 columns from 1024 px (day limits + protection · bot risk + account inputs + C++), 1 column below |
| Compare table | Setting column crushed to one letter per line | Setting column stays put, short account labels (…7342), values wrap, "Only rows that differ" view filter |
| Danger zone | Close-all at the very bottom of the middle column, Reset inside the day-limits card | Both together at the foot, never deferred, both confirm first (same handlers) |
| Immediate switches | Only a tooltip said they apply on tap | Visible "applies immediately" label |
| Unsaved edits | One line inside the protection card | Pinned bar listing every form with unsaved edits, with a jump to each |
| Type and touch | 9.5 px body | 15 px body and 44 px targets below 1280 px; desk tier unchanged |

Display bugs fixed in the shared formatter (`src/lib/risk-format.js`): margin level floor printed **20000%** (stored 200 = 200%), min SL distance printed **15%** (stored 0.15 = 0.15% of price), headroom per position printed **0.3333333333333333** (33.33%), object values printed **[object Object]**.

## Invariants

| Invariant | Result |
|---|---|
| Every write route, payload and key list unchanged | **Passed** — every `agentPost(...)`, `saveRisk([...])`, anchor and `window.confirm` text extracted from old and new `Risk.jsx`: 68 = 68, identical |
| Every setting has a control and an anchor | **Passed** — `risk-anchors.test.js` (every proposable key and every summary-table key lands on a field) |
| Advice stays read-only, no Apply | **Passed** — `config-proposals.test.jsx` (no `<button`, no "apply") |
| Demo/live read only for display badges | **Passed** — `one-account-model.test.js`, one new badge entry for `src/lib/risk-status.js` |
| No horizontal page scroll at 390 / 844 / 744 / 1133 / 1440 px | **Passed** — measured with real data, `scrollWidth − innerWidth = 0` at each |
| No write left the browser while screenshots were taken | **Passed** — harness answered every agent call with the read secret and refused any non-GET: 0 attempted |
| Each new display rule can fail | **Passed** — three mutations (whole-percent set emptied, null-proposal guard removed, stop-vs-balance flag removed), each red on a named test, files restored |

## Found while drawing the mockup — logic, not fixed here

1. `GET /state/config-proposals` computes its daily cap as balance × dailyLossPct and ignores the floor and tiers: it says 61.25 on …7342 where the engine enforces USD 400, and its DANGER on …0949 compares a 990.00 loss with 857.04 where the engine cap is 1,714.08.
2. …3489's daily stop (USD 200 floor) is larger than its whole balance (USD 40.10), so it can never stop that account.
3. …7342's overlay has the per-position loss cap OFF and the profit ratchet halt-only, while Global has both ON.
4. `GET /state/risk-full?account=43097342` returns no balance (currency_mismatch: SGD account, USD sizing input), so the money tiles show dashes.
5. BTCUSD cannot be opened on …7342 at all: the minimum lot needs ~413 USD margin at the 1:2 crypto rate, above the one-third headroom share (≤ 319 even with nothing open).

## Professional sources used

Patterns: limit / used / remaining shown together (TopstepX distance to MLL; TradingView margin buffer); the stop as a level with its reset time (FTMO); graded states with stated thresholds (IBKR TWS margin colours, cTrader Mobile 200% margin dot, Basel three-zone traffic light); exception-first single screen (Stephen Few; BCBS 239 ¶58); linear utilisation bars, not gauges (Few's bullet graph); no wide matrix on a phone, sticky first column, "show only differences" (NN/g mobile and comparison tables); two disclosure levels at most (NN/g); read-only advice separated from writing controls (IBM Carbon, NN/g); 44 pt / 48 dp targets and 17 pt body (Apple HIG, Android); status never colour alone and 3:1 for graphics (WCAG 2.2 SC 1.4.1, 1.4.3, 1.4.11, 2.5.8).

1. FTMO, Trading Objectives — https://ftmo.com/en/trading-objectives/
2. Topstep Help, TopstepX — https://help.topstep.com/en/articles/14434175-topstepx
3. TradingView, Account manager — https://www.tradingview.com/support/solutions/43000786138-what-is-the-account-manager/
4. cTrader Help, cTrader Mobile FAQ — https://help.ctrader.com/ctrader-mobile/faq/
5. Interactive Brokers, Real Time Activity Monitoring — https://www.interactivebrokers.com/en/index.php?f=846
6. BCBS 239 — https://www.bis.org/publications/201301-guidelines-principles-effective-risk-data-aggregation-and-risk-reporting.pdf
7. BCBS backtesting traffic light (1996) — https://www.bis.org/publications/199601-standards-supervisory-framework-use-backtesting-conjunction-internal-models-approach-market-risk-capital.pdf
8. Stephen Few, Bullet Graph Design Specification — https://www.perceptualedge.com/articles/misc/Bullet_Graph_Design_Spec.pdf
9. NN/g, Mobile Tables — https://www.nngroup.com/articles/mobile-tables/
10. NN/g, Comparison Tables — https://www.nngroup.com/articles/comparison-tables/
11. NN/g, Progressive Disclosure — https://www.nngroup.com/articles/progressive-disclosure/
12. IBM Carbon, Status indicator and Read-only patterns — https://carbondesignsystem.com/patterns/status-indicator-pattern/
13. Apple HIG, Accessibility — https://developer.apple.com/design/human-interface-guidelines/accessibility
14. Android, Touch target size — https://support.google.com/accessibility/android/answer/7101858
15. W3C, WCAG 2.2 — https://www.w3.org/TR/WCAG22/

Not verified: FTMO's MetriX screen layout, IBKR Mobile margin screens (403), Material 3 pages (JavaScript-rendered).
