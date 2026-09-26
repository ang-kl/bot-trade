> **DRAFT, not yet checked.** Written 26-09-2026 12:33 SGT. Two independent checks are running on it (facts, reasoning), followed by one revision. The checked version replaces this file in PR #1143. Nothing in it is built until the owner approves. The plan it integrates with V3 is `docs/plan-ui-and-strategy-review-2026-09-26.md`, in the same folder.

# V3 + requests 1 and 2 — one integrated plan

26-09-2026

**PLAN — awaiting owner approval; nothing below is built. Supersedes the separate sequences in V3-SEQUENCE and docs/plan-ui-and-strategy-review-2026-09-26.md §8 for ordering; those documents keep their detail.**

Times are UTC ("Z") unless marked SGT. "…0058" is account 46130058, "…0949" is 47790949. PF is profit factor; R is profit in units of the risk taken. "The new plan" means `docs/plan-ui-and-strategy-review-2026-09-26.md`. A "Node restart" is what every merge causes: the agent and the website restart together, and position management pauses while they do.

Plain words for code terms used below:
- **Resting order:** a LIMIT or STOP order waiting at the broker for a price.
- **Pre-order (PRE):** a resting order the bot places while the symbol's market is shut, to fill at the open. The bot labels these `PRE`.
- **Higher-timeframe (HTF) limit:** a resting order for a 4h-or-longer signal, placed in an open market and expiring at the next bar close.
- **Momentum book / tsmom_long:** the one strategy still allowed to trade (on …0058, trial to 19-12).
- **T4:** the V3 step that lets momentum entries carry the partial-take-profit plan. Until it merges, every momentum entry is refused for having no TP1.
- **Read-back:** reading production after a deploy to confirm the change behaves as predicted.

---

## §0 The answers first (P1)

### (1) Pre-orders when the market is closed: **partly — yes for crypto (an open market, through the resting limit T4 brings back), no for closed markets for now**

- **Crypto is not closed on Saturday or Sunday.** The bot keeps scanning crypto through weekend quiet (Fri 16:00Z – Sun 17:00Z; `agent/lib/quiet-hours.js:45-52`). So a weekend crypto order is not a pre-order. It is an ordinary order in an open market. The right tool there is the HTF limit, which expires at the next bar close. That tool comes back for momentum with V3's T4. **Recommend yes, inside T4, after the momentum book stops depending on the scan (S-2).** The evidence is thin: HTF limits scored PF 3.09 in R over only 18 setups.
- **Stocks, indices and FX shut at the weekend.** The bot already has a pre-order path. Its record across all closed-market placements (weekend and overnight) is negative:
  - 40 setups, PF 0.42 in R, −11.40R;
  - the nine placed on Sunday 06-09 all filled and all lost (−5.63R);
  - (lane read of `/state/trades` and `/state/risk-events`, 03:42–03:45Z).

  It also has three design faults:
  - resting orders do not count toward the position caps: …0949 holds 12 positions against a cap of 5 (03:42:51Z);
  - the risk gate is never re-run at the open (`agent/lib/exec-engine.js:571-572`, lane read);
  - price gaps fill orders beyond the setup's own stop (12 of 77 fills).

  **Recommend no pre-orders into closed markets now.**
- **Which strategies could qualify later.** Only level-based setups on 1d or 1w bars:
  - fib_confluence's zone edge;
  - ema_pullback's EMA20;
  - vp_value's value-area edge, after its session fix (D15).

  Not the breakout strategies, not tsmom into a closed market, and nothing below 4h.
- **Measure first:**
  - weekend and overnight gaps, in ATR and R, per asset class (PO-M2);
  - shadow-scored pre-order levels, to 30 closes (PO-M1);
  - the spread at the fill of a limit, which is recorded on 0 of 122 PRE fills today (PO-M3).
- **How it touches V3.** T4 would turn momentum resting entries back on, including closed-market ones. So H-P0-2's single yes is split in two (OD-1).

### (2) How much of V3 changes

| Measure | Number |
|---|---|
| Merged V3 work changed | **0** items re-opened. Two merged pieces get latent fixes: UI-4 fixes #1071's readiness read; UI-3 extends WEB-1 (#1115) |
| Open V3 items (28 = 15 owner-gated, 4 conditional, 9 follow-ups) | **14 unchanged · 3 acceptance only** (the trace rule) **· 8 changed** in order, inputs or acceptance **· 2 superseded or absorbed · 1 newly blocked** |
| Frozen groups whose acceptance wording changes | **7 of 8** (all but P5a), plus the REC and WEB rows |
| New build items | 23 from the new plan (12 with no V3 home, 11 attached to a V3 item), plus **5** from this synthesis |
| Owner questions | About 80 open V3 questions plus the new plan's 22, **merged into 42 decisions** (§6) |
| Monday timeline | Unchanged **if** the no-answer items merge this weekend, your answers arrive by Mon 01:00Z (09:00 SGT), and Monday's merges stop at 13:00Z. Otherwise the load window moves to Tue 29-09 (*inference*, §7) |

### (3) The recommended order

1. **This weekend** (Wave 1). Build and merge the 12 new-plan items that need no answer (S-2 waits for your yes), plus V3's inert follow-ups:
   - the manual-order safety fix;
   - the UI and performance-trace items;
   - honest arming records;
   - the bar-path fixes;
   - the closer deferral T4 needs.

   About 7 Node restarts, finished by Sun 20:00Z, before the non-crypto markets reopen.
