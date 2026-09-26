# Plan — sidebar, Reasons, AI page, Performance cards, strategy review and historical data (owner requests 1 and 2)

26-09-2026 · revised 03:15Z after two independent verifications (§12) · §13 performance traces added 03:25Z · §14 cTrader history and the 150-bar correction added 04:10Z

**PLAN — awaiting owner approval; nothing below is built.** It starts after the V3 work in flight. Which V3 items must land first is not verified here.

**Baseline:** code line numbers are at `6541c0f`. At 03:06:32Z production ran `9f44f97` (#1142, booted ≈02:55Z). Neither #1141 nor #1142 changes a claim below; #1142 shifts `Performance.jsx` by +7 lines (the top cards are `:2006-2011` there).

Times are UTC ("Z") unless marked SGT. "…0058" is account 46130058. PF is profit factor; R is profit in units of the risk taken.

---

## §0 The answer first

- **Request 1 — sidebar.** All three points are real (S1–S3).
  - "Shadow" shows the setting, not whether the shadow runs; today it is true by coincidence.
  - The version has read 0.1.381 since at least 29-07. "dev" means the website carries no build id; the site itself is current.
  - The picker steers every `/state` read. Moving it is D2.
- **Request 1 — Reasons and AI.**
  - Of 13 cards, 3 are sound, 4 mislead, 1 is empty and 5 belong elsewhere. Tables stop at 25 rows (Order lifecycle at 64).
  - AI is off (no key; $0 in 30 days), yet five places present it as running. One "AI" page, marked off.
  - **Two hazards go first (SAFE-0).** The manual-order confirm names no account. Re-Risk's Apply writes the global risk settings from a 58-day-old proposal made for another account (D6).
- **Request 2 — the two cards.** A headless render shows a ▾ on both. It is faint (its border shows only on mouse hover) and forgets its state on reload; on the blockers card it also resets on every account switch. Your phone may differ (D19). Make it visible, remembered and one standard.
- **Request 2 — the blockers table.** Times are **UTC with no label**, while the line above uses your phone's zone. Your 22:05–22:45 rows were **26-09, 06:05–06:45 SGT**. One shared table serves both requests: 15 rows, scrolling both ways, grouped by date in the page's zone, with repeats folded into expandable lines with a count.
- **Those rows are old, and not …0058's own.**
  - They were written before the attribution fix (#1115, 22:45:45Z on 25-09). They carry the agent's trading account, not the account you viewed, and they are the all-accounts check.
  - At 02:43:25Z all 2,673 rows in …0058's 24-hour table were such rows. Once they age out (≈26-09 22:46Z), the table would look empty while 4,410 roster-wide stops continue.
- **The strategies are OFF because you ordered it:** #958 (19-09) and #972 (20-09), applied by the boot seed. Your premise is half right. The code defaults arm ten of the thirteen and scan all of them, but a human turned these off, and nothing turns a cell back ON.
- **Your 25-09 restore of fib_confluence, rsi2_reversion and donchian_breakout was never built.** All 21 cells are OFF, and their order path (`scan_dispatch`) is retired.
- **"Why are you using them?"**
  - They are scanned, analysed and refused every minute. The shared list arms no account, but it decides which strategy gets the analysis slot.
  - The intended "shadow" **records nothing that can be scored**.
  - They also cost: ema_pullback sets every scan fetch to 450 bars, and cup_handle writes the largest table (716 MB).
- **The restore's evidence has changed (D10).**
  - On bot-dispatched trades, rsi2 has 49 closes at PF 0.59 in R and donchian 68 at 0.56. fib has 3.
  - The 19-09 basis (fib 26 closes at PF 2.72) and today's all-origin figure (fib 100, money PF 0.95) both count adopted and origin-less rows.
- **cpp-verify: wrong on the fact, right on the direction.**
  - It stores no prices; it independently checks closed deals.
  - Lookback is not short of storage, and **cTrader does not cap it at 150 bars**: the broker returns every bar we ask for (1,000 of 1,000 on a closed market; 449 of 450 on an open one, where the still-forming bar counts toward the total but never reaches us). 150, 450 and 1,000 are **our own settings**. The defects are in caching and in two strategies' windows. (See §14.)
  - Stored history belongs in Node.
- **No separate cpp service now.** Measure (Phase 0), fix the cache (S-3), and build a store only past a number you set (D18).
- **Performance traces (your mandate, §13).** Baseline measured through the Chrome DevTools MCP. The layout jumps on 9 of 10 page and profile runs (CLS 0.21–1.03; good is ≤ 0.1). Reasons takes 10.5 s to draw on a phone. The slowness is in the browser, not the server. Every website PR will carry a before-and-after trace (D20–D22).

---

## §1 Sources and method (P2, P4)

- **Code:** a read-only worktree at `6541c0f`, left clean; GitHub for history and #1142.
- **Production:** GET-only reads, all on a Saturday (only crypto trading):
  - seven lanes, 01:14–02:27Z: req1-recheck, perf-cards-ui (a headless render), blockers-data, strategy-off-forensic, strategy-catalogue, history-architecture and pipeline-first-step;
  - two verifiers, 02:41–02:58Z;
  - the reviser, 03:06Z.
- **Earlier work:** № 9,477.
- **Evidence populations.**
  - Strategy figures come from `/state/trades` (02:46Z; 1,323 closed).
  - "All" includes adopted and origin-less rows. `/state/attribution` itself calls those "NOT evidence of strategy edge" (699 of 1,323 are clean, 02:54:11Z).
  - "Bot" means origin `bot_*`.
  - On fib's rows the R and money figures disagree (12 wins by R, 23 by money). `realised_rr` is the suspect field (failure mode #6).
- **Reconciled:** rsi2 reads 77 closes on attribution and 83 on trades. Attribution groups by broker label; grouped the same way, the trades read also gives 77 at money PF 0.93.
- **Disclosure:**
  - The headless loads sent `GET /state/client-ping`, which is a write (`state.js:189`): presence records 01:16–01:35Z.
  - A stray `curl` file landed in the worktree and was moved out at once.
  - Two help.ctrader.com pages were fetched.

---

## §2 Request 1: sidebar, Reasons, AI page, K3

### S1 — "ENTRIES · Time-based entries · shadow"

- **"Shadow" is the setting.** The line renders the stored observation setting (`EngineStatusLine.jsx:23`), seeded once from `tick-observation.json`.
  - The server's `shadowReady` (`tick-readiness.js:175-178`) reaches the sidebar's store (`use-engine-status.js:32`), but the line never reads it. Only `ControllerRuntime.jsx:116` does.
  - All 7 shadows ran at 02:41:35Z.
- **It follows the traded account**, not the viewed one (`ActiveAccountHeader.jsx:165`).
- **A missing record** is served as a default TIME_BASED record flagged `stored: false` (`entry-mode.js:116`). The line ignores the flag. This is latent.
- **No manual/auto.** All 7 accounts are `manual` (02:41:37Z), so the bot's tick switch (principle 2) is off everywhere.
- **Live bug.**
  - Viewing another account adds `?account=` to the readiness read (`agent-api.js:224-231`). The server returns one object (`state.js:2788`), but the panel expects a list (`EngineStatusPanel.jsx:264`).
  - Every row loses its blocker badge and reasons, and Tick disables.
  - This is invisible today, because all 7 accounts are blocked by 4 checks (02:41:35Z).

**Proposal:**
- **S1a:** `engineReadinessFor` accepts the single object (the route has no `account=all` form).
- **S1b:** the line shows manual or auto, "shadow running" or "declared, not running: ‹reason›", the blocker count, and "no record".

**Decision:** D1.

### S2 — "v0.1.381 · dev"

- **Stale number.** `package.json:45` has read 0.1.381 since at least 29-07 (#490). No later commit changed it.
- **Why "dev":**
  - the build omits `.git` (`.dockerignore:8`);
  - stage 1 declares no commit `ARG` (`Dockerfile:25-30`);
  - `vite.config.js:17` reads only `VERCEL_GIT_COMMIT_SHA` or `GIT_COMMIT_SHA`.
- **False warning.** `'dev'` is truthy, so the health panel always reports a web/agent mismatch (`agent-health-view.js:33-53`).
- **"Is the build updated?" Yes.**
  - The site is built in the agent's image, so it runs the deployed commit unless a browser holds an old bundle.
  - The agent reads `RAILWAY_GIT_COMMIT_SHA` at runtime. Whether Railway passes it at build time is not verified.

**Proposal:**
- `ARG RAILWAY_GIT_COMMIT_SHA` in stage 1, read by `vite.config.js` through a tested helper.
- `dev` reads as "unknown".
- Show "web ‹sha› · agent ‹sha›".

**Decision:** D3.

### S3 — the "VIEWING" picker

- **Where it sits:** above every menu group (`App.jsx:294-300`).
- **What it steers:** every `/state` read that names no account, sidebar reads included (`agent-api.js:225-226`). `/actions/*` requests are never steered.
- **Which pages follow it:**
  - Desk and Trade follow it directly.
  - Performance, Risk, Tune and Accounts have selectors that start from it. № 9,477 named only Performance.
- **Manual orders are not tied to it.** A manual order sends no account, and the confirm names none (`Trade.jsx:620-633`). You can view …7342 while the order goes to the trading account.

**Proposal (a):**
- Put the picker under TRADING (Trade, Risk, Reasons).
- Sidebar reads stop following it.
- The confirm names the destination account now (SAFE-0a).

**Decision:** D2.

### RS-1 — Reasons, card by card (01:18–01:21Z; re-read 02:49Z)

Renamed from R1, to avoid confusion with V3 R1 (#1130) and R2 (#1137).

| Card | Verdict | Proposal |
|---|---|---|
| Entry intents | Sound: 0 unknown. Per-account counts are hidden as "3 fields"; the symbol is blank on 50 of 50 rows | Show the per-account table and the symbol |
| Trade plans | **Misleading.** 28 of 50 are in the wrong unit, all from the old adopter (15–24 Sep). 35 bot closes have no plan | Flag the bad rows; show coverage. The correction is D5 |
| Unknown P/L | Sound: 0 blocking, 19 written off | Absorb Unresolvable plan. Stop re-stamping written-off rows (`pnl-backfill.js:1013-1017`) |
| Unresolvable plan | Empty | Fold into Unknown P/L |
| Trade consistency | **False alarms.** All 4 flags are fees, or swap on #1449 | Compare gross P&L; name the fee or swap |
| Attribution | Shows 60.3% known; **hides** 225 of 567 unknown origins | Make the origin breakdown the headline |
| Refusal cost | **Windowed on scoring time.** The share moves as the scorer catches up: 33.8% at 01:18:50Z, 41.9% (4,469 of 10,656) at 02:49:15Z | Window on refusal time; merge with the veto breakdown |
| Order lifecycle | Sound | Put it first |
| Go-live readiness | **Misleading.** "Will make it: yes" against 15-08, while its verdict is NO | Remove (D4) |
| Phase audit | 100 of 100 rows are controller events | Move to Desk; split out switch flips |
| Exit counterfactual | Exit research | Move to Tune |
| Price suspects, open duplicates | Integrity checks | One "Ledger integrity" card |

**New order:** Order lifecycle, Entry intents, Trade plans, Unknown P/L, Trade origin, Ledger integrity, then "Vetoes: count and cost". Each heading names its scope.

**Corrections to № 9,477:**
- Scope chips have existed since #1041. The real defect is mixing all-account and one-account cards.
- One sample loaded the page in 0.91 s (01:21:35Z), against ~14 s.
- Refusal cost has no stable percentage.
- #1449 is swap, not fees.
- There are 14 tables, 7 of them cut short. The cut is 25 rows by default and 64 for Order lifecycle (`reasons-view.js:29`, `:51`).

**№ 9,477 items not carried until now:**
- **¶B·3, the Trade screenshot errors:** not verifiable, since there is no screenshot or log. *Inference:* "DEMO 5203012" is …0058's login (02:44:26Z), which fits S3.
- **¶B·4, "AI MONITOR: NOT VERIFIABLE":** this shows only when the browser's read fails (`LlmMonitorStatus.jsx:60-72`). The route answered 200 at 01:15:30Z, so the cause cannot be verified.
- **¶B·5, sidebar truncation:** the sidebar is 224 px wide (`App.jsx:279`). Truncation would need a phone render, which was not done.

### RS-2 — Reasons tables

One improvised table (`Reasons.jsx:46-79`):
- cells clipped at 280 px, with the full text only on hover;
- a 25-row cut;
- no sort, pager or sticky header.

Replace it with §3's table.

### A1 — the AI page

**State:**
- no key (01:16:08Z);
- disabled by `LLM_DISABLED` (02:41:31Z);
- 0 calls and $0 in 30 days (02:41:50Z);
- last success on 16-08.

**Surfaces that say otherwise:**
1. **The health panel's "llm anthropic:…" line.** `llmProviderInfo` names Anthropic whenever no OpenAI key is set. It checks neither for an Anthropic key nor for `LLM_DISABLED` (`llm-provider.js:44-52`). `/state/health` also tells API readers `apis.anthropic.status: "ok"` (03:06:30Z).
2. **Re-Risk's Apply.** It applies the 30-07 proposal for …7342 at $1,478.75 (02:49:21Z) to the global `risk_config_json`, with no confirm and no age check (`RiskReassess.jsx:441-443` → `actions.js:5710-5756`).
3. **Desk's "LLM spend" card and switch.**
4. **Tune's "Search by description…".**
5. **The sidebar badge,** which never says "AI off".

**Proposal:**
- One "AI" page, marked off, holding items 2–4.
- The sidebar and the health panel say "AI off".
- Rename "(Claude)" (`BotChanges.jsx:180`) and "thesis intact" (`cockpit-data.js:813`); both are rules-based.
- The Apply rules are D6, asked now.

### K3 — full-day 0/0 holiday rows

- **Today:** 0 of 136 demanded calendars are unknown (02:41:53Z).
- **Still open:** a current or future 0/0 row stays unknown (`market-calendar.js:70-78`), and holidays are not on the entry path (§7).
- **Decision:** D7; build item S-8.

---

## §3 Request 2A: the Performance cards

### Expand and collapse

**Verified:** both are ordinary cards (`Performance.jsx:1999-2004`, `BlockerReport.jsx:104`). A headless render at 1280 and 390 px (01:16–01:34Z) shows ⇲ ▾ ⧉ on both.

**Not verified:** what your phone shows (D19).

**Why it feels missing:**
- **Faint.** The button is at 55% opacity, and its border shows only on mouse hover (`Card.jsx:119-122`). A phone never hovers.
- **Forgotten.** It resets on reload (`Card.jsx:57`). The blockers card is keyed by account (`Performance.jsx:2004`), so it also resets on every switch.
- **No section id,** so neither card is in the contents list (`nav-tree.js:25-43`).
- **Four idioms:**
  - `Card`, not remembered;
  - `Collapse`, the ▸/▾ triangle beside the title, remembered (`Collapse.jsx:9-27`);
  - native `<details>`;
  - the stateless `Disclosure.jsx`.

  `Collapse.jsx:1-5` quotes your 02-08 order: "the cards, table to have collapsible triangle". Its note that sections get the triangle from SectionTools is stale (`SectionTools.jsx:39`).
- **Twelve desktop sections have no collapse at all:** goal, accounts, decisions, today-open, gradients, fx-bands, strategy-matrix, crypto, winlag, regime, balance and datafeed (`Performance.jsx:2316-2667`, `GoalTracker.jsx:287`, `DecisionFeed.jsx:209`). weekend24 has only a native `<details>`.

**Proposal:**
- One standard (D19), remembered per section.
- Section ids for the three top cards.
- The twelve bare sections get the same control.

**Decision:** D8, D19.

### The Recorded entry blockers table

**What it does now:**
- 50 rows (`state.js:152`), with no height limit and no sticky header.
- At 390 px the columns squash to 34–124 px, and the card is about 5,400 px tall (headless measure).
- It re-reads every 60 s into a 2-slot pool, even while collapsed: `Card.jsx:130` hides the body rather than unmounting it.
- Six of eight back-to-back reads were refused at 01:33:38–44Z, 90 s after a boot. Three spaced reads at 02:43Z succeeded, so this is a start-up effect.

**Time zone:**
- Times are stored in UTC (`db.js:539`) and printed raw (`BlockerReport.jsx:65`).
- The "Through …" line uses the browser's zone (`:107`), as the page's other reports do (`Performance.jsx:1223`).
- At 01:22:25Z the card showed "Through 9/26/2026, 9:22:25 AM" beside a row stamped "2026-09-25 22:45:24".
- So your rows are **Sat 26-09, 06:05–06:45 SGT**. That is in weekend quiet, which is why only BTCUSD appears.

**The pre-fix label is correct.**
- **Timing:** the last old stamp is at 22:45:24Z; the fix merged at 22:45:45Z; the first account-less row is at 22:47:12Z (read 01:32:47Z).
- **Verified for rows written while every account had the strategy OFF.** The union gate records no account (`loop.js:1331-1358`), and the old code filled in the trading account (`666a26a^:agent/services/decision-log.js:32`). fib_confluence has been OFF everywhere since 20-09 03:51Z.
- **…0058's 24-hour view** (02:43:25Z): 2,673 records, all pre-fix. Roster-wide stops: 4,410 (pre-filter 3,591, weekend quiet 608, stage_matrix 211).
- **Ageing out:** the rows leave the 24-hour view at ≈26-09 22:46Z and the 72-hour view at ≈28-09 22:46Z.

**Why one row a minute:**
- The loop runs every minute (02:41:38Z), and BTCUSD re-proposes the same setups each time.
- `decision_log` never merges repeats (`decision-log.js:66-81`). `risk_events` already folds them (`repeat_count`, `last_at`).

**Proposed design:**
- **Viewport:** 15 rows, scrolling both ways inside the card. Minimum width about 720 px. Sticky header, date line and time column. Full screen lifts the cap.
- **Dates:**
  - grouped by the page's zone (SGT on your phone), named in each header, with UTC under each time;
  - for example "Sat 26 Sep 2026 · Asia/Singapore — 2,913 records this day · 50 loaded";
  - the day total comes from the server, or the header says "not reported".
- **Repeats:** folded per day on the server by (account, symbol, timeframe, strategy, stage, reason), with first time, last time and count ("×42, 05:48–06:45"). **Every folded line expands.**
- **Roster-wide stops in an account scope:** expandable standing lines ("applies to every account", count, first, last), kept outside the totals. A scope with only these never reads "No retained decision records".
- **Pre-fix rows:** a word badge per row, from the arming log. It reads "all-accounts check" if every account had the strategy OFF at that time, else "cannot be split (before #1115)".
- **"Strategy OFF":** the reason comes from the arming log, for example "OFF on every account since 20-09 03:51 UTC — your order (#972)".
- **Details:** open as a full-width row.
- **The note:** shows once. Today it is 21% of each page's bytes.
- **Refresh:** only while expanded; new rows wait behind "N newer — show".
- **`fast_monitor` rows:** an expandable count.

### One shared data table

`DataTable` reuses what exists:
- `Collapse` with a row count;
- `useSort`;
- the trade table's frozen column;
- `sticky top-0` headers;
- `Disclosure.jsx`.

**Order:**
1. blockers;
2. Reasons;
3. workspace history;
4. decision feed;
5. Desk positions, Browser sessions, Account history;
6. Risk grids;
7. POST-backed tables, measured first;
8. the trade table (optional).

**Tests:**
- Vitest renders static markup without jsdom (`vite.config.js:34-35`).
- So scroll-not-squash is asserted in `responsive-audit.mjs`, with fixtures for `/state/blocker-report` and the balance reads added to its fixture host (`:44-60`).
- Its `--live` mode must become GET-only.

---

## §4 Request 2B: why the strategies are OFF

### The matrix (01:42–02:22Z; re-read 02:44:26Z)

| Strategies | 7 accounts (3 live, 4 demo) | Shared list (02:41:38Z) |
|---|---|---|
| 12 intraday | Trade OFF on all 7, as explicit cells | ema_pullback, donchian, vwap_trend, vp_value, rsi2, fib_confluence ON |
| tsmom_long | ON on …0058 only (trial to 19-12) | OFF |

**The shared list arms no account.** An explicit per-account Trade cell wins (`stage-matrix.js:199-231`).
- **But it ranks the scan's winner and the analysis picker** (`loop.js:4155`, `:4189`, `:4674`). That is why the 7-day "strategy OFF" stops name only its six ON strategies (02:44:24Z).
- **Who switches it:** the autopilot switched donchian ON on 19, 22 and 24 Sep; the watchdog switched it OFF on 21 and 23 Sep (arming log, 02:44:29Z).

**Other per-account cells bind nothing.**
- Scan, Back Test and Live Tweak & Close read the global matrix only (`stage-matrix.js:689-755`).
- …0058 has 52 pinned cells, against 13 on each other account (02:44:26Z). One example is vp_value with Scan OFF (02:45:17Z).
- These are switches the code never applies (principle 6).

### Who, when, why

| When | PR | What |
|---|---|---|
| 09-09 | #868 | Cluster rule: 12 strategies ON for 5 accounts |
| 11-09 | #897 | The same, for every account (principle 9) |
| 19-09 | #958 | **Your "Execute"**: 11 OFF; fib_confluence ON; tsmom_long on trial on …0058 |
| 20-09 | #972 | **Your "retire the intraday paths, keep momentum only"**: fib OFF; `scan_dispatch` retired |
| 25-09 ~11:45 SGT | — | **Your "restore the positive ones, on all accounts"** (`claude-takeover-2026-09-25.md:57-61`). **Not built** |

**The 91 per-account Trade cells (02:44:29Z):**
- 72 were set OFF by the boot seed;
- 1 was set OFF by the watchdog;
- **17 are OFF with no recorded reason** (the log starts on 17-09);
- 1 is ON.

**A wrong reason.** Seven fib rows from 20-09 say "no positive live record". #972's own text says the record was positive; the real reason was the retired order path.

**The log names the bot, not you.** The write route has returned 401 since 07-09, so your orders ship as repo seeds.

### "Why are you using them?"

**The chain, every minute:**
1. **Scan:** every strategy is scanned, because Scan defaults ON (`stage-matrix.js:64-67`).
2. **Choose:** the picker prefers the shared list (`loop.js:4155` → `fib-strategy.js:536-560`). The comment at `loop.js:4668-4671` claims it cannot pick a blocked strategy.
3. **Record:** an analysis row is written (`:1227-1245`).
4. **Refuse:** the union gate refuses it (`:1320-1359`), and its row carries no levels.

**The result:** 21,173 of 47,552 blockers in 7 days (44.5%, 01:34:52Z); fib alone had 10,922 at 02:44:24Z.

**Other costs:**
- **Fetch depth.** Every scan fetch asks for the deepest Scan-ON `minBars` (`fib-strategy.js:589-593`). That is ema_pullback's 450 (449 closed bars returned, 02:48:24Z), instead of our 150 floor (`SIGNAL_BARS`, `fib-strategy.js:60`).
- **Storage.** cup_handle, with Scan ON, still writes `cup_handle_diagnostics` (`loop.js:4196-4204`): 6.65 M rows and 716 MB, the largest table (02:41:42Z).

**The free "shadow" does not work.**
- **What the ledger scores:** risk-gate refusals and three `decision_log` stages, `evidence_gate`, `gate_redirect` and `producer_retired` (`refusal-ledger.js:68-75`, `:136-147`). It does not score `stage_matrix`.
- **What was recorded:** 0 rows ever for those three stages (02:51Z), and 0 shadow refusals in 7 days (01:42:04Z).
- **Four texts say otherwise** (principle 5): the pins `_off_note`, `entry-producers.js:35`, `refusal-ledger.js:59-66` and audit §L.

**What the scan still earns:**
- **Scanner profiles:** cpp-scan-timeframe's 690 profiles cover only fib, rsi2 and donchian, all on …0058's demo feed (action log, 01:43:34Z). Its code supports every intraday strategy.
- **Mirror candidates:** fib 63 and donchian 1 over 7 days, with no order authority (02:51:13Z).
- **The momentum book** also runs inside the scan (§7).

### Your premise, corrected

- **Right:**
  - the defaults arm ten of the thirteen (all but fib_618_fade, fvg_retrace and tsmom_long) and scan all of them;
  - the cluster rule and principle 9 put everything ON;
  - the unbuilt restore is a carried blockage (principle 3).
- **Not quite:** today's OFF is your order, twice over. Guards switch strategies OFF; nothing switches them back ON.
- **Principle 9:** met in arming, except the tsmom_long trial you approved. …0058's 39 extra pins look different but bind nothing.
- **Principle 1:** met.
- **Principle 7:** failed.
  - Over 19–25 Sep, 91.1% of 46,827 blockers were our own settings: OFF 45.0%, pre-filter 46.1% (01:42Z).
  - No proposal reached the risk gate. The last approval was on 18-09 at 21:24:29Z (read 01:35:14Z).

---

## §5 The strategy review

**How to read the table.**
- **Window:** each strategy gets the last max(150, `minBars`) closed bars. **150 is our floor** (`SIGNAL_BARS`, `fib-strategy.js:60`), **not a cTrader limit**. A strategy gets fewer if fewer are cached (`fib-strategy.js:637-640`).
- **Calendar span:** 150 bars of 1h are about:
  - 6.25 days of crypto;
  - 8.75 calendar days of FX;
  - 23 US-stock sessions, assuming 6.5-hour sessions.
- **Timeframes:** the ladder, 1mo down to 5m, plus the stored `autotrade_timeframes` (4h, 1d, 5m, 1h and 30m; 02:44:30Z).
- **Direction (principle 8):**
  - every intraday strategy proposes both sides, except the cup pair (cup long, inv_cup short);
  - tsmom_long is long-only;
  - the book shorts only at conviction ≥ 9/10, and never against an up-trend (02:44:32Z).
- **Evidence** (`/state/trades`, 02:46Z):
  - "All" gives closes · win rate · PF in R · money PF;
  - "Bot" gives bot closes · PF in R · money PF;
  - fewer than 30 closes is insufficient.
- **State:** read at 01:50Z.

| Strategy | Family | TF | Lookback | Met today? | All | Bot | State | Recommendation |
|---|---|---|---|---|---|---|---|---|
| fib_confluence | mean rev. | all | 150 (swings) | Yes on 1h+; ≤ ~3 days on ≤30m | 100 · 15.8% · 0.12 · 0.95 | 3: no record | OFF ×7 | D10; history first |
| rsi2_reversion | mean rev. | ≥1h | 150 (SMA100) | Yes | 83 · 50.6% · 0.79 · 0.77 | 49 · 0.59 · 0.47 | OFF ×7 | D10: below 1 |
| donchian_breakout | breakout | all | 150 (20-bar) | Yes | 91 · 47.1% · 0.63 · 0.86 | 68 · 0.56 · 0.68 | OFF ×7 | D10: below 1; watchdog no-edge ×3 |
| vwap_trend | trend | all | 150; anchors | **No on 1w, 1mo** | 63 · 45.9% · 0.77 · 0.54 | 13 · 0.25 · 0.04 | OFF ×7 | Fix anchors, then review (D15) |
| vp_value | mean rev. | all | 150 + prior session | **Partly on 5m, 15m** | 60 · 45.6% · 0.64 · 0.62 | 38 · 0.53 · 0.52 | OFF ×7 | Fix the session (D15) |
| va_breakout | breakout | all | Prior FX day | **No on 5m**; partly 15m | 17 (insuff.) · 11.8% · 0.17 · 0.32 | all bot | OFF ×7 | Fix and review, or retire |
| rsi_meanrev | mean rev. | all | 150 | Yes | 20 (insuff.) · 63.2% · 0.97 · 0.27 | 19 · 1.29 · 1.03 | OFF ×7 | History first |
| fvg_retrace | trend | all | 150 | Yes | 7 (insuff.) | 5 · 0 · 0 | OFF ×7 | History (never backtested) |
| cup_handle | breakout | all | 210 | **No on 1mo** (190 bars) | 1 real signal | 4, no R | OFF ×7 | Review on years of 1d |
| inv_cup_handle | breakout | all | 210 | No on 1mo | 0 | 0 | OFF ×7 | As above |
| ema_pullback | trend | all | 450 (EMA200) | **Intermittent** (449 of our 450 on an open market); never 1mo | 14 (7 with R), July | 0 | OFF ×7 | Measure overlap with vwap_trend first (D14) |
| fib_618_fade | mean rev. | all | 150 | Yes | 82 · 36.6% · 0.57 · 0.60 | 6 · 0.11 · 0.14 | OFF ×7 (yours, 27-07) | **Retire** (D14); an order still filled 24-09 |
| tsmom_long | momentum | 1d | 60-day return; 70 bars | Usually | 38 · 34.2% · 0.68 · 0.54 | 12 · 2.28 · 7.72 | **ON on …0058** | Keep to 19-12 |
| tick_momentum_breakout | tick | quotes | 256 events | n/a | Shadow 2,738 at PF 0.323; 1,387 at 0.233 (02:51:08Z) | — | Blocked ×7 | Keep blocked; tick plan owns it |

**Which need a history review first**

1. **fib, rsi2 and donchian, before D10.**
   - On clean evidence rsi2 and donchian are below 1, and fib has no record.
   - fib's 100 rows already existed (ids 226–1,621) and were relabelled or re-closed.
   - 94 of them lack an origin, and 49 are on DOW.US, 0016.HK and 0066.HK.
2. **rsi_meanrev, fvg_retrace, cup_handle and inv_cup_handle.**
   - They have too few trades, and the nightly backtest cannot judge them.
   - It runs 1,000 bars of the armed timeframes only, 24 symbols per sweep, and skips timeframes with fewer than 300 closed bars (`:335-363`). The 1,000 is **our constant** `BARS` (`strategy-autopilot.js:36`), carried over from the 07-07 manual backtest. It is not a broker limit.
   - 1,000 bars of 5m are about 3.5 days of crypto, 3.5 trading days of FX, or 12.8 stock sessions. cTrader returns the full count even when our from–to window holds fewer trading bars (PG.US, 1,000 × 1h from a 1,005-hour window, 03:53Z 26-09). Deeper history needs a larger count or requests for earlier ranges; our code does neither (§14).
3. **vwap_trend, va_breakout and vp_value, after their logic fixes.**

**Where lookback is cut short (verified in code)**
1. **Shallow reads overwrite deep ones.** Regime reads cache 30–80 bars under the scan's key, and the scan accepts them (`fib-strategy.js:159-175`, `:582`). Deeper strategies then return nothing for up to one bar.
2. **No depth margin** (`:589-593`): 450 asked, 449 closed bars received on an open market. The forming bar counts toward the 450 and never reaches the strategies. Asking for `minBars` + 1 fixes it; this is not a broker cap.
3. **Expiry by fetch time, not bar close** (`:134-139`, `:632`).
4. **Monthly history ends at 190 bars** (BTCUSD, 01:32Z; 450 asked). That is the symbol's full history at this broker (back to about Nov 2010), not a limit on the request.
5. **Session and anchor cuts.** va/vp lose part of the previous session on 5m and 15m. vwap anchors are epoch buckets (`vwap-trend.js:23-28`, `indicators.js:159`).

---

## §6 Historical data and services

### What stores market history today

| Store | Holds | Kept |
|---|---|---|
| Node scan cache | Bars, in memory | One bar period; lost on restart |
| `atr_history` / `regimes` | Daily ATR and close / ATR, ADX, label | 504 rows per symbol / 30 days |
| Autopilot | Fetches 1,000 bars (our constant) per armed timeframe, in one request each sweep; stores none; never requests earlier ranges | — |
| Tick spools | Ticks for 53 symbols: demo 339.06 h (10 sealed segments); live 0 sealed (02:51:10Z) | Capped by size |
| cpp-acct `/data` | The live spool only: 3.8 MB on a 48.9 GB mount (01:59Z). Railway created 50 GB against an approved 10 GB | — |
| cpp-scan-timeframe | Nothing (Node sends the bars) | — |
| **cpp-verify** | **No prices.** A verdict journal (monthly, no size cap) and watchdog state (capped at 4 MiB) | Monthly files |

### The cpp-verify premise, corrected

- **What it sends:** authorisation, trader, reconcile and deal-list messages, plus heartbeats (`verify_session.cpp:21-32`). There is no trendbar request and no pacer.
- **Its value is independence.** If it supplied the bars the strategies trade on, the auditor would produce its own inputs.

**Your direction is right.** Stored history helps:
- **research depth:** years. cTrader serves them through larger counts or requests for earlier ranges, at up to 5 history requests per second. The 1,000-bar single request is our limit, not the broker's;
- **frozen windows:** a closed period stops changing;
- **warm-up:** about 680 requests, or 170 s, per deploy (*inference*);
- **the request budget:** the autopilot re-fetches 24 symbols × 5 stored timeframes = 120 windows per sweep. That would be 312 under the 13-timeframe code default (calculation).

**But none of the five lookback defects needs a store.** Three are cache logic (S-3), one is the broker's own history (BTCUSD monthly, 190 bars), and one is strategy windows. "Retracement over several days" calls for a **multi-timeframe design** (a daily or 4h swing grid with a lower-timeframe trigger).

| Option | Cost | Verdict |
|---|---|---|
| **A. Node bar store** (`bars.db`) | ≈0.1 GB for 1,000 bars × 8 timeframes; 0.6–0.9 GB with a deep backfill (*inference*). Database 3.81 GB on a 9.83 GB volume, 5.77 GB free (02:41:42Z) | **Phase 0 now; the store if D18 fires** |
| B. New cpp-market-data service | New service, volume, token holder, broker connections. Size L | Only if needed later |
| C. In cpp-scan-timeframe | Breaks parity with Node, or needs credentials | No |
| D. In cpp-verify | Breaks independence; no pacer | No |
| E. In cpp-acct or the tick spool | The account service; spools hold quotes, not bars. The same coupling as C and D | No |

**Recommendation: measure first.**
- **Phase 0, now, with S-3.** It counts:
  - "starved" counts per strategy and timeframe;
  - requests per purpose;
  - historical token wait, through the existing `onTokenWait` hook (`ctrader-session.js:57-66`), which today only `fast-monitor.js:444` uses;
  - warm-up time.

  `/state/data-feed` shows "not measured" until data exists.
- **Phases 1–2, only past D18.** Store closed bars keyed by feed, symbol, period and time; then move the autopilot, regime, ATR and positions reads onto the store.
- **Backfill for H-2.** A research-only table, with the depth set by you (D16). Any volume resize is ask-first.
- **A separate service,** only if measured:
  - token wait above D18 at weekday peak;
  - main-thread lag from bar I/O;
  - or the 796 scanner profiles (01:43:34Z) needing bars that Node cannot serve.

---

## §7 The workflow from the first step

**Today's pipeline:**
1. **Universe:** 59 symbols (02:17Z), plus per-account lists.
2. **Hours:** weekend quiet (`lib/quiet-hours.js`) and the weekly schedule (`symbol-hours.js:174-188`). Holidays are only recorded: **they are not on the entry path.**
3. **Bars:** fetched per scan into memory.
4. **Scan:** every strategy whose global Scan cell is ON. cpp-scan-timeframe mirrors this and places no orders.
5. **Roster filters:** horizon, the armed-timeframe pre-filter, and 3 analysis slots per cycle.
6. **Analysis row,** written **before** any on/off check.
7. **Stage gate:** the union of accounts first, then per account.
8. **Direction:** the strategy's bias, then the regime gate.
9. **Per-account checks:** margin, pre-gate, fundable, horizon, switches, ratchet, connection, watchlist, proposal.
10. **Retired-path fence** and entry mode; then hours, evidence gate and the higher-timeframe limit.
11. **Risk gate:** the R:R floor of 3.0 (`risk.js:92`), unless `earned-floor.js` lowers it for a strategy (`:86-90`); then sizing.
12. **Placement** (TP1 mandatory), protection, capture and verification.

**Where candidates stop over 7 days** (02:15:38Z; 47,591 rows):

| Stop | Share | Self-inflicted? |
|---|---|---|
| Armed-timeframe pre-filter | 45.4% | **Yes.** 16 symbols are armed only on 3d, 4d, 8h or 12h, which are neither on the ladder nor in the stored timeframes (02:44:30Z) |
| Strategy OFF | 44.6% | **Yes**, by your order, but repeated every minute |
| Weekend quiet | 5.9% | A fixed setting, written once per loop |
| Fast monitor | 2.6% | Position management, not entry |
| Margin pool | 1.5% | Real |

The risk gate approved 0 proposals and vetoed 0 (also at 02:44:24Z).

**Why nothing can open automatically:**
- **Intraday strategies:** OFF, and their order path is retired.
- **tsmom_long:** armed only on …0058, which holds 6 book rows (02:44:32Z). Its cap is the smaller of the book's 8 (`momentum-book.js:148`) and the risk gate's 5 (`risk.js:368`). You kept those caps on 11-09.
- **…0949 holds 10 book rows, above both caps.** All were entered 09–18 Sep, before the trial restriction. There are 22 open book rows in all, and 37 closed at PF 0.55. Any closing is ask-first.
- **Tick entries:** blocked on all 7 accounts, and the switch is manual.
- **C++ scanners:** they observe only. Admission refuses them (`scanner-candidates.js:86`), and PR-7 is not on main.

**The momentum book depends on the scan (principle 3).**
- The shadow and the book are called only inside the scan branch (`loop.js:4123-4710`).
- That branch is skipped when Scan is disabled, when Scan is off on every account, and in weekend quiet with no crypto.
- When it is skipped, the book's trailing stops and exits stop too.

**Target workflow:**
1. One hours source, including holidays.
2. Decide what can trade first: armed strategies with a live order path, plus a declared shadow set.
3. Closed bars with a depth margin.
4. Scan only those strategies.
5. Record each shadow proposal once per opportunity, keyed as in §3, with levels, and score it.
6. Send tradeable proposals through the account checks, admission, risk gate and placement.
7. Show standing states once, not every minute.
8. Run the book independently of the scan.

---

## §8 Build sequence (after the current work)

Each merge restarts Node, which also serves the website, so UI PRs are batched.

0. **SAFE-0 (first batch).**
   - **(a) The manual-order confirm names the destination account** (`Trade.jsx:620-633`).
     - Test: the confirm text carries the id.
     - Mutation check: remove the id; `grep -c` goes 1→0 and the test turns red.
     - Not ask-first. S.
   - **(b) The server refuses a stale or other-account Re-Risk apply** (`actions.js:5710-5756`, `RiskReassess.jsx`).
     - Test: a 58-day-old proposal for another account is refused.
     - **ASK-FIRST (D6):** it guards a risk-limit writer. S.
1. **UI-1 Card memory, the D19 standard, section ids.**
   - Files: `Card.jsx`, a new pure `lib/card-open.js` with injected storage, `Collapse.jsx` (the stale comment), `Performance.jsx`, `nav-tree.js`.
   - Tests: storage that throws; a remount standing in for an account switch; the control renders without transparency; a mutation check.
   - S. D8, D19.
2. **UI-2 Shared `DataTable`.**
   - Scope: a 15-row viewport; sticky header, date line and first column; `Disclosure.jsx` details; "load older"; "N newer"; sorting.
   - Files: new `common/DataTable.jsx`, `lib/data-table-groups.js`, `index.css`.
   - Tests: `2026-09-25 22:45:24` falls on 26-09 in Asia/Singapore and on 25-09 in America/New_York; unparseable times get their own group; a daylight-saving case; a mutation check (remove the `Z` in `toMs`).
   - M.
3. **UI-3 Blockers card on `DataTable`, with server grouping.**
   - Scope: ISO UTC times; a validated `timeZone` and `days[]`; the §3 fold, reusing `repeat_count`/`last_at`; standing lines; the per-row pre-fix label; "OFF since … — order"; `fast_monitor` as a count; refresh only while expanded.
   - Files: `blocker-report.js`, `state.js:143-165`, `BlockerReport.jsx`, `arming-log.js`, `performance-populations.js`, `responsive-audit.mjs` and its fixtures.
   - Tests:
     - totals equal `totalRecords`;
     - account and roster-wide rows never merge;
     - a bad zone returns 400;
     - a roster-only scope shows standing lines;
     - a pre-fix row from before 20-09 03:51Z reads "cannot be split";
     - a mutation check on the fold;
     - the audit checks the 390 px scroll.
   - Read-back: …0058 on your phone. M. D9.
4. **S-1 Honest arming records, picker and dead cells** (no Trade value changes).
   - Scope:
     - the picker and scan winner rank by the union of the accounts' Trade-armed strategies (`loop.js:4155`, `:4189`, `:4674`; `armed-analysis-filter.js`), and the false comment is fixed;
     - the 24 unrecorded cells get rows;
     - the 7 wrong reasons are corrected by **appended** rows, never updates (the #1115 rule);
     - per-account Scan, Back Test and Live Tweak & Close cells either take effect (`stage-matrix.js:689-755` and its callers) or are refused;
     - Tune shows "followed by N of 7";
     - the principle-5 texts are fixed (pins notes, `entry-producers.js:35`, `refusal-ledger.js:59-66`, audit §L, `dual-environment-plan:74`).
   - Tests: with vwap ON on the shared list and OFF on every account, neither the winner nor the picker is vwap; all 91 cells read "recorded"; the arming log only grows; …0058's vp_value Scan OFF either takes effect or returns 400.
   - Read-back: little change in stops (the picker only prefers); stop counts are read back in S-4.
   - S–M. **ASK-FIRST** only for realigning …0058's 39 extra pins.
5. **S-2 Momentum book out of the scan branch** (`loop.js:4123-4710`).
   - Tests: book exits run with Scan disabled, with Scan off everywhere, and in quiet with no crypto; the shadow still ranks.
   - **Owner-visible:** it changes when exits run for the 22 open book rows. Read back the first weekend pass.
   - S.
6. **UI-4 Sidebar S1 and S2.**
   - Files: `use-engine-status.js`, `engine-status-view.js`, `EngineStatusLine.jsx`, `EngineStatusPanel.jsx`, `Dockerfile`, `vite.config.js`, `agent-health-view.js`.
   - Tests: with the lens on, readiness renders for every row; "no record" shows; the build-id helper with the env set, unset and `'dev'`; a mutation check (drop the Railway name).
   - Read-back: web and agent commits match. S.
7. **UI-5 Reasons data fixes (RS-1a).**
   - Scope: gross P&L consistency; the refusal-time window; trade-plan flags; the phase-audit split; no re-stamping.
   - Tests: a mutation check on each.
   - M. **ASK-FIRST** for the 28 plans (D5).
8. **UI-6 Reasons restructure (RS-1b) and tables (RS-2).**
   - Files: `reasons-view.js`, `Reasons.jsx`, `Desk.jsx`, `Tune.jsx`; the inventory regenerated with `scripts/ui-control-inventory.mjs` and checked by its test.
   - M. D4.
9. **UI-7 AI page (A1).**
   - Files: new `pages/Ai.jsx`, `App.jsx`, `nav-tabs.js`, `nav-tree.js`, `Desk.jsx`, `Risk.jsx`, `Tune.jsx`, `RiskReassess.jsx`, `LlmMonitorStatus.jsx`, `llm-provider.js`, `agent/index.js`; the inventory regenerated.
   - Tests: the llm line reads "off" with no key and with `LLM_DISABLED`.
   - M.
10. **UI-8 Picker move (S3).**
    - Files: `App.jsx`, `ViewAccountPicker.jsx`, `agent-api.js`.
    - M. **ASK-FIRST** if orders route to the viewed account (D2).
11. **S-3 Bar-path fixes and the Phase 0 counters.**
    - Scope: depth recorded per cache entry; the need plus a margin; expiry at bar close; the counters; impossible cells marked; tsmom_long no longer "silent".
    - Files: `fib-strategy.js:128-176, 582-640`, `ctrader-session.js`, `state.js`, `strategy-liveness.js`, `armed-cell-reachability.js`.
    - Tests: a 30-bar regime write forces a deeper fetch; a count − 1 stub still runs ema_pullback; a mid-bar fetch is never closed; the counters increment.
    - S–M.
12. **S-4 Enablement first; the shadow scored or stopped; OFF strategies stop costing.**
    - Scope:
      - a producible set built before analysis;
      - one shadow row per opportunity window, with the proposal's levels (the gate's row has none), reusing the retired fence's window (`entry-mode.js:720-741`);
      - `stage_matrix` added to the ledger;
      - standing stops once per window by the §3 key;
      - fetch depth taken from tradeable or shadow strategies only;
      - no cup diagnostics while cup_handle is OFF everywhere.
    - Files: `loop.js`, `stage-matrix.js`, `refusal-ledger.js`, `evidence-gate.js`, `decision-log.js`, `veto-breakdown.js`, `fib-strategy.js`.
    - Tests: N cycles give 1 row with count N and unchanged veto totals; the row is scored once; with ema_pullback OFF the fetch is 150 plus the margin; diagnostics do not grow; a mutation check on each.
    - Read-back: shadow refusals > 0, with levels.
    - M. **ASK-FIRST** (D11, D12).
13. **S-5 Arming writers.**
    - Scope: the autopilot never arms what no account follows or what is retired; the watchdog stops flipping the shared list; `pending_mode_enabled` follows retirement.
    - Files: `strategy-autopilot.js:417-475`, `edge-watchdog.js`.
    - S–M. **ASK-FIRST** (D13).
14. **H-1 Bar store, Phases 1–2, only if D18 fires.**
    - Files: new `bar-store.js`, `fib-strategy.js`, `strategy-autopilot.js`, `vol-gate.js`, `ctrader-ws.js`; a pin that cpp-verify has no trendbar code; the H-2 research table.
    - Tests: store signals equal a direct fetch; restart catch-up; feeds kept separate.
    - M + M. **ASK-FIRST:** D16 and any volume resize.
15. **S-6 Restore, only for a strategy given D10 (A).**
    - Scope: tokenised `_all` entries (for example `fib_confluence:r0925`); an order path (an allow-list at the fence, or PR-7 through admission and the risk gate); D17.
    - Tests: the seed applies once on every account; a restored strategy reaches `evaluateTrade`.
    - M. **ASK-FIRST:** enablement, including the 3 live accounts.
16. **S-7 Logic fixes, then the H-2 review.**
    - Scope: vwap anchors; va/vp previous sessions; native parity; walk-forward on 1h–1d against 30 closes at PF ≥ 1.5.
    - M each. **ASK-FIRST** (D15).
17. **S-8 Holidays on the entry path.**
    - Files: `symbol-hours.js`, `market-calendar.js`, `lib/quiet-hours.js`.
    - Tests: a current full-day closure reads closed; UNKNOWN never reads open.
    - M. **ASK-FIRST** (D7).
18. **Later, each ASK-FIRST:** D14 (retirement and order sweep), D17, and a report on the R:R floor. Not ask-first: the remaining table migrations and the twelve bare sections (M).

---

## §9 Owner decisions needed

| # | Question | Options | My recommendation |
|---|---|---|---|
| D1 | What did "hardcoded and gated" mean? | (a) the sidebar label; (b) tick entries held by the readiness gate | Fix (a) now; for (b) the 4 blockers stay under your thresholds and I list remedies. Do you want the automatic tick switch on anywhere? |
| D2 | Where does the picker go? | (a) under TRADING; (b) one picker at the top | (a). The confirm names the account now (SAFE-0a); routing orders to the viewed account is your call |
| D3 | Version number | Bump every release; or show commits | Show web and agent commits; drop the number |
| D4 | Go-live readiness card (15-08 has passed) | Remove; new date; none | Remove it; you choose any date |
| D5 | Correct the 28 wrong-unit plans? | Correction records; or leave flagged | Correct them (nothing deleted) |
| D6 | Re-Risk Apply on stale AI proposals, asked now | Refuse; refuse and confirm; leave | Refuse on the server when older than 7 days (proposed figure) or for another account; otherwise confirm, naming the global keys |
| D7 | Does a current 0/0 row mean "closed all local day"? | Yes / no | Yes: the worst case shows closed when open, never the reverse |
| D8 | Cards remember collapse on every page? | Every page; blockers only | Every page |
| D9 | Blockers: fold repeats; pre-fix rows | Fold, labelled per row; list all; hide pre-fix | Fold, every line expandable; pre-fix labelled per row until it ages out |
| D10 | Restore fib_confluence, rsi2 and donchian? | (A) restore at half risk (needs an order path and D17); (B) score the shadow first; (C) withdraw | **Per strategy: (C) for rsi2 (49 bot closes, PF 0.59 in R) and donchian (68, 0.56); (B) for fib (3 bot closes).** (B) is the kind of observation step your 25-09 "trade as soon as built" order skipped for the scanner handoff (`claude-takeover-2026-09-25.md:52-56`); reinstating it is your choice |
| D11 | Shadow for refused strategies | Score it; or stop scanning them | Score the D10 (B) candidates; stop scanning the rest after D14 |
| D12 | Standing stops once per window? | Yes, with counts; or every minute | Yes: sums kept, every folded line expands |
| D13 | Stop the autopilot and watchdog flipping the shared list? | Yes / no | Yes: it arms nothing but steers the picker |
| D14 | Retire fib_618_fade and ema_pullback; cancel leftover orders? | Retire and cancel; retire only; no | Retire fib_618_fade (6 bot closes at PF 0.11). Decide ema_pullback once its overlap with vwap_trend is measured. Each cancel listed for approval |
| D15 | Fix vwap anchors and va/vp sessions, then review? | Fix and review; or retire | Fix, then review; arming stays yours |
| D16 | Bar store and backfill depth | Phases 0–2 now; Phase 0 now and the rest on D18; wait | Phase 0 with S-3 now; Phases 1–2 past D18; H-2 backfill as a research table, depth yours (e.g. 2 years of 1h). No new cpp service |
| D17 | 16 symbols armed only on unscanned timeframes | Add 3d/4d/8h/12h; re-arm; show as unreachable | Show as unreachable now. Alone it changes no trade (stops move to `stage_matrix`), but D10 (A) needs it; the fix is adding [4d, 3d, 12h, 8h] to `autotrade_timeframes` |
| D18 | What measured load justifies the store or a service? | A figure; or none | Proposed: p95 token wait above 5 s per scan cycle, or the scan's soft deadline hit (`loop.js:4191`) in over 5% of weekday cycles, measured by Phase 0 |
| D19 | On your phone, do you see ⇲ ▾ ⧉ top right on these cards? Which collapse standard? | (a) the ▸/▾ triangle beside the title (your 02-08 order); (b) the Card's ▾ on the right | Tell me what you see; then (a) everywhere, remembered, with ⇲ ⧉ kept on the right |

---

## §10 Invariants (P3)

| # | Invariant | Result | Evidence |
|---|---|---|---|
| 1 | This investigation changed nothing | **Failed (minor, disclosed)** | GET-only and a clean worktree, but `client-ping` is a write: presence records 01:16–01:35Z, and again from the §13 traces, 17 pings 02:31–02:58Z |
| 2 | Every production number has its read time | **Not verifiable** as a blanket claim | The six numbers found untimed now carry times; calculations are labelled (§12) |
| 3 | Principle 1: live and demo alike | **Passed** | All 7 accounts identical (01:42Z, 01:50Z, 02:41:37Z) |
| 4 | Principle 9: no account-restricted trading | **Failed as written**; you approved the exception | `_trial` names …0058; …0058 carries 52 pins against 13 elsewhere |
| 5 | Principle 4: every OFF cell has a true reason | **Failed** | 17 account and 7 shared cells unrecorded; 7 wrong |
| 6 | Principle 5: plans match code | **Failed** | "Measured by the evidence shadow" is false; `dual-environment-plan:74` contradicts the takeover; `Collapse.jsx:1-5` is stale |
| 7 | Principle 3: the 25-09 restore was built | **Failed** | Pins unchanged since #972 |
| 8 | Principle 6: no fake result | **Failed** | The shared list shows 6 ON, arms nothing but steers the picker; per-account Scan/Back Test/Manage cells shown, never applied; the "llm" line; "dev"; "shadow" |
| 9 | Principle 7: vetoes minimised | **Failed** | 91.1% self-inflicted; 0 reached the risk gate |
| 10 | Blocker times carry a zone | **Failed** | `BlockerReport.jsx:65` |
| 11 | Top cards collapse / remember | **Passed / Failed** | `Card.jsx:45` / `:57` |
| 12 | cpp-verify holds no prices | **Passed** | `verify_session.cpp:21-32`; grep empty |
| 13 | Full lookback on every scanned timeframe | **Failed** | ema 449 of 450 (our fetch has no margin for the forming bar); 1mo 190 bars (BTCUSD's full history at the broker); va/vp; vwap |
| 14 | No colour-only signal | **Passed** | Badges are words |
| 15 | Your limits untouched by this plan | **Passed** | Changes are ASK-FIRST; existing state: …0949 above both caps |

---

## §11 What is not verified, and the risks (P6)

### Not verified

- **Weekday load and bar counts:** every read was on a Saturday.
- **Partial bars and shallow cache hits:** not counted until S-3.
- **fib_confluence's history:** no PR is identified for the re-statement, and there are no intent rows for its 94 origin-less closes.
- **Money PF:** it may mix deposit currencies (`base_currency` is null on all 7).
- **Your phone's view of the cards** (D19), and iPhone Safari with a sticky header inside a scroll box.
- **The restore order's meaning:** un-retiring `scan_dispatch`, or PR-7.
- **Railway settings:** the build-time commit variable and `TICK_SCANNER_MIRROR_URL`.
- **The 17 unrecorded cells:** probably guard disarms from before 17-09 (*inference*).
- **Growth rates:** `cup_handle_diagnostics` and volume growth rest on one 16.5-minute window that included a restart.
- **Timing and scope:** #1115's deploy time, and which V3 items remain open.

### Risks

- **D10 (A) trades live accounts too** (principle 1). The pins would be exempt from the watchdog.
- **D12 changes tracked numbers.** Every reader must sum the repeat counts.
- **S-2 changes when book exits run.**
- **The backfill competes with the scan** for 4 requests per second.
- **Every merge restarts the agent and website.**

---

## §12 Verification record

**Read times.**
- **Code-facts verifier:** code at `6541c0f` plus GitHub history. No production reads.
- **Prod verifier:** GET-only, 02:41:31–02:58:29Z. The times above follow its `reads.log`, which differs from its report by seconds.
- **Reviser:**
  - `/state/runtime-manifest` and `/state/health` at 03:06:29–30Z;
  - GitHub: commits since 26-09, #1142's diff, and `Performance.jsx` at `9f44f97`;
  - git reads of `package.json` at #501, #724, #761, #856 and #970;
  - recomputation from the verifier's saved trades, book, arming-log, matrix, reachability and blocker bodies.

**Applied:**
- **All 36 code-facts corrections.** #1 was extended with my own git reads, and #22 was given its read time (01:43:34Z).
- **Prod corrections C2–C37,** with C22 and C28 partly applied (below) and two narrowings:
  - **C3:** the skipped trial was rev-3's scanner-handoff observation trial, so (B) is called "the kind of" step, not a literal reversal.
  - **C18:** invariant 2 reads "Not verifiable" rather than "Failed", because the six numbers now carry times: tick shadow 02:51:08Z; spools 02:51:10Z; profiles 01:43:34Z; last approval 01:35:14Z; symbols 02:17Z; 312 labelled a calculation.
- **Checked in code or data before applying:**
  - C2: bot-origin figures, all matched;
  - C10: global-only matrix reads;
  - C15: fetch depth and the diagnostics writer;
  - C30: …0949's entry dates;
  - C1: the +7 shift.

**Partly applied:**
- **C1:** the baseline was moved; the V3 items that must land first are not listed, because they are unverified.
- **C28:** direction is a bullet, not a table column.
- **C22:** only the Apply stop-gap moved to the first batch.

**My own corrections:**
- "312 windows per sweep" was wrong for production: the stored `autotrade_timeframes` holds 5 timeframes, so it is 120.
- rsi2's 77 vs 83 is reconciled (label vs `strategy` field).
- The `Collapse.jsx` comment is stale.
- D14 no longer retires ema_pullback unmeasured.

**Rejected:** none.

---

## §13 Performance traces through the Chrome DevTools MCP (owner mandate, 26-09 ~10:20 SGT)

**Your order:** "Mandate to run performance trace through the Chrome Devtools MCP". It is applied in two ways:
1. A baseline was measured now, before anything in this plan is built.
2. Every website PR from this plan must carry a before-and-after trace. A standing rule is proposed for CLAUDE.md (D20).

### How it was run (P4)

- **Tool:** the official Chrome DevTools MCP server, `chrome-devtools-mcp` 1.10.1. This session had no DevTools MCP connected, so the server was run locally and driven over MCP from a script. The tools used were:
  - `performance_start_trace`, `performance_stop_trace` and `performance_analyze_insight`;
  - `list_network_requests`, `list_console_messages` and `evaluate_script`;
  - `emulate`, `resize_page`, and `new_page` with an isolated context.
- **Browser:** Chromium 141, attached to the server with `--browserUrl`.
- **Nothing leaves through the tool:** CrUX lookups are off, usage statistics are off, and network headers are redacted.
- **Read-only key.** The site ran with the read-only key, which cannot authorise any non-GET request (`agent/lib/auth-tiers.js:8`).
  - The Trade page's `POST /actions/broker-positions` returned 401, as expected.
  - Like the §1 headless loads, each page's presence ping (`GET /state/client-ping`, which does write) registered the tab: 17 pings between 02:31Z and 02:58Z. **Disclosed under invariant 1.**
- **TLS:**
  - **What the proxy does:** the sandbox's egress proxy terminates the browser's TLS, but not curl's.
  - **What Chrome trusts:** only that proxy's CA, pinned by key hash. There is no blanket certificate bypass.
  - **The check:** before and after every run, a script read over CDP the certificate Chrome received (`sg-trade.up.railway.app`, issuer "CCR Upstream Proxy CA (staging)"). Every check passed.
- **Isolation:** each trace runs in a fresh browser context (cold cache, no leftover connections), with a 15 s recording after a reload.
  - A first run without isolation showed the Trade page at 25.7 s. The cause was the previous page's polling holding the connections, so that run was discarded.
- **Profiles:**
  - **Desktop:** 1440×900, no throttling.
  - **Phone:** 390×844, CPU 4× slower, Fast 4G.
- **Absolute times are not your device's.** Network times pass through the sandbox proxy (HTTP/1.1 and an extra TLS hop). A before-and-after comparison on the same harness is valid.

### Baseline (production `77da158`, 02:45–02:53Z, a Saturday)

| Page | Profile | LCP | CLS | Elements | Rows | Height | Calls in 15 s | KB |
|---|---|---|---|---|---|---|---|---|
| Home (/) | desktop | 1,973 ms | **0.82** | 5,502 | 148 | 13,421 px | 42 | 330 |
| Performance | desktop | 2,194 ms | **0.68** | 5,502 | 148 | 13,421 px | 41 | 327 |
| Reasons | desktop | 2,998 ms | **0.80** | 5,374 | 294 | 11,991 px | 37 | 141 |
| Risk | desktop | 2,801 ms | **0.70** | 1,207 | 27 | 6,358 px | 30 | 94 |
| Trade | desktop | 3,326 ms | **1.03** | 1,340 | 31 | 1,934 px | 102 | 439 |
| Home (/) | phone | 3,818 ms | **0.90** | 5,502 | 148 | 8,490 px | 51 | 344 |
| Performance | phone | **4,978 ms** | **0.82** | 5,502 | 148 | 8,490 px | 57 | 357 |
| Reasons | phone | **10,544 ms** | **0.59** | 5,374 | 294 | 13,641 px | 46 | 154 |
| Risk | phone | **4,081 ms** | 0.21 | 1,207 | 27 | 8,953 px | 58 | 158 |
| Trade | phone | **5,839 ms** | **0.75** | 1,340 | 31 | 4,283 px | 192 | 816 |

**How to read the table:**
- **LCP** is the time until the largest content is drawn. Good is ≤ 2.5 s; poor is > 4 s.
- **CLS** is how much the layout jumps while loading. Good is ≤ 0.1; poor is > 0.25.
- **Bold** marks a poor value.

**Run-to-run noise.** The same page was traced again at 02:58Z, after #1142 (a text-only change), and compared with the 02:45Z run:
- Performance on desktop: LCP 2,194 → 1,984 ms, CLS 0.68 → 0.82.
- Performance on the phone: LCP 4,978 → 2,269 ms, CLS 0.82 → 0.73.
- The structure was identical: 5,502 elements and 148 rows.

**So one trace cannot judge a PR.** The rule below uses the median of 3.

### What the traces say (verified in the saved traces and insights)

1. **The browser is the slow part, not the server.** On every page, 90–96% of LCP is render delay after the first byte, which arrives in 0.2–0.4 s. The pages wait on their data calls and scripts before drawing.
2. **The layout jumps everywhere** (CLS poor on 9 of 10). The culprits named by the `CLSCulprits` insight are:
   - **Content inserted as data arrives:** cards and tables reserve no space, and buttons shift on Reasons.
   - **A web font loaded twice.** `fonts/inter-800.woff2` is preloaded, but the preload is not used; the console says the credentials mode does not match and suggests the crossorigin attribute. The text then reflows when the font swaps.
3. **The Performance page is very large.**
   - It has 5,605 elements. One container holds 633 children, and the digit-span tree (`SPAN.digit__num`) is 18 levels deep.
   - Layout passes take 46–77 ms each and touch 2,000–4,500 elements.
   - Long cards render every row: 148 rows, and the page is 13,421 px tall. This is §3's problem, measured.
4. **A scroll library forces layout.** GSAP ScrollTrigger's `_refreshAll` forces synchronous layout, 139 ms on desktop Performance, and it re-runs as the content grows.
5. **Reasons is the slowest page on a phone:** 10.5 s LCP, 294 rows, and a single layout update of 397 ms. The RS-2 table (15 rows plus paging) addresses exactly this.
6. **The Trade page's polling also calls the broker.**
   - While positions are open it reloads every 5 s (`Trade.jsx:38`, your "run every ½ second" order, set to 5 s). Each reload includes `POST /actions/broker-positions` (`:544`, `:568`).
   - A cold snapshot "costs ~6 WS handshakes" (`agent-api.js:105`).
   - 6 such POSTs in 15 s on desktop, and 12 on the phone. With the read key they were refused, so **the broker cost with your key is not measured here.**
   - This is a budget question (D22), not a defect.

### The mandate as a rule (proposed for CLAUDE.md, D20)

- **Scope:** every PR that changes `src/`, or a route the website reads.
- **Pages:** trace each page it touches, plus Home, on both profiles.
- **Harness:** the same one, `scripts/perf-trace/`. Take the **median of 3** fresh-context runs per page and profile.
- **Timing:**
  - **Before:** on current production.
  - **After:** on the deployed merge, read back like any other change.
- **The PR body carries:**
  - a table of LCP, CLS, element count, rows, and calls with KB, for each page and profile, before and after;
  - the list of insights;
  - the certificate-check lines.
- **A regression blocks the auto-merge** unless it is explained and accepted. A regression is a touched page's median that gets worse by more than the noise floor, which is proposed (D21) at:
  - LCP: +20% or +500 ms, whichever is larger;
  - CLS: +0.05;
  - elements: +10%.
- **INP** (the response to a tap) is added once each UI PR scripts its own interaction, such as expanding a card or switching account. Until then it reads "not measured", never a number.
- **Privacy:** CrUX and usage statistics stay off. The read-only key only.

### Build items added to §8

- **PERF-0 (with this plan's PR).**
  - Scope: the harness in `scripts/perf-trace/`: `run-traces.sh`, `trace.mjs`, `certpin.mjs` and a README. The DevTools MCP packages are installed into a temporary directory, not added to `package.json`.
  - Tests: ESLint on the scripts, plus one dry run.
  - Not ask-first. S.
- **PERF-1, cheap layout-jump fixes (after UI-1, before UI-3).**
  - Scope:
    - the font preload gets `crossorigin`, or is removed;
    - cards reserve their height while loading;
    - long cards start collapsed, per D8/D19;
    - ScrollTrigger refreshes once after the data settles, not on every insertion.
  - Tests: the median-of-3 CLS falls on Performance and Reasons, on both profiles.
  - S–M.
- **PERF-2, the Performance digit tree.** The 633-child container: render numbers as text, and animate only the one visible counter. S.
- **The UI-1 to UI-8 PRs each carry the §13 before-and-after table.**

### New decisions

| # | Question | Options | My recommendation |
|---|---|---|---|
| D20 | Make the trace rule standing, in CLAUDE.md's merge gate for website PRs? | Yes / only for this plan's PRs | **Yes**, it is your mandate; the wording above |
| D21 | Regression thresholds | As proposed; tighter; looser | As proposed, reviewed after 5 PRs of data |
| D22 | The Trade page's broker snapshot every 5 s while positions are open | Keep; 5 s but only while the tab is visible; 15 s | Keep 5 s while visible (already paused when asleep, `Trade.jsx:568`); measure the broker cost with your key first |


---

## §14 cTrader history: what the API allows, and what our code asks for (added 26-09 after the owner's question)

**The owner asked:** "Doesn't cTrader allow API to do backtest data by days and weeks?" and "you mentioned the limitation of ctrader is 150 bars".

**Answer: yes, it does.** The 150-bar figure is not cTrader's. It is our own floor (`SIGNAL_BARS = 150`, `agent/services/fib-strategy.js:60`). Earlier wording in this plan made it read like a broker limit; that was wrong, and §5 and §6 are now corrected.

This section was checked by a three-agent workflow: a documentation lane, a code-and-production lane, and an adversarial verifier that re-fetched every source. The documentation was read 03:41–03:56Z and production 03:56–03:58Z on 26-09.

### What cTrader allows (verified)

- **The request.** `ProtoOAGetTrendbarsReq` (payload 2137) takes a period, an optional `fromTimestamp` and `toTimestamp`, and a `count`: "Limit number of trend bars in response back from toTimestamp" (spotware/openapi-proto-messages `OpenApiMessages.proto:517-526`). The response carries a `hasMore` flag (:537).
- **The periods** run M1 to MN1 and include **D1, W1 and MN1** (`OpenApiModelMessages.proto:536-551`).
- **The rate limit.** "a maximum of 5 requests per second per connection for any historical data requests" (help.ctrader.com/open-api). Our code paces itself at 4 per second, process-wide (`agent/lib/ctrader-ws.js:102`).
- **Range caps.** Per-period range caps were published until January 2024 (commit 36d5001) and have since been removed from the protocol text. Production already exceeds those old caps: 4h ≈ 2 years, 1d ≈ 4 years and 1w ≈ 8.6 years came back in one request each.
- **A per-response cap** of 14,000 bars was stated by Spotware on their forum in 2020. It has not been tested here.
- **Tick history** (`ProtoOAGetTickDataReq`, payload 2145) is limited to one week per request, with `hasMore` paging (help.ctrader.com/open-api/symbol-data).
- **In production, one request returned** (03:53–03:57Z):
  - 1,000 bars when asked for 1,000, on 5m, 30m, 1h, 4h and 1d;
  - 449 weekly bars when asked for 450;
  - BTCUSD's whole monthly history, which is 190 bars.

### What our code does (verified)

- **One request per timeframe, ending now** (`ctrader-ws.js:766-768`). It never asks for an earlier range, never reads `hasMore` (`:712`), and stores no bars.
- **The depths are all ours:**
  - 150 is the analysis floor;
  - `minBars` sets deeper fetches (450 for ema_pullback);
  - the autopilot's 1,000 (`strategy-autopilot.js:36`) is a July choice;
  - 3,000 caps synthesised periods and the manual backtest (`ctrader-ws.js:756`, `actions.js:388`).
- **So the backtest is shallow by our choice.** 1,000 bars of 5m is 3.5 days of crypto or FX, or about 13 stock sessions, and the walk-forward then cuts that into four slices.

### What backtesting over weeks, months or years takes

Three changes, all in Node, with no new service:
1. Ask for more bars per request.
2. Page backward: the next request ends just before the oldest bar received, repeated.
3. Store closed bars, so each sweep fetches only new ones. This is H-1/H-2.

**Cost** (a calculation, at 999–1,000 bars per request): a one-off backfill of 90 days of 5m, 1 year of 1h, 2 years of 4h and 5 years of 1d is about:
- 42 requests per crypto symbol;
- 32 per FX symbol;
- 11 per US stock.

For 24 crypto symbols that is about 1,000 requests: roughly 4–7 minutes at our pace, using only the spare share of the budget. The scan used 1.45 requests per second at 03:57Z. Backtest CPU grows with the bar count.

**Effect on the plan.**
- **S-3** adds `minBars` + 1 as the fetch margin.
- **H-2's backfill** becomes a small, bounded job, not a new service. It is still ask-first on depth (D16).
- **The D18 trigger** stays the gate for a permanent store.

**Not verified:**
- today's per-response cap;
- whether an over-long request is rejected (`INCORRECT_BOUNDARIES`) or quietly truncated;
- whether `hasMore` is set on trendbar responses;
- each symbol's history depth at the broker.

Each needs one measured request; they are measured before H-2 is built.