2. **Monday before 13:00Z** (Wave 2). Merge the owner-answered V3 chain. Two order changes: S-2 (with V3's F2) is placed in front of T4, and K3 moves forward. T4's closed-market half stays off.
3. **Mon 13:30–16:00Z.** The P1/P4 load window, with no merges and no traces.
4. **Afterwards** (Wave 3):
   - the gateway window (GW-1);
   - holidays on the entry path (S-8), before HKEX's 01-10 holiday;
   - the shadow and fold (S-4, S-5);
   - W3, after CV-2's soak;
   - Q2.
5. **Only after evidence** (Wave 4):
   - any strategy restore (S-6);
   - the bar store;
   - any pre-order rules.

---

## §1 Sources and method (P2, P4)

**Read in full:**
- the new plan (§0–§14, D1–D22);
- `V3-SEQUENCE.md`, including its 25-09 21:30 SGT decisions and the X1-window notes;
- `reply-9440.md`;
- `docs/v3-closure-2026-09-24.md`, lines 1–220;
- `docs/claude-takeover-2026-09-25.md`;
- `docs/dual-environment-plan-2026-09-25.md`, lines 1–80;
- the relevant lines of `docs/v3-momentum-exit-coordination-2026-09-25.md` (:200-245);
- the roadmap v2.2 item list (`items-v2.2.json`: 68 items, including 15 owner-gated and 4 conditional) and `refresh-v2.2.json`;
- the planned-date assumptions in `roadmap/data.py`.

**Not re-read line by line.** `SEQUENCE.md`, `LIFECYCLE-SPEC.md` and the other `docs/v3-*.md` files are used through the V3 inventory lane, which read them.

**Three lane reports** (inputs, each with its own read times):
- the V3 inventory (03:39–04:05Z);
- the weekend pre-order study (03:42–03:58Z);
- the new-plan-to-V3 map (04:12–04:21Z).

Where they disagree, I checked (below).

**My own reads:**
- **Production:** GET `/health` at 04:24:46Z: commit `22bcd29` (B4c, #1145), uptime 774 s, 0 errors today, 26 open positions, version 0.1.381.
- **GitHub:** open PRs at about 04:25Z: only #1143 (draft, head `e0249f1`).
- **Code:** checked at `22bcd29` in the read-only worktree, which is clean:
  - `entry-producers.js:54-59`;
  - `closed-market-limits.js:28-30`, `:343-354`, `:397-432`, `:463-467`;
  - `loop.js:388-449`, `:4099-4135`, `:4256`, `:4721`, `:5605`;
  - `momentum-book.js:313`, `:319`;
  - `momentum-account.js:67`, `:271-275`, `:473`;
  - `exec-engine.js:586-601`; `pending-signals.js:34`;
  - `client-presence.js:141`; `watchdog-contract.js:8`; `scanner-work.js:5`; the watchPatterns in every `railway.json`.

**Disagreements, and how they were settled:**
- **Is `closed_market_limits` retired?** Both lanes are right.
  - The scan's own producer is retired (`agent/lib/entry-producers.js:54-59`).
  - The module is still a transport for the momentum account and the manual-assisted routes. It is on by default (`closed-market-limits.js:28-30`), and the fence is keyed on the caller (`:343-354`).
- **B4b and B4c.** The task text called them in flight. B4b merged as #1144 (04:01:36Z) and B4c as #1145 (04:11:07Z); production ran `22bcd29` at 04:24:46Z.
- **"Numbers for partial TP1" (reply-9440 Q8).** This is superseded. On 24-09 you replaced the numeric request with evidence-based formulas (`v3-closure:72-76`). What remains is H-P0-1, H-P0-2 and H-P0-5.
- **Does the daily momentum pass run on weekends?** `V3-SEQUENCE:729` says weekdays. `dailyDue` (`momentum-account.js:271-275`) has no weekday test. Whether its caller filters by weekday is **not verified**.

**Method.** I did no new analysis of trades. Every figure below is either my read (with its time) or a lane's read (with its time). Calculations and forecasts are labelled *inference*.

---

## §2 V3 today

Production `22bcd29` at 04:24:46Z. None of the eight frozen groups is accepted.

| Group | Merged, and read back where stated | Open | Blocked by |
|---|---|---|---|
| P0/P3 partial TP | T1, T1b, T2, T3 (#1091, #1110, #1124, #1132). T3 **read back Passed** (03:42:45Z): 0 plans, INCOMPLETE, `executionAuthorized` false | T4; F1 (closer deferral); F2 (daily-exit hours) | H-P0-1, H-P0-2, H-P0-5 |
| P1/P4 load | M1 (**Passed**: boot record present; first loop 86,423 ms on the `22bcd29` boot, harness row 04:13:36Z), M2, M2b, M3 (harness PID 10750 running to about 28-09 22:05Z), M5 (0 amends yet) | M7; conditional M4, M6; the window | H-P1-1..4, M3-a..d |
| P2 calendars | K1, K1b, K1c, K2 (**Passed** 03:43:22Z: 136 of 136 demanded calendars; 7 of 7 accounts own their map) | K3, WEB-6b | H-P2-2 (= D7) |
| P5a watchdog | STK-08v2 (**Passed** 03:42:44Z; Telegram off, 57,807 unsent) | CV-2, W3 | H-P5a-1..6 |
| P5b/P5d money | B1, B2, B3, B4, B4b, B4c. B2 read 03:43:28Z: 2 money disagreements, 50 broker-only positions, 4 no-account rows still probing | B2b, B5. `/state/unknown-pnl` (03:43:35Z): 3 ambiguous, 2 "unresolved: no broker evidence" | H-P5b-1, -4 |
| P5c scanners | WP-A, PR-1, C3, C4, DEP-SQLITE, CV-1 (**Passed**: scanners skipped 8 Node-only deploys; `orderAuthority` false; tick cursor 0) | C5, C7, C8, C9, C11; runbook R6 (no record) | PR-5, -7, -8, -9, -11 |
| P6/P7 research | Q0 (read-back not verifiable until a sidecar restart), Q1, Q1b, Q3, Q4b | Q2; conditional Q5, GW-2 | H-P6-1..10 |
| P8 final | A1, GW-CAP (**Passed**: 20 and 5 GiB caps), R1 (**Passed**), R2 | GW-1; a soak host | H-P8-3..6 |
| REC and WEB | L1–L2b, X1, V1, I1–I3, WEB-1..10, WEB-8b | 6 new close records flagged CLS-04, which block the REC bar; F3; the website rows need your logged-in session | 9440 Q3, H-P5b-5 |

**In flight now:** only PR #1143, a draft that is the new plan itself (about 04:25Z). No branch exists for any of the 15 owner-gated items (inventory, about 04:0xZ). The roadmap's weekend pre-build was not done.

**The P8 T2 dates, corrected by calculation (inventory).** With GW-CAP's 20 and 5 GiB caps, the first natural spool retire moves:
- demo: from 03-10 to about late January 2027;
- live: from 05-10 to about 25-10-2026.

---

## §3 What the new plan changes in V3

### Open V3 items

| V3 item | Change | Why | Effect on acceptance or timeline |
|---|---|---|---|
| **T4** | Order and scope. After S-2, F1 and S-3. Its resting half is split: HTF limits in open markets go ahead; closed-market limits stay off (NEW, §4) | The book runs inside the scan branch (`loop.js:4256`, branch end `:4721`). The closed-market record is negative | Adds "book exits run with Scan off and in quiet hours". The first natural plan is **not datable**: …0058 holds 6 against its cap of 5 (04:19:42Z) |
| **C7** | **Newly blocked** and re-scoped | Its profiles cover only fib, rsi2 and donchian. Under D10's recommendation none of them trades. Its hours gate moves to S-8 | "First `scanner_timeframe` admission" needs D10(A) and S-6. Not datable |
| **C11** | **Superseded** by S-6 | D10 re-opens your 25-09 restore order | 0–1 strategies instead of 3 |
| **F6** | **Absorbed** by S-2 | S-2 adds the book's heartbeat | — |
| **K3** | Same item (D7). Moves earlier | S-8 depends on it | Deploy before 30-09 ~15:00Z (HKEX holiday 01-10) |
| **M7** | Inputs | S-3's token-wait counter and D22 feed the probe design | None |
| **M6** | Evidence | S-4 and D12 cut `decision_log` volume, which the decision audit reads | Re-measure after S-4 |
| **B2b** | Order | UI-5's "stop re-stamping" edits the same write-off path (`pnl-backfill.js:1013-1017`) | B2b with or before UI-5 |
| **B5** | Optional scope | D5's 28 plan corrections and the 7 mislabelled PRE rows can use its dry-run-then-named-apply mechanism | None |
| **F2** | Hours source | Use S-8's calendar; ship with S-2 | Changes when live exits are sent: ask-first |
| **F9** | Scope | The trace harness needs a host too, and a tag for synthetic presence | — |
| **W3, WEB-6b, F3** | Acceptance only | They touch website files, so they carry the trace table (D20) | +15–20 min per PR (*inference*) |
| **C8, C9, CV-2, C5, GW-1, Q2, M4, Q5, GW-2, F1, F4, F5, F7, F8** | **Unchanged.** GW-1 may carry D3's commit helper. F1 moves to Wave 1 | — | — |

### Acceptance wording that changes

| Group | Change |
|---|---|
| P0/P3 | Add: the book's exits run with Scan disabled, Scan off everywhere, and in quiet hours; the book beats a heartbeat |
| P1/P4 | Visible tabs exclude synthetic (trace) presence. The window measures the UI after the Wave 1 batch |
| P2 | Add: UNKNOWN never reads open on the entry path; a current 0/0 holiday reads closed |
| P5c | Admission needs D10(A) and S-6. Observation needs S-4 to keep the three profile strategies scanned |
| P6/P7 | D10 is judged on Q4b's frozen metric; the fib shadow verdict is a new milestone |
| P8 | The time-plus-tick comparison's "time" arm narrows to momentum only |
| P5b/P5d | Named correction records (D5); the re-stamp fix |
| REC and WEB | Arming-log completeness (S-1); trace tables (D20); row 2 re-scoped (UI-1, UI-3) |

### New items with no V3 home

- **From the new plan (12):** SAFE-0a, SAFE-0b, UI-2, UI-7, UI-8, PERF-0, PERF-1, PERF-2, S-3, S-5, S-7, HIST-1.
- **The 11 that attach to V3:** UI-1, UI-3, UI-4, UI-5, UI-6, S-1, S-2, S-4, S-6, S-8 and HIST-2.
- **From this synthesis (5):**
  - **NEW-1:** synthetic-presence tag. Trace runs stop counting as your visible tabs (`client-presence.js:141`). The M3 record already shows 9 visible tabs at 01:30:19Z and 8 at 02:49:28Z, from the headless and trace loads.
  - **PO-M1:** shadow-scored pre-order levels.
  - **PO-M2:** a gap study.
  - **PO-M3:** the spread at a limit's fill.
  - **PO-B:** pre-order rules, conditional.

**Renamed to avoid collisions:**
- the sidebar items S1–S3 become **SB1–SB3**;
- H-1 and H-2 become **HIST-1 and HIST-2**;
- A1 (the AI page) stays **UI-7**;
- the new plan's D1–D22 and V3's H-ids become **OD-n**, with the old ids kept in brackets.

---

## §4 The weekend pre-order answer, in full

### What exists (verified at `22bcd29`)

- **Two resting paths.**
  - Closed-market: `loop.js:388-449` → `placeClosedMarketLimit`.
  - HTF: after the evidence gate, `loop.js:~465-507`.
  - Both label the order `PRE` (`closed-market-limits.js:476`).
- **Who can still use them.**
  - The scan's producer is retired (`entry-producers.js:54-59`).
  - The daily momentum pass rests entries through the module: `marketOnly: false` (`momentum-account.js:473`). Its closed-market branch covers 22 US/HK stocks and 10 indices of its universe (`closed-market-limits.js:344-351`).
  - The pass runs after 21:05 UTC (`momentum-account.js:67`), which is after the US close.
  - The row-cursor book sends market orders only: `marketOnly: true` (`momentum-book.js:319`).
- **Why nothing places one today.**
  - tsmom's entry carries `tp1: null` (`momentum-book.js:313`). The bracket guard refuses any entry without a take profit (`exec-engine.js:586-601`).
  - …0058 is at its cap.
- **The controls on a resting order.**
  - **Risk gate:** at placement only (`closed-market-limits.js:429-432`).
  - **Expiry:** 3 days by wall clock (`pending-signals.js:34`).
  - **Caps:** the only limits are one per symbol per account and 20 across all accounts (`:387-403`).
  - **Positions:** the position caps count positions only (`risk.js:1416`, lane read).

### The evidence (lane reads, 03:42–03:58Z)

| Slice | Size | Result |
|---|---|---|
| All PRE closes | 122 | PF 0.80 in R (−9.53R); money PF 0.51 |
| Closed-market placements, per setup | 40 setups (77 fills) | **PF 0.42 in R, −11.40R** |
| Sunday 06-09 placements | 9 | 9 filled, 9 lost, −5.63R |
| Closed-market momentum | 10 setups | PF 0.49 (too few) |
| HTF limits (open markets), per setup | 18 setups (28 fills) | **PF 3.09 in R, +4.15R** (too few to judge) |
| Crypto opened in weekend quiet | 89 closes | PF 0.11 in R. Mostly burn-in and 5m/15m intraday (*inference*: evidence against intraday weekend crypto, not against the book) |
| BTCUSD entry spread | 13 weekend, 24 weekday | Median 2.31 bp in both |

**Why closed-market fills lose.** Of 77 fills, 23 filled 0.25R or more past the level. Twelve filled beyond the setup's own stop level; the worst was AVGO.US at 2.46R. A relative stop then moves with the fill (`momentum-target-policy.js:59-60`, lane read). So the gap does not cut the loss; it resets it. Fills cluster at the US and HK opens.

### Recommended rules, if pre-orders are ever built (PO-1 … PO-8)

1. A level from closed bars on 4h or longer, preferably 1d or 1w. The order type matches the idea; a breakout needs a stop-entry type, which does not exist.
2. A short expiry: the signal bar's close, or the open plus one bar. Not 3 days.
3. A gap guard in the pre-open window: cancel if the price is beyond the stop, or more than X R through the level (X is yours).
4. The risk gate is re-run before the open.
5. Resting orders count toward the caps (5, the book's 8, per symbol) and reserve margin. The values stay; how they count changes. **Ask-first (OD-15).**
6. TP1 is mandatory (T4).
7. The PRE label and the preopen basis stay separate. The 7 PRE rows labelled `external` are corrected by a named record (OD-12).
8. Holidays go on the entry path first (S-8).

### Measure first

| Id | What | Needs | Bar |
|---|---|---|---|
| PO-M1 | Shadow-score the levels of fib 1d/1w and ema_pullback 1d | S-4 (a shadow with levels), OD-9 | 30 closes each |
| PO-M2 | Weekend and overnight gaps in ATR and R, per asset class | Bars with S-3's margin; bounded broker reads (§14 of the new plan: about 11–42 requests per symbol) | A distribution to set rule 3's X |
| PO-M3 | Record the spread at a limit's fill | A small Node change, record only | Present on every new PRE fill |

### ASK-FIRST

- Turning pre-orders on for any strategy.
- Anything on the 3 live accounts (principle 1 makes them equal, not exempt).
- A stop-entry order type.
- Rule 5's counting change.
- Changes to expiry or `pre_open_hours`.
- Anything that closes …0949's 12 positions.
- Your manual resting orders: two Cocoa BUY STOPs on …0949 and a BTCUSD LIMIT on …3489, all without a stop (03:43:32Z).

---

## §5 The ONE integrated build sequence

### Standing rules for every wave

- **The full gate** as in CLAUDE.md, with a fresh TMPDIR. Every mutation check is confirmed applied with `grep -c` before and after.
- **Read-back after every deploy:**
  - `/health` commit and errors;
  - the item's own route;
  - `/state/heartbeats`;
  - all positions protected.
- **The trace rule** (the new plan §13). Every PR that touches `src/` or a route the website reads carries a before-and-after table:
  - the median of 3 fresh runs per page and profile;
  - Home plus each touched page, on desktop and phone;
  - the certificate lines.

  Two limits on the traces:
  - **No traces inside a graded P1/P4 window.**
  - **NEW-1 lands first,** so later traces do not count as your visible tabs.

  A regression beyond D21's floor blocks the auto-merge once OD-13 is answered. Until then it is reported and asked.
- **Batching.**
  - Pair small PRs and merge back to back within the hour.
  - Plan PR #1143 and this plan ride the first code batch.
  - No gateway code outside a gateway window. No new-plan item touches `cpp-exec/**` or `agent/lib/exec-engine.*`.
  - S-7's native parity restarts only cpp-scan-timeframe.
  - The root `railway.json` has no watchPatterns, so every merge restarts Node.
- **Pre-building.** Answer-gated items are built on draft branches with the recommended defaults while you decide. They merge only after your answer.

### Wave 1 — this weekend, no answer needed (Sat 26-09 → Sun 27-09 20:00Z)

Seven merges, so seven Node restarts. Crypto keeps trading, so each merge briefly pauses management of the crypto positions.

| # | Items (origin) | Scope and proof | Gate |
|---|---|---|---|
| 1.1 | PR #1143 + this plan + **PERF-0** (new) + **NEW-1** + **SAFE-0a** (new) | Harness in `scripts/perf-trace/`. Presence tag: a tagged ping leaves `visibleTabs` unchanged; mutation: drop the filter, and the test goes red. SAFE-0a: the confirm names the account (`Trade.jsx:620-633`); mutation 1→0. Trace: Trade, Home | Auto on green |
| 1.2 | **UI-1 + PERF-1** (new; extends WEB-1) | The new plan §8 item 1 and §13. The collapse control is visible, remembered and has section ids; heights are reserved; the font preload is fixed. Proof: CLS median falls on Performance and Reasons | The visual standard awaits OD-17 (default (a)) |
| 1.3 | **UI-2 + UI-3** (new; extends WEB-1, C4) | §8 items 2–3. UI-3 must keep cpp-verify's relayed counts and the watchdog contract under 256 KiB: `watchdog-contract.js:8` and `scanner-work.js:5` import `blocker-report`. Read-back: …0058 on your phone | OD-18 default |
| 1.4 | **UI-4 + UI-7** (extends WP-A and #1071; new) | SB1 and SB2: the readiness object bug, "no record", and the build commit through a Dockerfile ARG. The AI page reads "off". Read-back: the web and agent commits match | OD-21 default; OD-20 not needed |
| 1.5 | **UI-6 + PERF-2 + F3** (extends L1's UI; new; V3) | The Reasons order and tables; the digit tree as text; the WEB-9 wording plus the 1130.17 fixture | UI-6 merges after OD-19 |
| 1.6 | **S-1 + S-3** (extends REC; new) | Appended arming rows, never updates. The picker ranks by armed strategies. Per-account cells take effect or are refused. Depth margin `minBars`+1; Phase 0 counters. Read-back: all 91 cells "recorded"; scanner mirrors matched > 0 and mismatch 0 (S-3 changes `job.bars`); the book's crypto pass still runs | …0058's 39 extra pins excluded (ask-first) |
| 1.7 | **F1 + F4 + F5-N6 + PO-M3** (V3; new) | F1: horizon deferral in profit-keeper, loss-guardian, trade-guard and weekend-bank (inert while plans are 0). F4: a tick-feeder stall alarm. N6: the lifecycle rule on the non-strict path. PO-M3: record only | Auto on green |

**Dependencies:** 1.1 goes first (NEW-1 before any trace). 1.2 before 1.3 (PERF-1 before UI-3, per §13). 1.6 before Wave 2's T4 and M7.

### Wave 2 — Monday 28-09, 01:00–13:00Z, each item after its answer

| # | Items (origin) | Scope and proof | Gate |
|---|---|---|---|
| 2.1 | **S-2 + F2 + F6** (new plan; V3) | The book and the daily pass move out of the scan branch (`loop.js:4256` → after `:4721`). The daily exit checks hours through `symbol_hours` and marks `exit_pending` (the KO.US `MARKET_CLOSED` shape). A `momentum_book` heartbeat. Tests: exits run with Scan disabled, off everywhere, and in quiet with no crypto. Read-back: the first weekday pass (Mon 21:05Z) and the first weekend pass (Sat 03-10) | **OD-2** |
| 2.2 | **C8 → C9** (V3) | V3-SEQUENCE §1 items 29–30 | **OD-6** |
| 2.3 | **CV-2** (V3) | Item 26. Restarts cpp-verify and Node. The 24 h muted soak starts | **OD-10**; auto on green (PR-6) |
| 2.4 | **T4** (V3; scope NEW) | Item 32, plus a named refusal for a closed-market momentum entry while open-market HTF limits rest with their plan. Test and mutation for the refusal. Read-back: `/state/momentum-targets` wiring reads "wired" for market and limit | **OD-1, OD-3**; after 1.6, 1.7, 2.1 |
| 2.5 | **K3 + SAFE-0b** (V3; new) | Item 34. Read-back after a full collector sweep (20–30 min). SAFE-0b refuses a stale or other-account Re-Risk apply | **OD-7, OD-14** |
| 2.6 | **M7** (V3) | Item 33, fed by S-3's token-wait counter. Prediction: skip share ≤ 10 % in a US-closed hour | **OD-22** |
| 2.7 | **B2b + UI-5** (V3; extends B1/B2) | B2b first in the same batch, then the re-stamp fix, gross-P&L consistency, refusal-time window and plan flags | **OD-11, OD-12** |

**Stop merging at 13:00Z,** so the last restart settles before the window.

**Mon 13:30–16:00Z, plus a US-closed hour around 20:00Z: the P1/P4 window.**
- No merges, except one intended restart (OD-4).
- No traces.
- You keep Desk and Performance visible.

### Wave 3 — after the window (Mon 16:00Z → Wed 30-09)

| # | Items (origin) | Scope and proof | Gate |
|---|---|---|---|
| 3.1 | **GW-1** (V3) | Item 38; the sidecar commit (D3, TM-37). Both gateways plus Node. Read-back: every account connected, positions protected, the recorder RECORDING, GAP_RESTART as the first record; Q0's restart-loss count gets its first real test | **OD-6**; your window |
| 3.2 | **S-8 + WEB-6b** (extends K3/C7; V3) | Holidays on the entry path (`isSymbolOpenCached`, `loop.js:389`). UNKNOWN never reads open. **Deploy by 30-09 ~15:00Z** (HKEX's 01-10 holiday starts at 30-09 16:00Z) | **OD-7, OD-8** |
| 3.3 | **S-4 → S-5** (extends the evidence shadow; new) | The declared shadow set keeps fib, rsi2 and donchian scanned as the reference for the 690 timeframe profiles (`loop.js:4200` → `recordReference`). Every one of the 10 `decision_log` readers sums `repeat_count`. The watchdog contract stays ≤ 256 KiB. Read-back: shadow refusals > 0 with levels; mirrors unchanged | **OD-9, OD-16** |
| 3.4 | **W3** (V3) | After CV-2's 24 h soak. Calling the route is ask-first | **OD-10** |
| 3.5 | **C5, UI-8, B5** (V3; new; V3) | Items 28 and 36; the new plan §8 item 10 | **OD-23, OD-20, OD-12** |
| 3.6 | **Q2** (V3) | Item 37 | **OD-24** |
| 3.7 | **PO-M2** (new) | Gap report, read-only broker history, within the 4-per-second budget | Auto on green (report only) |

### Wave 4 — only after evidence (no dates promised)

| Item (origin) | Starts when | Gate |
|---|---|---|
| **S-6** restore, per strategy (supersedes C11) | Its shadow reaches 30 closes and passes the bar; D17 applied; an order path chosen: C7 re-scoped, or a fence allow-list (which conflicts with `v3-closure:191`) | OD-5(A), OD-29 |
| **C7** re-scoped | Only if S-6 routes through admission | OD-5 (its PR-7 part) |
| **PO-M1 → PO-B** pre-order rules | PO-M1–M3 support it | OD-1(b), OD-15 |
| **HIST-1** bar store; **HIST-2** backfill | The D18 figure is crossed; the depth is set | OD-28 |
| **S-7** logic fixes, then walk-forward | After Q4b; with Q2's discipline | OD-27 |
| D14 sweep; the twelve bare sections; table migrations | — | OD-26 (cancels one by one) |
| M4, M6, Q5, GW-2 | Their V3 triggers | V3 |

---

## §6 ONE decision register

Most-blocking first. "Default" means built on a draft branch and merged only on your word. H-P0-3 and H-P0-4 shipped as defaults in #1124 and #1132, with no objection recorded. They are listed at the end.

| # | Question [old ids] | Options | My recommendation | Blocks |
|---|---|---|---|---|
| OD-1 | Resume momentum entries after T4? [H-P0-2 split; the pre-order question] | (a) market orders and open-market HTF limits; (b) closed-market limits; on the Trade-armed accounts, or on all 7 including the 3 live | **(a) yes, on the Trade-armed accounts (…0058's trial). (b) no** until PO-M1–M3. Widening to all 7 is a separate yes | T4 merge; P0/P3 |
| OD-2 | Book out of the scan branch; hours-aware daily exit? [S-2; F2] | Yes / no | **Yes, both.** It changes when exits run for 22 book rows | S-2 → T4 |
| OD-3 | T4 parameters [H-P0-1, H-P0-5, F8] | Swap in C: exclude, broker rate × nights, or cap; deferred binding yes/no | **Broker rate × median nights; yes.** F8 (multi-deal anchoring) checked from fills first | T4 build |
| OD-4 | P1/P4 limits and window [H-P1-1..3, M3-a..d] | Confirm or replace | **Confirm the proposed limits. Window Mon 13:30–16:00Z plus 20:00Z. Skip share 10 % joins. Both tabs visible on your device. The harness stays here until OD-38's host exists. goal-table stays off (12.4 s stall)** | P1/P4 acceptance; **answer by Mon 13:00Z** |
| OD-5 | Restore fib, rsi2, donchian? [D10; PR-11; the 25-09 restore order; PR-7 only if (A)] | (A) restore at half risk; (B) score the shadow first; (C) withdraw | **fib (B); rsi2, donchian (C)**, but kept scanned as unarmed reference until the profiles are re-registered | S-6, C7, C11, S-4's set, P5c admission |
| OD-6 | Gateway chain [PR-8, PR-9, PR-10, H-P8-3] | V3-SEQUENCE §3 options | **The V3 defaults. A weekday gateway window outside the P1/P4 window; demo first by pausing cpp-acct auto-deploy** | C8, C9, GW-1; the tick auto switch; P8 T1 |
| OD-7 | Does a current 0/0 holiday row mean closed all local day? [H-P2-2 = D7; the K1b residue] | Yes / no | **Yes**: the worst case reads closed when open, never the reverse | K3, S-8, WEB-6b (need-by 30-09) |
| OD-8 | Which hours source gates entries? [H-P2-3, O3, S-8] | `symbol_hours` by name, or the account calendar | **The account calendar for every entry** (this flips V3's "no for closure" default) | S-8; C7's gate |
| OD-9 | Score refused strategies; fold standing stops? [D11, D12] | Score or stop scanning; fold or every minute | **Score the (B) candidates and the PO-M1 levels; fold, with sums kept and every line expandable** | S-4, PO-M1 |
| OD-10 | Watchdog delivery [H-P5a-1..6, 9440 Q2, LIFECYCLE 5] | Recipient, observer host, severity floor, restart paging, backlog, `/notify on` | **Same chat; a VPS observer; urgent only; accept paired restart pages; dispose the backlog after a `/data` backup; delivery held until after the soak** | CV-2, W3, P5a |
| OD-11 | Write-off rule [H-P5b-4; your 25-09 rule; B2-Q3; B2-attr] | Require a broker verdict; stamp order links | **Yes. A history with no deals reads `never_filled`. An account is written onto a row only from broker evidence** | B2b → UI-5 |
| OD-12 | Named corrections [H-P5b-1, D5; PO-7] | Dry run, then a named apply | **Yes, nothing deleted**: money fixes, never-filled rejections, 28 plans, 7 PRE labels | B5; UI-5's plan part |
| OD-13 | Trace rule and thresholds [D20, D21] | Standing, or this plan only | **Yes, as proposed** (it edits owner-confirmed CLAUDE.md text) | The merge gate for website PRs |
| OD-14 | Re-Risk Apply guard [D6] | Refuse; refuse and confirm; leave | **Refuse if older than 7 days or for another account; otherwise confirm, naming the keys** | SAFE-0b |
| OD-15 | Count resting orders toward the caps and margin? [PO-5] | Yes / no | **Yes. The values are unchanged** | PO-B; OD-1(b) |
| OD-16 | Autopilot and watchdog flip the shared list? [D13] | Stop / keep | **Stop** | S-5 |
| OD-17 | Collapse standard; memory [D19, D8] | (a) triangle; (b) the Card's ▾ | **Tell me what your phone shows; then (a), remembered on every page** | UI-1's look |
| OD-18 | Blockers fold and pre-fix labels [D9] | Fold; list all; hide | **Fold, labelled per row until they age out (≈26-09 22:46Z)** | UI-3 |
| OD-19 | Go-live card [D4] | Remove; new date; none | **Remove** | UI-6 |
| OD-20 | Picker location and order routing [D2] | Under TRADING; one at the top | **Under TRADING; orders keep going to the trading account** | UI-8 |
| OD-21 | Version display [D3] | Bump; show commits | **Show web and agent commits** | UI-4's SB2 |
| OD-22 | M7 probes; Trade page snapshot [H-P1-4, D22] | V3 design; 5 s or 15 s | **Parallel probes under a cap, backoff ≤ 5 min; keep 5 s while visible, measure with your key** | M7 |
| OD-23 | Equity-stop push per side [PR-5] | V3 options | **The V3 default** | C5 |
| OD-24 | Research path [H-P6-1..5; the D3 window] | V3 options | **Pooled replay; the tightenings yes; S0–S5 and the 27-trial budget; the holdout declared by 28-09; three 30-day windows** | Q2; stage A |
| OD-25 | Later research inputs [H-P6-6..8, H-P6-10, Q3-ret] | — | **Keep segments and regime rows** (regime rows before about 11-10). **Slippage from measured fills** | Later P6/P7; S-7 |
| OD-26 | Retire fib_618_fade; ema_pullback; cancels [D14] | Retire and cancel; retire; no | **Retire fib_618_fade; ema_pullback after the overlap measure; each cancel listed** | D14 sweep |
| OD-27 | vwap anchors and va/vp sessions [D15] | Fix and review; retire | **Fix, then review** | S-7 |
| OD-28 | Bar store, backfill and compaction [D16, D18; 9440 Q9 compaction] | Phases now; on a trigger; wait | **Phase 0 now; the store only past p95 token wait > 5 s or > 5 % deadline hits; backfill 2 years of 1h as research** | HIST-1, HIST-2, PO-M2 depth |
| OD-29 | 16 symbols armed only on unscanned timeframes [D17 = 9440 Q9 arms] | Add timeframes; re-arm; show | **Show them as unreachable now; add 4d, 3d, 12h and 8h only with a restore** | S-6 |
| OD-30 | Tick switch and ownership [D1; H-P6-9; the tick owner; PR-2 (a), (c)] | — | **Fix the label now; tick stays blocked under your thresholds; imports by you only** | UI-4's label; the auto switch after C9 + GW-1 |
| OD-31 | Roster [H-P2-1 (a)–(d); the H-P0-2 account conflict] | — | Your wording is needed. The pins arm tsmom on …0058 only, while `momentum-account.json` says `_all` | P2 acceptance; OD-1 accounts |
| OD-32 | Goal semantics, REC start and bar [H-P5b-3; LIFECYCLE 1; the REC bar] | — | **Unrecoverable rows shown apart and not counted; confirm 25-09 08:50Z and "one full day with no new flag"** | P5b and REC acceptance |
| OD-33 | 6 positions with no reason; refuse reasonless approvals [9440 Q3; LIFECYCLE 3] | Set reasons; final "none" | **Final "no reason recorded"; yes, refuse** | The REC bar (CLS-04) |
| OD-34 | Your logged-in session, 30–60 min [H-P5b-5; the 24-hour disconnect question] | — | **After Wave 1**: it checks the WEB rows, OD-17 and B4 | WEB and P5b acceptance |
| OD-35 | Broker-only positions [H-P5b-2; W15] | Join the populations; report only | **Report only, labelled** | W15 |
| OD-36 | Calendar bound; money-contract closure [K1c-Q; H-P2-4] | — | **Keep the bound, demanded first. The money items move to P5b** | P2 closure statement |
| OD-37 | Small record switches [9440 Q5–Q7; I3-R7, I3-N7; B1-fee, B1-N7; P5bd-5; LIFECYCLE 4] | — | **Keep I3-R7 off (it amends live TPs); I3-N7 yes; the conversion fee stays out; the lesson tuner does not read rejected rows; L2a uses `findLimitFill`'s evidence rule; X1's "unresolved" becomes its own state; label a partial hour "partial"; confirm fixed deposit currencies** | Small follow-ups |
| OD-38 | Storage and hosts [9440 Q1, Q9; H-P8-2, -4, -5, -6; F9; the PERF-0 host] | — | **Keep 50 GB until retention days are set; weekly volume backups; one soak and harness host** | P8 T3–T5; the M3 host |
| OD-39 | Positions and orders outside the rules [PO ask-first] | — | **Leave …0949's 12 to their stops; your 3 manual orders stay yours; no stop-entry type now** | None; recorded |
| OD-40 | Leftovers [the gateway `/health` "until Monday"; tick-liveness calendars; "reseted?"; 8,991·C2; H-P1-5 logs] | — | Your wording is needed; no content found in any source | None |
| OD-41 | Pre-build the gated items on branches this weekend [roadmap data.py:182] | Yes / no | **Yes** | The Monday timing |
| OD-42 | NOT_EXECUTED terminal; 5-minute trigger [H-P0-3, H-P0-4] | Shipped defaults | **Keep** | None |

---

## §7 The timeline (*inference*)

**Assumptions:**
- two builders;
- about 50 min per S or M item, including the expected fix round;
- 19 min between serial merges;
- a checker "fix first" rate of 4 in 10 (`roadmap/data.py`);
- your answers by Mon 01:00Z;
- no CI outage.

| Milestone | Planned (V3, roadmap v2.2) | Revised |
|---|---|---|
| No-answer UI and engine items | Not in V3 | Sat 26 – Sun 27-09, about 7–9 h including traces; 7 restarts |
| Owner-gated V3 chain "all merged" | Mon 28-09 ≈ 12:50Z (20:50 SGT) | Wave 2's subset by 13:00Z. GW-1, S-8, S-4/S-5, W3, C5, UI-8, B5 and Q2 follow from Mon 16:00Z to Wed 30-09. C7 and C11 are not dated |
| P1/P4 load window | Mon 28-09 13:30–16:00Z | Unchanged if merges stop at 13:00Z; otherwise Tue 29-09 |
| First natural T4 plan | 28-09 21:05Z | **Not datable** (…0058 holds 6 of 5; S-2 goes first) |
| K3 in place | Mon 28-09 08:11Z | Mon 28-09; S-8 by 30-09 ~15:00Z |
| P5a soak ends | CV-2 + 24 h (29-09 04:01Z) | The same, if CV-2 merges early on Monday |
| P5d 7-day, 30-day windows | 29-09 and 22-10, 17:30Z | Unchanged |
| P2 weekend, DST | 02-10, 04-10, 05-10; 25-10, 01-11 | Unchanged |
| P6/P7 stage A | 30-09 to 02-10 | Unchanged if OD-24 is answered by 28-09 |
| fib shadow verdict (OD-5 (B)) | — | New; not datable (the rate of shadow opportunities is unmeasured) |
| P8 T2 first retire | demo 03-10, live 05-10 | demo about late Jan 2027; live about 25-10 |
| Momentum checkpoint | 19-12 | Unchanged |

---

## §8 Invariants (P3)

| # | Invariant | Result |
|---|---|---|
| 1 | This synthesis changed no repo or production state | **Passed, with one disclosed slip.** One GET `/health` and one GitHub read; the worktree stays clean at `22bcd29`. A scratch copy of `/health` was written in `scratchpad/plan/` and deleted within a minute |
| 2 | Thresholds, caps (5 and the book's 8) and mandatory TP1 are unchanged by the plan | **Passed.** OD-15 changes what counts, not the values, and is ask-first |
| 3 | Gateway code ships only in a gateway window | **Passed by construction** (watchPatterns checked) |
| 4 | No merge or trace inside the P1/P4 window | Not verifiable until run; it is a plan rule |
| 5 | Owner-confirmed CLAUDE.md text is untouched without your yes | **Passed** (OD-13) |
| 6 | Principle 1: live and demo alike | **Passed.** Every enablement names the live accounts |
| 7 | Principle 3: carried blockages addressed | **Failed today**: the unbuilt restore, the book inside the scan, the TP1-blocked tsmom, the cap bypass. Each is scheduled |
| 8 | Principle 7: vetoes minimised | **Failed today**: 91.1 % of stops are self-inflicted (new plan §4); S-1, S-4 and OD-29 address them |
| 9 | Principle 5: plans match code | **Failed today**: `dual-environment-plan:74` against the takeover; `V3-SEQUENCE:729` "weekdays" against `dailyDue` |
| 10 | Every number carries a source and time | Not verifiable as a blanket claim. Lane numbers carry the lanes' times |
| 11 | No colour-only signal | **Passed** |
| 12 | No id collisions in this plan | **Passed** (§3 renames) |

---

## §9 Not verified, and the risks (P6)

### Not verified

- **B4b and B4c.** Their behaviour after deploy is not read back; only the commit is (04:24:46Z).
- **The Trade-cell gating of the daily pass** on the other 6 accounts (OD-31).
- **The daily pass on weekends:** `dailyDue` has no weekday test; its caller was not checked.
- **Pre-order unknowns:**
  - whether cTrader accepts an absolute SL on a closed-market LIMIT;
  - the gap distribution;
  - the spread at limit fills;
  - the 17 PRE rows older than the risk-event window.
- **Your phone's view** (D19); the website rows on the logged-in site.
- **S-4's fold** against the 256 KiB contract.
- **The Railway build-time commit variable;** staging's staged changes.
- **The trace harness's absolute times** (the proxy adds a hop; comparisons on the same harness are valid).
- **The content** of 8,991·C2 and "reseted?".
- **Every date in §7** (inference).

### Risks

1. **T4 turns trading back on.** OD-1 limits it to the armed accounts and to open-market orders. Widening it to the 3 live accounts is its own yes.
2. **S-2 changes when exits run** for 22 book rows. Read back the first weekday pass and the first weekend pass.
3. **Pre-orders can bypass the caps** (…0949 holds 12 against 5). Nothing re-enables them before OD-15.
4. **Every merge is a Node restart.** Wave 1 adds 7 on a crypto-trading weekend. Batching is the guard.
5. **Trace presence contaminates the M3 record.** NEW-1 lands first.
6. **S-4 can break the scanner reference.** The declared shadow set is the guard.
7. **D12 changes the numbers of 10 readers.** Each is tested.
8. **GW-1 restarts both gateways at once.** Demo first needs cpp-acct's auto-deploy paused.
9. **K3 and S-8 can miss 01-10.** If so, the first real-holiday test falls to the next holiday.
10. **Decision load.** 42 decisions. **OD-1 to OD-8 unblock most of Waves 2–3; OD-4 is needed by Mon 13:00Z.**
