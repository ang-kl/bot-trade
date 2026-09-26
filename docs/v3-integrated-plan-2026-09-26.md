# V3 + requests 1 and 2 — one integrated plan

26-09-2026 · checked version

**APPROVED by the owner on 26-09-2026**: #1143 merged at 12:46 SGT, then "I thought the plan is approved" at about 13:40 SGT. That also answers OD-0 yes (the UI defaults OD-17, OD-18, OD-19 and OD-21 apply). Wave 1 building since 13:44 SGT; every other decision in §6 stays open until answered, and ask-first items still need their own yes.
- **Checked:** two independent verifiers (facts; reasoning) at 04:58–05:10Z; this revision applies their findings (05:12–05:47Z; §10).
- **Replaces** the unchecked DRAFT that #1143 merged to main at 04:46:56Z. Its banner says the checked version "replaces this file in PR #1143", but #1143 is closed, so this file lands in its own docs change riding Wave 1's first merge (1.1). Until then main and this plan disagree (principle 5).
- **Supersedes** the sequences in V3-SEQUENCE and the new plan's §8 for ordering; they keep their detail.

**Conventions.** Times are UTC ("Z") unless marked SGT. "…0058" is 46130058; "…0949" is 47790949. PF is profit factor; R is profit in units of the risk taken. "The new plan" is `docs/plan-ui-and-strategy-review-2026-09-26.md` (decisions D1–D22). V3's research ids read "research D3" and "research stages S0–S5", and its P8 steps "P8 T0–T5", so no id means two things. A "Node restart" is what every merge causes: agent and website restart together, and position management pauses meanwhile.

**Plain words:**
- **Resting order:** a LIMIT or STOP order waiting at the broker. A **pre-order (PRE)** is one placed while the market is shut, to fill at the open. An **HTF limit** rests for a 4h-or-longer signal in an open market until the next bar close; it is labelled `PRE` too.
- **tsmom_long (the momentum book):** the only strategy still allowed to trade (trial on …0058 until 19-12).
- **T4:** the V3 step that gives momentum entries the partial-TP1 plan. Until then every momentum entry is refused for having no TP1.
- **Read-back:** reading production after a deploy to confirm the change behaves as predicted.

---

## §0 The answers first (P1)

### (1) Pre-orders when the market is closed: **partly — weekend crypto needs no pre-order; closed markets: no, for now**

**In one paragraph:** Crypto is not closed at the weekend: the bot keeps scanning it through weekend quiet, so a weekend crypto order is an ordinary open-market order (the HTF limit that T4 brings back for momentum), not a pre-order. I recommend it only as a measured part of the momentum trial, after S-2, T4 and OD-15, scored trade by trade, because there is no weekend crypto resting-order evidence yet (0 fills) and the book's own record is PF 0.55 over 37 closes. For markets that are shut (stocks, indices, FX, commodities), I recommend no pre-orders now: their record is negative (122 PRE closes, PF 0.80 in R, money PF 0.51), resting orders bypass the position caps, the risk gate is not re-run at the open, and gaps fill orders beyond their own stops. A "no" is consistent with your 20-09 order that no limit rests for the next open; re-opening pre-orders (PO-B) needs your explicit order, after PO-M1–M3 have measured them.

- **Crypto** is scanned through weekend quiet, Fri 16:00Z – Sun 17:00Z (`agent/lib/quiet-hours.js:45-52`; exempt at `:81`). The HTF figure (PF 3.09, the lane's 18 setups) is not weekend evidence: 3 of its 28 fills were crypto, none opened at a weekend (§4). The book: 37 closes, PF 0.55, −$1,154.77 (04:58:48Z). Only tsmom_long can place orders today; any other strategy needs S-6.
- **Closed markets:** the record, the three design faults and your earlier orders are in §4. That commodities shut at the weekend is *inference*.
- **Later candidates, by design only:** level-based 1d/1w setups (fib_confluence; ema_pullback if OD-26 keeps it; vp_value after D15), with 10 PRE closes between them. Never breakouts, tsmom into a closed market, or anything below 4h.
- **Direction (principle 8):** no PRE tsmom short has closed (30 closes, all BUY), yet all 4 open book shorts are PRE fills (AVGO.US twice, UNH.US, 0005.HK; 04:59:51Z) (rule PO-9).
- **Measure first:** PO-M1 (levels), PO-M2 (gaps), PO-M3 (the spread at a limit's fill: 0 of 122 PRE fills today).
- **Effect on V3:** T4 turns momentum resting entries back on, closed-market ones included, so H-P0-2's single yes splits in two (OD-1).

### (2) How much of V3 changes

**In one paragraph:** No merged V3 item is re-opened; two merged pieces get latent fixes (UI-4 fixes #1071's readiness read; UI-3 extends WEB-1, #1115). Of V3's 28 open items (15 owner-gated, 4 conditional, 9 follow-ups F1–F9), 7 are unchanged, 18 change in order, inputs or acceptance (3 of them only by the trace table and a new date), 2 are superseded or absorbed and 1 is newly blocked. The acceptance wording of all 8 frozen groups changes, plus the REC and WEB rows. The new plan adds 23 build items and this synthesis 5; V3's open questions and the new plan's 22 merge into 45 decisions (§6). Monday changes too: T4 moves to Tuesday 29-09, behind S-2's first read-back, and GW-1, C5, Q2, W3, WEB-6b and B5 move to after the Monday load window (Mon 16:00Z – Wed 30-09). The window itself holds if your answers arrive by Mon 01:00Z, Monday's merges stop at 13:00Z and M3's harness is running again; otherwise it moves to Tuesday (*inference*; §3, §7).

### (3) The recommended order

1. **First:** your approval of this plan, and OD-0 (does "I agreed with your proposal" accept the new plan's recommended answers?).
2. **This weekend (Wave 1), by Sun 20:00Z:** up to 7 more Node restarts (#1143 caused one at 04:47Z). Restart M3's harness first.
   - **No answer needed:** NEW-1, SAFE-0a, PERF-1, PERF-2, UI-2, UI-7, S-1, S-3, and V3's inert F1, F3, F5's N6 and PO-M3. PERF-0 merged in #1143.
   - **After OD-0** (or OD-17, OD-18, OD-21, OD-19): UI-1, UI-3, UI-4's commit display, UI-6. **After OD-10:** F4.
3. **Monday before 13:00Z (Wave 2):** S-2 with F2; C8 → C9; CV-2; K3 (merged by about 12:30Z); M7; B2b with UI-5.
4. **Mon 13:30–16:00Z, plus a US-closed hour around 20:00Z:** the P1/P4 load window. No merges, no traces.
5. **Tue 29-09: T4**, after S-2's Mon 21:05Z pass is read back. Its closed-market half stays off; its open-market HTF limits wait for OD-15.
6. **Wave 3:** GW-1; S-8 before HKEX's 01-10 holiday; S-4 then S-5; W3 after CV-2's soak; C5, UI-8, B5; Q2; PO-M2.
7. **Only after evidence (Wave 4):** S-6, the bar store, any pre-order rules.

---

## §1 Sources and method (P2, P4)

**Read in full:** the new plan (§0–§14); `V3-SEQUENCE.md` (with the 25-09 21:30 SGT decisions); `reply-9440.md`; `v3-closure` (1–220); `claude-takeover`; `dual-environment-plan` (1–80); `v3-momentum-exit-coordination` (:200-249); the roadmap v2.2 files (`items-v2.2.json`, `refresh-v2.2.json`, `data.py`). **Used through the V3 inventory lane:** `SEQUENCE.md`, `LIFECYCLE-SPEC.md` (except :405-413) and the other `docs/v3-*.md`.

**Inputs, each with its own read times:** the V3 inventory lane (03:39–04:05Z); the weekend pre-order lane (03:42–03:58Z); the new-plan-to-V3 map (04:12–04:21Z); two verifier reports (04:58–05:10Z).

**My reads:**
- **`/health`:** at 04:24:46Z, commit `22bcd29`, uptime 774 s, 0 errors, 26 positions, version 0.1.381. At 05:16:42Z, commit `5389a83` (#1143: docs and `scripts/perf-trace/` only), uptime 1,753 s (boot 04:47:29Z), 0 errors, 26 positions.
- **`/state/momentum-targets` (05:16:42Z):** 0 plans, INCOMPLETE, `executionAuthorized` false.
- **GitHub:** #1143 was open at about 04:25Z (head `e0249f1`); the draft was pushed to it (`025b342`, 04:38:40Z) and you merged it at 04:46:56Z. No PR is open at about 05:17Z.
- **Code:** read at `22bcd29` and re-read at `5389a83` (identical outside docs and scripts) in the read-only worktree. Every `file:line` below was read.

**Disagreements, and how they were settled:**
- **Is `closed_market_limits` retired? Both lanes are right.** The scan's producer is retired (`entry-producers.js:54-59`). The module still carries the momentum account's and the manual routes' orders: on by default (`closed-market-limits.js:28-30`), fenced by caller (`:343-354`).
- **B4b and B4c** merged as #1144 (04:01:36Z) and #1145 (04:11:07Z).
- **"Numbers for partial TP1" (9440 Q8)** is superseded by your 24-09 formulas (`v3-closure:72-76`).
- **Does the daily momentum pass run in weekend quiet? Yes, verified.** `dailyDue` has no weekday test (`momentum-account.js:271-275`, `:365`); `runMomentumBook` checks only `enabled` (`momentum-book.js:389-391`, `:612`); the book sits in the scan branch (`loop.js:4256`), which runs in quiet hours while crypto is watched (`:4112-4135`). …0058's pass ran Fri 25-09 21:05:40Z, inside quiet hours, and logged `KO.US: close failed — MARKET_CLOSED` (05:01:52Z). `V3-SEQUENCE:729` ("weekdays") is wrong. That Saturday passes run too is *inference* (next: Sat 26-09 21:05Z).

**Method.** No new trade analysis: the lane's slices were re-computed from the 05:02Z `/state/trades` read and the lane join. Forecasts are labelled *inference*.

---

## §2 V3 today

Production `5389a83` at 05:16:42Z. None of the eight frozen groups is accepted.

| Group | Merged (read-backs) | Open | Blocked by |
|---|---|---|---|
| P0/P3 | T1, T1b, T2, T3 (#1091, #1110, #1124, #1132). T3 **Passed** (03:42:45Z; the same at 05:16:42Z) | T4; F1, F2 | H-P0-1, -2, -5 |
| P1/P4 | M1 **Passed** (first loop 86,423 ms on `22bcd29`; harness row 04:13:36Z); M2, M2b, M5. **M3's harness is not running** (below) | M7; conditional M4, M6; the window | H-P1-1..4, M3-a..d |
| P2 | K1, K1b, K1c, K2 (**Passed**: 136 of 136 calendars; 7 of 7 maps; 05:04Z) | K3, WEB-6b | H-P2-2 (= D7) |
| P5a | STK-08v2 (**Passed** 03:42:44Z; Telegram off) | CV-2, W3 | H-P5a-1..6 |
| P5b/P5d | B1, B2, B3, B4, B4b, B4c. B2: 2 money disagreements, 50 broker-only (04:58:50Z) | B2b, B5. `/state/unknown-pnl`: 3 ambiguous, 2 "unresolved" (04:58:50Z) | H-P5b-1, -4 |
| P5c | WP-A, PR-1, C3, C4, DEP-SQLITE, CV-1 (**Passed**: `orderAuthority` false; tick cursor 0). Mirrors: 282 matched, 33 `delivery_failed` (04:59:22Z) | C5, C7, C8, C9, C11; runbook R6 | PR-5, -7, -8, -9, -11 |
| P6/P7 | Q0 (not verifiable until a sidecar restart), Q1, Q1b, Q3, Q4b | Q2; conditional Q5, GW-2 | H-P6-1..10 |
| P8 | A1, GW-CAP (**Passed**: 20 and 5 GiB, 04:59:21Z), R1 (**Passed**), R2 | GW-1; a soak host | H-P8-3..6 |
| REC, WEB | L1–L2b, X1, V1, I1–I3, WEB-1..10, WEB-8b | 6 new defective close records (05:04:03Z): 4 × MSFT.US (`pre_contract`), SGDJPY on …0058 (`live_gap`), Cocoa on …0949 (`outside_bot`). F3. The logged-in website rows | 9440 Q3, H-P5b-5 |

**M3's harness is not running.** Its last record is 04:48:32Z (the #1143 restart); PID 10750 is gone at 05:16:03Z. This container restarted at about 04:56Z, and the harness doc warns that such a restart ends the run (`v3-p1p4-harness:302-307`). The #1143 boot's first loop is missing from the record (the reasoning verifier read 86,600 ms at 04:58:19Z; not re-read by me).

**In flight: nothing.** No PR is open (about 05:17Z), and no branch exists for any of the 15 owner-gated items (`git ls-remote`, 05:43:38Z).

**P8 T2 first retire under GW-CAP's caps (*inference*):**
- **Live:** from 05-10 to about 25-10 (V3's rate, 2 GiB in 11.8 days) to 01-11-2026 (production's 24 h rate, 148.6 MB a day, 04:59:20Z).
- **Demo:** from 03-10 to no earlier than about 23-01-2027 (the 23–25 Sep weekday rate, 0.163 GiB a day, from the 05:05:40Z segment list); about 15-02-2027 at the 24 h rate (146.0 MB a day). Later if weekends are slower or the recorder stops again as on 16–23 Sep: the 14-day average (0.044 GiB a day) gives December 2027.

---

## §3 What the new plan changes in V3

### Open V3 items

| V3 item | Change | Why, and effect |
|---|---|---|
| **T4** | Order, scope, date | After S-2, F1 and S-3; Tue 29-09, after S-2's first read-back. HTF limits wait for OD-15; closed-market limits stay off (§4). The book runs inside the scan branch (`loop.js:4256` to `:4721`). Adds "book exits run with Scan off and in quiet hours". First natural plan **not datable** (…0058: 6 against a cap of 5, 04:59:51Z) |
| **C7** | **Newly blocked**, re-scoped | Its profiles are fib, rsi2 and donchian, none of which trades under D10's recommendation. Its hours gate moves to S-8. Admission needs D10(A) and S-6 |
| **C11** | **Superseded** by S-6 | D10 re-opens your 25-09 restore order: 0–1 strategies instead of 3 |
| **F6** | **Absorbed** by S-2 | S-2 adds the book's heartbeat |
| **K3** | Order | Ahead of M7, T4, GW-1, Q2, W3 and C5; still Monday, merged by about 12:30Z. S-8 needs it before 30-09 ~15:00Z (HKEX 01-10) |
| **M7** | Inputs | S-3's token-wait counter and D22 feed the probe design |
| **M6** | Evidence | S-4 and D12 cut the `decision_log` volume that the decision audit reads. Re-measure after S-4 |
| **B2b** | Order | UI-5's re-stamp fix edits the same path (`pnl-backfill.js:1013-1017`). B2b goes with or before it |
| **B5** | Scope, date | D5's 28 plan corrections and the 7 mislabelled PRE rows can use its named apply. Wave 3 |
| **F2** | Hours source | Use S-8's calendar; ship with S-2. Changes when live exits are sent: ask-first |
| **F9** | Scope | The trace harness needs a host too |
| **GW-1, C5, Q2** | Order | The roadmap had them on Mon 28-09 (09:20Z, 07:05Z, 06:10Z; `items-v2.2.json`). Now after the window. GW-1 may carry OD-21's commit display |
| **F1, F4, F5** | Order | Unqueued follow-ups, now in Wave 1. F1 gates T4; F4 needs OD-10 |
| **F8** | Order | Checked from fills before T4 (OD-3), not carried into it |
| **W3, WEB-6b, F3** | Acceptance and date | Website files carry the trace table (D20), about +15–20 min per PR (*inference*). W3 and WEB-6b move to Wave 3; F3 into Wave 1 |
| **C8, C9, CV-2, M4, Q5, GW-2, F7** | **Unchanged** | — |

### The nine follow-ups

| Id | What | Source | State |
|---|---|---|---|
| F1 | Horizon deferral in profit-keeper, loss-guardian, trade-guard and weekend-bank | `v3-momentum-exit-coordination:240-245` | Gates T4; Wave 1 |
| F2 | Hours check and `exit_pending` on the daily-path exit (KO.US `MARKET_CLOSED`) | `:205-229` | With S-2; ask-first |
| F3 | WEB-9 wording "left today on realised P&L (floating not counted)"; 1130.17 fixture | `V3-SEQUENCE:793` | Wave 1 |
| F4 | An alarm when the tick feeder stalls | #1099 nit 2; C4's question (`data.py:174`) | OD-10 |
| F5 | B1's declined N6 (lifecycle rule on the non-strict path; no production caller) and N7 (lesson tuner reads rejected rows' postmortems) | #1116 commit message | N6 in Wave 1; N7 in OD-37 |
| F6 | A heartbeat for the momentum book | `LIFECYCLE-SPEC:405`. None among the 39 controllers (04:59Z) | Absorbed by S-2 |
| F7 | Multi-deal close attempts left `order_deals_inexact` | `exit-coordination:236-239` | No rows (0 plans) |
| F8 | How cTrader anchors a multi-deal average fill's bracket | #1110 N1 (`momentum-target-policy.js:63-65`) | Before T4 (OD-3) |
| F9 | A durable host for the M3 harness | `v3-p1p4-harness:302-307` | OD-38 |

### Acceptance wording that changes

| Group | Change |
|---|---|
| P0/P3 | Book exits run with Scan disabled, with Scan off everywhere, and in quiet hours. The book beats a heartbeat |
| P1/P4 | Visible tabs exclude synthetic presence. The window measures the UI after Wave 1. The M3 record covers every merge |
| P2 | UNKNOWN never reads open on the entry path. A current 0/0 holiday reads closed |
| P5a | The watchdog contract stays ≤ 256 KiB after UI-3 and S-4 (`cpp-verify/src/watchdog_state.cpp:117`) |
| P5c | Admission needs D10(A) and S-6. Observation needs S-4 to keep the three profile strategies scanned |
| P6/P7 | D10 is judged on Q4b's frozen metric. The fib shadow verdict is a new milestone |
| P8 | The comparison's "time" arm narrows to momentum only |
| P5b/P5d | Named correction records (D5); the re-stamp fix |
| REC, WEB | Arming-log completeness (S-1); trace tables (D20); row 2 re-scoped (UI-1, UI-3) |

### New items and renames

- **New plan, no V3 home (12):** SAFE-0a, SAFE-0b, UI-2, UI-7, UI-8, PERF-0 (merged in #1143), PERF-1, PERF-2, S-3, S-5, S-7, HIST-1.
- **New plan, attached to V3 (11):** UI-1, UI-3, UI-4, UI-5, UI-6, S-1, S-2, S-4, S-6, S-8, HIST-2.
- **This synthesis (5):** **NEW-1**, a synthetic-presence tag (`client-presence.js:141`; the M3 record already counts 9 visible tabs at about 01:30Z and 8 at about 02:49Z from headless and trace loads); **PO-M1**, **PO-M2**, **PO-M3**; **PO-B** (conditional).
- **Renames:** S1–S3 → SB1–SB3; H-1, H-2 → HIST-1, HIST-2; A1 → UI-7; D1–D22 and V3's H-ids → OD-n (old ids in brackets); V3's research ids take a "research" prefix.

---

## §4 The weekend pre-order answer, in full

### What exists (verified at `5389a83`)

- **Two resting paths, one module.** Closed market: `loop.js:390-441` → `placeClosedMarketLimit`, returning before the evidence gate (`:450`). HTF: after the evidence gate (`:465-507`), with `reason: 'htf'` (`:491-500`). Both label the order `PRE` (`closed-market-limits.js:476`). SL and TP ride as relative distances (`:56-57`), so a gap fill moves the stop with it.
- **Who can still use them.** The scan's producer is retired (`entry-producers.js:54-59`). The daily momentum pass rests entries through the module (`marketOnly: false`, `momentum-account.js:473`) after 21:05Z (`:67`), after the US close; its universe holds 22 stocks and 10 indices shut at 21:05Z (`momentum-universe.json`; comment `closed-market-limits.js:350-351`); its 10 commodities were not checked. The row-cursor book sends market orders only (`momentum-book.js:319`).
- **Why nothing places one today.** tsmom's entry has `tp1: null` (`momentum-book.js:313`); the bracket guard refuses any entry without a TP (`exec-engine.js:586-601`); …0058 is at its cap.
- **Controls on a resting order.**
  - **Risk gate:** at placement only (`closed-market-limits.js:429-432`); a resting fill makes no second trip through the order boundary (`exec-engine.js:571-572`). No re-run at the open was found (*inference* from the code).
  - **Expiry:** closed market, 3 days by the wall clock (`pending-signals.js:34`); HTF, the next bar close (`timeframes.js:159-170`, `loop.js:490`): about 2 h 55 min for a 1d signal at 21:05Z (`htfLimitDispatch` 4h and 120 min, 05:01Z).
  - **Order limits:** one per symbol per account (`:387-395`, `:461-467`); 20 working across all accounts (`:397-403`).
  - **Position caps:** the risk gate counts positions only (`risk.js:1416`, `:1467-1472`). Since 19-09 the daily pass counts its own resting rows toward its slots (`momentum-account.js:297-300`, `:401-409`, `:446`), but not the account's other positions, so resting fills can still pass the cap. …0949 holds 12 positions against 5: all 12 are PRE fills, and 5 filled together at the 18-09 13:31Z US open, before that change (04:59:51Z).
- **Your own orders.** 09-08: "set pre-trade 6 hours before" the open; that window is still code (`quiet-hours.js:92-100`) but now only widens the weekend scan. 20-09: "no limit is rested for the next open" (`entry-producers.js:58`). And `v3-closure:191`: "Do not re-open retired ordinary producers."

### The evidence (lane 03:42–03:58Z; re-computed from the 05:02Z `/state/trades` read and the lane join)

| Slice | Size | Result |
|---|---|---|
| All PRE closes | 122 (119 with R) | PF 0.80 in R (−9.53R); money PF 0.51 (−$2,709.14) |
| Closed-market | 77 fills; the lane's 40 setups | PF 0.62 in R per fill (−12.69R); **per setup PF 0.42, −11.40R** |
| Sunday 06-09 | 9 fills from 5 setups, on up to 4 accounts | All lost, −5.63R |
| Closed-market momentum | 10 setups (lane) | PF 0.49 (too few) |
| HTF limits (open markets) | 28 fills; the lane's 18 setups | PF 4.13 per fill (+6.83R); **per setup PF 3.09** (too few). 3 tsmom, 3 crypto, 0 weekend opens; HD.US is 5 of 28 |
| Crypto opened in weekend quiet | 89 closes (74 with R) | PF 0.11, −27.93R. 64 of the 89 were on 5m or 15m bars (17-07 to 23-08). *Inference:* this counts against intraday weekend crypto, not against the book |
| Strategies that could qualify later | fib_confluence 3; vp_value 7; ema_pullback 0 | fib: all 3 lost (−2.0R). vp_value: PF 0.86 |
| BTCUSD entry spread | 13 weekend, 24 weekday | Median 2.31 bp in both (lane; not re-read) |

**Caveats:** the lane never defines a "setup" (by symbol and placement minute: 56 closed-market, 22 HTF). `label_timeframe` is empty on all 122 PRE rows. tsmom's 30 PRE closes were all BUYs.

**Why closed-market fills lose.** 23 of 77 fills filled 0.25R or more past the level. 12 filled beyond the setup's own stop, from only 6 setups (COIN.US ×4, MCD.US ×3, AVGO.US ×2, 0016.HK, GS.US, 2020.HK; worst 2.46R). The relative stop moves with the fill, and T4's policy keeps that (`momentum-target-policy.js:58-60`), so a gap does not cut the loss; it resets it. Fills cluster at the US open (52 at 13Z) and the HK open (8 at 01Z).

### Recommended rules, if pre-orders are ever built (PO-1 … PO-9)

1. A level from closed 4h-or-longer bars, preferably 1d or 1w. The order type must match the idea: a breakout needs a stop-entry type, which does not exist.
2. A short expiry: the signal bar's close, or the open plus one bar. Not 3 days.
3. A gap guard in the pre-open window: cancel if the price is beyond the stop, or more than X R through the level. X is yours to set.
4. The risk gate is re-run before the open.
5. Resting orders count toward the caps (5, the book's 8, per symbol) and reserve margin. The values stay the same; only how they count changes. **Ask-first (OD-15).**
6. TP1 is mandatory (T4).
7. The PRE label and the preopen basis stay separate. The 7 PRE rows labelled `external` are corrected by a named record (OD-12).
8. Holidays go on the entry path first (S-8).
9. Every resting order carries `direction_reason`, and a short meets the short rule: conviction ≥ 9/10, never against an up-trend reading (`/state/momentum-account` note, 05:01:52Z). A fill whose record lacks either is flagged, never adopted silently. Shorts by resting order stay off until PO-M1 scores them.

### Measure first

| Id | What | Needs | Bar |
|---|---|---|---|
| PO-M1 | Shadow-score fib 1d/1w and ema_pullback 1d levels; timeframe from `pending_orders` | S-4 (a shadow with levels); OD-9 | 30 closes each |
| PO-M2 | Weekend and overnight gaps in ATR and R, per asset class | S-3's margin; bounded broker reads (about 11–42 requests per symbol, the new plan §14) | Sets rule 3's X |
| PO-M3 | The spread at a limit's fill | A small record-only Node change | Present on every new PRE fill |

### ASK-FIRST

- Turning pre-orders on for any strategy (PO-B reverses your 20-09 order).
- Anything on the 3 live accounts (principle 1 makes them equal, not exempt).
- A stop-entry order type; rule 5's counting change; changes to expiry or `pre_open_hours`.
- Closing any of …0949's 12 positions.
- Your manual orders: two Cocoa BUY STOPs on …0949 and a BTCUSD LIMIT on …3489, none with a stop (04:59:53Z).

---

## §5 The ONE integrated build sequence

### Standing rules

- **Gate:** the full gate as in CLAUDE.md, with a fresh TMPDIR; every mutation confirmed applied with `grep -c` before and after.
- **Read-back after every deploy:** `/health` (commit, errors); the item's own route; `/state/heartbeats`; all positions protected. Not `/state/storage`: its fresh database walk took about 28 s (04:58:51–04:59:18Z), and V3 risk 6 names it a possible stall (`V3-SEQUENCE:768`).
- **Trace rule (new plan §13):** every PR touching `src/` or a route the website reads carries a before-and-after table (median of 3 fresh runs, desktop and phone; Home plus each touched page; the certificate lines). No traces inside a graded P1/P4 window. NEW-1 lands first; until then 1.1's "before" is the §13 baseline (`77da158`, 02:45–02:53Z). A regression beyond D21's floor blocks the auto-merge once OD-13 is answered; before that it is reported and asked.
- **Batching:** pair small PRs, merged back to back within the hour. This checked plan replaces the #1143 draft and rides 1.1. No gateway code outside a gateway window; no new-plan item touches `cpp-exec/**` or `agent/lib/exec-engine.*`.
- **Restarts:** the root `railway.json` has no watchPatterns, so every merge restarts Node. S-7's native parity restarts cpp-scan-timeframe and Node, no gateway.
- **M3's harness** runs across every merge: restart it before Wave 1. Until then startup windows are not recorded (`V3-SEQUENCE:426`).
- **Pre-building:** if OD-41 is yes, answer-gated items are built on draft branches with the recommended defaults, merging only on your answer.

### Wave 1 — this weekend (Sat 26-09 → Sun 27-09 20:00Z)

This wave has up to seven merges, so up to seven more Node restarts. Crypto keeps trading, so each merge briefly pauses crypto position management.

| # | Items (origin) | Scope and proof | Gate |
|---|---|---|---|
| 1.1 | This checked plan + **NEW-1** + **SAFE-0a** | A tagged ping leaves `visibleTabs` unchanged; mutation: drop the filter and the test goes red. The confirm names the account (`Trade.jsx:620-633`); mutation 1→0. Trace: Trade, Home | Auto on green |
| 1.2 | **UI-1 + PERF-1** (extends WEB-1) | New plan §8 item 1 and §13: a visible, remembered collapse control with section ids; reserved heights; the font preload fixed. Proof: the CLS median falls on Performance and Reasons | PERF-1 none; UI-1 after **OD-0** or OD-17 |
| 1.3 | **UI-2 + UI-3** (extends WEB-1, C4) | §8 items 2–3. UI-3 keeps cpp-verify's relayed counts, and the watchdog contract stays under 256 KiB (`watchdog-contract.js:8` and `scanner-work.js:5` import `blocker-report`). Read-back: …0058 on your phone | UI-2 none; UI-3 after **OD-0** or OD-18 |
| 1.4 | **UI-4 + UI-7** (extends WP-A, #1071) | SB1 and SB2: the readiness bug, "no record", and the build commit via a Dockerfile ARG. The AI page reads "off". Read-back: the web and agent commits match | UI-7 none; SB2 after **OD-0** or OD-21 |
| 1.5 | **UI-6 + PERF-2 + F3** | The Reasons order and tables; the digit tree as text; F3 | UI-6 after **OD-0** or OD-19 |
| 1.6 | **S-1 + S-3** (extends REC) | Appended arming rows; the picker ranks by armed strategies; per-account cells take effect or are refused; fetch margin `minBars`+1; Phase 0 counters. Read-back: all 91 cells "recorded"; mirrors matched > 0, mismatch 0, `delivery_failed` not above 33; the book's crypto pass still runs | …0058's 39 extra pins excluded (ask-first) |
| 1.7 | **F1 + F4 + F5's N6 + PO-M3** | F1: the four closers defer (inert while there are 0 plans). F4: the feeder-stall alarm. N6: the non-strict lifecycle rule. PO-M3: record only | Auto on green; F4 after **OD-10** |

**Order:** 1.1 first; 1.2 before 1.3; 1.6 and 1.7 before T4; 1.6 before M7. A row with an unanswered part ships the rest and merges that part when answered.

### Wave 1 actuals (merged 26-09-2026)

**Corrected 26-09 21:30 SGT.** The first version of this table (written with W1-FU) paired four rows with the wrong PR: rows are the W-labels, and #1149 is W1.6, not row 1.3. The mapping below is read from the merge commits on `main`.

| Row | PR | Items | Merged (UTC / SGT) | Proof recorded |
|---|---|---|---|---|
| 1.1 | #1147 | NEW-1 + SAFE-0a (+ this checked plan and the roadmap) | 07:16Z / 15:16 | Landed as planned |
| 1.2 | #1148 | UI-1 + PERF-1 + PERF-2 | 07:34Z / 15:34 | Performance CLS passed (desktop 0.70→0.23, phone 0.78→0.12). **Reasons CLS Failed** (0.76→0.74 desktop, 0.59→0.55 phone) — closed by W1-FU |
| 1.6 | #1149 | S-1 + S-3 | 08:00Z / 16:00 | Read back: arming rows appended; picker ranks by armed strategies |
| 1.4 | #1150 | UI-4 + UI-7 | 08:12Z / 16:12 | Read back: web and agent commits match; the AI page reads "off" |
| 1.7 | #1151 | F1 + F4 + F5-N6 + PO-M3 | 08:33Z / 16:33 | Read back: the `tick_feeder` heartbeat; closers defer (inert, 0 plans) |
| — | #1152 | Follow-up to #1149 | 08:54Z / 16:54 | BTCUSD history: monthly series starts July 2010; the "weekly starts 2018" reading was a false positive |
| 1.3 | #1153 | UI-2 + UI-3 | 09:21Z / 17:21 | 6 h and 24 h Blockers group by day; **72 h fell back to the flat list** (24,692 records > 512 KB) — closed by W1-FU |
| 1.5 | #1154 | UI-6 + F3 (+ ledger write-back) | 09:34Z / 17:34 | Reasons reordered on the shared table. **Its DOM grew 5,357 → 8,904 elements** — closed by W1-FU |
| FU | #1157 | W1-FU | 12:21Z / 20:21 | See below |

Wave 1 was planned to end Sun 27-09 20:00Z; its last row merged Sat 26-09 09:34Z, **about 34 h early**. Nine Node restarts; every read-back showed 0 errors and all positions protected.

**W1-FU (#1157, 12:21Z)** — the three read-back gaps above:
- The card standard on Reasons: ids, `loading`, `defaultCollapsed` after the first two, and an opt-in `lazy` mount (maximise also mounts). Trade consistency folded into Ledger integrity (owner, 26-09 18:05 SGT).
- The Blockers 72 h window: **Passed on production at 12:40Z** — `daysIncomplete: false`, 4 day groups, 426 KB (6 h: 1 day, 24 h: 2 days).
- The trace harness: a discarded warm-up per profile; a null run reports "not measured".
- Reasons CLS and element count after W1-FU: traced 12:46–13:02Z on `e751b15` (median of 3 runs after a discarded warm-up).

  | Page · profile | Before W1.2 | After W1.5 | After W1-FU | Target | Result |
  |---|---|---|---|---|---|
  | Reasons · desktop CLS | 0.76 | 0.74 | **0.53** | ≤ 0.25 | **Failed** (improved) |
  | Reasons · phone CLS | 0.59 | 0.55 | **0.46** | ≤ 0.25 | **Failed** (improved) |
  | Reasons elements | 5,357 | 8,904 | **2,936** | ≤ 5,400 | **Passed** |
  | Performance · desktop CLS | 0.70 | 0.23 | **0.19** | not worse | Passed |
  | Performance · phone CLS | 0.78 | 0.12 | **0.08** | not worse | Passed |

  LCP medians rose on all four page/profile pairs (Performance desktop 1,123 → 3,860 ms, phone 4,864 → 6,351; Reasons desktop 2,374 → 7,507, phone 7,787 → 9,624). **The cause is not attributed.** Performance does not opt into `lazy`. The agent loop measured 36 s at 12:40Z, and the runs now discard a warm-up, so the old and new figures are not strictly comparable. Next: a second Reasons follow-up for the remaining shift, and a same-hour A/B trace to attribute the LCP rise.

### Wave 2 — Monday 28-09 01:00–13:00Z, then T4 on Tuesday

| # | Items (origin) | Scope and proof | Gate |
|---|---|---|---|
| 2.1 | **S-2 + F2 + F6** | The book and the daily pass leave the scan branch (`loop.js:4256` → after `:4721`). The daily exit checks hours and marks `exit_pending`. A `momentum_book` heartbeat. Tests: exits run with Scan disabled, off everywhere, and in quiet with no crypto. Read-back: Mon 28-09 21:05Z, then the first quiet-hours pass after S-2 (Fri 02-10 21:05Z) | **OD-2** |
| 2.2 | **C8 → C9** | V3-SEQUENCE §1 items 29–30 | **OD-6** |
| 2.3 | **CV-2** | Item 26. Restarts cpp-verify and Node; the 24 h muted soak starts | **OD-10**; auto on green (PR-6). In Wave 1 if OD-10 is answered this weekend |
| 2.4 | **K3 + SAFE-0b** | Item 34. Merged by about 12:30Z, so the read-back after a 20–30 min collector sweep ends before the window. SAFE-0b refuses a stale or other-account Re-Risk apply | **OD-7, OD-14** |
| 2.5 | **M7** | Item 33, fed by S-3's token-wait counter. Prediction: skip share ≤ 10 % in a US-closed hour | **OD-22** |
| 2.6 | **B2b + UI-5** | B2b first; then the re-stamp fix, gross-P&L consistency, the refusal-time window and plan flags | **OD-11, OD-12** |
| 2.7 | **T4**, Tue 29-09 | Item 32, plus a named refusal (with its test and mutation) for a closed-market momentum entry. Merges after S-2's Monday read-back, outside the P1/P4 window. Read-back: `/state/momentum-targets` wiring reads "wired" | **OD-1, OD-3**; **OD-15** for HTF limits; after 1.6, 1.7, 2.1 |

**Stop merging at 13:00Z.** **The P1/P4 window: Mon 13:30–16:00Z, plus a US-closed hour around 20:00Z.** No merges except one intended restart (OD-4); no traces; you keep Desk and Performance visible.

### Wave 2 pre-build status (26-09 21:30 SGT)

The owner answered OD-41 yes (pre-build) and accepted the recommended answers to OD-2, OD-3, OD-6, OD-7, OD-10, OD-11, OD-12, OD-14 and OD-22. OD-4 was confirmed as proposed. OD-1 and OD-15 are still open, so T4 is draft only. Each row went maker → independent check → fix round → re-check. **Nothing in Wave 2 merges before Mon 28-09 01:00Z.** Merges go one at a time, each read back, in the order 2.1 → 2.4 → 2.3 → the rest.

| Row | Branch head | Independent check | PR / CI | Ready for Monday? |
|---|---|---|---|---|
| 2.1 S-2 + F2 + F6 | `claude/w2-s2-book` `5d1f4a4` | MERGE (two re-checks). Fixed on the way: a MARKET_CLOSED refusal could park an owed exit for ~151 h; it now retries after 30 min, capped at 2 h | Draft #1158, CI green | Yes |
| 2.2 C8 → C9 | `claude/w2-c8-c9` `f9e566e` | **FIX FIRST.** C8 is correct. In C9 the restart quarantine lifts without a reconcile once `expireStale` runs. This is dormant (no account admits tick). Fix round running | — | Likely. C8 needs the owner's word on its live change (below) |
| 2.3 CV-2 | `claude/w2-cv2` `88d3dd8` | MERGE | Draft #1155, CI green | Yes |
| 2.4 K3 + SAFE-0b | `claude/w2-k3-safe0b` `44e1d41` | MERGE | Draft #1156, CI green | Yes |
| 2.5 M7 | `claude/w2-m7` `a73efbb` | MERGE (two re-checks). Fixed: a stale broker quote was evaluated under backoff; the cap starved positions on a down feed; the cap could be 0; plus a pre-existing late-stream socket leak | Draft #1159, CI pending | Yes |
| 2.6 B2b + UI-5 | `claude/w2-b2b-ui5` `3367b0f` | Named corrections: MERGE after a fix round (absolute values with `expectedOld`; #47 removed; the apply takes only the ids a dry run showed). **The rest of the row** (re-stamp fix, gross-P&L consistency, refusal-time window, plan flags) **is being built now** | — | **At risk.** The named apply is a production write: the owner sees the dry-run list first |
| 2.7 T4 | `claude/w2-t4` `699aace` | **MERGE-WHEN-ANSWERED**: with the switch off (`momentum-entries.json` `market: false`) nothing changes live; two test gaps in a nit round | — | Draft only until OD-1 and OD-15; Tue 29-09 after S-2's read-back |

**Owner questions raised by the checks** (none merges without its answer):
- **C8 changes live trading on merge.** Since #939 the book cap counted only working limit orders, because it read a column that does not exist. From Monday a third account is vetoed on any symbol and side two other accounts already hold. This applies on the bar, book, limit and manual routes. The two slots go to the accounts with the most headroom. The bar fan-out still sizes at R/N over the accounts that passed the pre-filter, so with 7 accounts a signal's book exposure drops from R to 2R/7. Questions: accept? Exempt `cross_sectional_book`? Rotate the slots, as the tick grants do?
- **M7:** one pass can open up to 8 authed broker sockets at once, and nothing paces them. Should they be paced?
- **S-2:** should the ranking also leave the scan branch? Should the exits and the trail run for held rows on accounts where tsmom isn't armed (…0949's 10)? Does OD-2 cover F2 on the 3 live accounts?
- **CV-2:** does the rest of item 26 go in this PR or the next? Should delivery stay muted after the soak until an explicit unmute?
- **K3:** what does an omitted bound mean? Should the account comparison refuse a proposal that has no account?
- **T4:** OD-1 (when, and for which accounts; there is no per-account scope yet). OD-15. The closed-market refusal live now while the switch stays off? The swap-rate assumptions (a missing rate is refused; a missing `swapCalculationType` is read as PIPS).

### Wave 3 — Mon 16:00Z → Wed 30-09

| # | Items | Scope and proof | Gate |
|---|---|---|---|
| 3.1 | **GW-1** | Item 38, plus the sidecar commit (OD-21, TM-37). Restarts both gateways and Node. Read-back: every account connected; positions protected; the recorder RECORDING, with GAP_RESTART as its first record; Q0's first real test | **OD-6**; your window |
| 3.2 | **S-8 + WEB-6b** | Holidays on the entry path (`isSymbolOpenCached`, `loop.js:390`). UNKNOWN never reads open. **Deploy by 30-09 ~15:00Z**: HKEX's 01-10 holiday starts 30-09 16:00Z | **OD-7, OD-8** |
| 3.3 | **S-4 → S-5** | The declared shadow set keeps fib, rsi2 and donchian scanned as the reference for the 690 timeframe profiles (`loop.js:4200` → `recordReference`). S-4 adds a repeat count to `decision_log` (today only `risk_events` has one, `db.js:1897`), and each of its 10 readers sums it. The contract stays ≤ 256 KiB. Read-back: shadow refusals > 0 with levels; mirrors unchanged | **OD-9, OD-16** |
| 3.4 | **W3** | After CV-2's soak. Calling the route is ask-first | **OD-10** |
| 3.5 | **C5, UI-8, B5** | Items 28 and 36; new plan §8 item 10 | **OD-23, OD-20, OD-12** |
| 3.6 | **Q2** | Item 37 | **OD-24** |
| 3.7 | **PO-M2** | A gap report from read-only broker history, within 4 requests per second | Auto on green |

### Wave 4 — only after evidence (no dates)

| Item | Starts when | Gate |
|---|---|---|
| **S-6** restore, per strategy (supersedes C11) | Its shadow reaches 30 closes and passes the bar; D17 applied; an order path chosen (C7 re-scoped, or a fence allow-list, which conflicts with `v3-closure:191`) | OD-5(A), OD-29 |
| **C7** re-scoped | Only if S-6 routes through admission | OD-5 |
| **PO-M1 → PO-B** | PO-M1–M3 support it | OD-1(b), OD-15 |
| **HIST-1**, **HIST-2** | The D18 figure is crossed, and the depth is set | OD-28 |
| **S-7**, then walk-forward | After Q4b, with Q2's discipline | OD-27 |
| D14 sweep; the bare sections; table migrations | — | OD-26 |
| M4, M6, Q5, GW-2 | Their V3 triggers | V3 |

---

## §6 ONE decision register

**Answered 26-09 ~18:05 SGT (owner, recorded 21:30 SGT):** OD-41 yes (pre-build); the recommended answers to OD-2, OD-3, OD-6, OD-7, OD-10, OD-11, OD-12, OD-14 and OD-22; OD-4 as proposed (window Mon 13:30–16:00Z plus ~20:00Z, the 10 % skip share joins, both tabs visible, goal table off); Trade consistency folds into Ledger integrity. **Still open and blocking dated work:** OD-1 and OD-15 (T4), OD-8 (S-8), OD-9 and OD-16 (S-4/S-5), OD-20 (UI-8), OD-23 (C5), OD-24 (Q2). The recommendations in the table below are unchanged.

Most-blocking first, OD-0 at the top. "Default" means built on a draft branch and merged only on your word. The pre-order decisions are OD-1, OD-15, OD-39 and §4's ASK-FIRST list. OD-9's fib scoring follows OD-5(B).

| # | Question [old ids] | My recommendation | Blocks |
|---|---|---|---|
| OD-0 | Does your "I agreed with your proposal" (26-09) accept the new plan's recommended answers to D1–D22? [new] | **Your reading decides it.** If yes, UI-1, UI-3, UI-4 and UI-6 merge in Wave 1 on D19/D8, D9, D3 and D4 as recommended. OD-13 and the ask-first items still need their own yes | Wave 1 rows 1.2–1.5 |
| OD-1 | Resume momentum entries after T4? [H-P0-2 split; the pre-order question; H-P2-1(c)] | **(a) Market orders: yes. Open-market HTF limits: yes, but only after OD-15. Start on the Trade-armed accounts (…0058's trial), as your per-account arming. (b) Closed-market limits: no**, until PO-M1–M3. Widening to all 7 accounts, including the 3 live, is a separate yes | T4; P0/P3 |
| OD-2 | Move the book out of the scan branch, and make the daily exit hours-aware? [S-2; F2] | **Yes, both.** This changes when exits run for the 22 book rows (18 long, 4 short) | S-2 → T4 |
| OD-3 | T4 parameters [H-P0-1, H-P0-5, F8] | **Swap = broker rate × median nights; deferred binding: yes.** Check F8 from fills first | T4 |
| OD-4 | P1/P4 limits and window [H-P1-1..3, M3-a..d] | **Confirm the proposed limits; window Mon 13:30–16:00Z plus 20:00Z; the 10 % skip share joins; both tabs visible on your device; restart the harness now (here until OD-38's host exists); goal-table stays off (12.4 s stall)** | P1/P4; **answer by Mon 13:00Z** |
| OD-5 | Restore fib, rsi2, donchian: (A) at half risk, (B) after scoring the shadow, (C) withdraw? [D10; PR-11; the 25-09 order; PR-7 only if (A)] | **fib (B); rsi2 and donchian (C).** All three stay scanned as the unarmed reference until the profiles are re-registered | S-6, C7, C11, S-4 |
| OD-6 | Gateway chain [PR-8, -9, -10, H-P8-3; H-P5c tick-liveness calendars (GW-2 scope)] | **The V3 defaults.** A weekday gateway window outside the P1/P4 window; demo first, by pausing cpp-acct's auto-deploy | C8, C9, GW-1; P8 T1 |
| OD-7 | Does a current 0/0 holiday row mean closed all local day? [H-P2-2 = D7] | **Yes.** The worst case then reads closed when open, never the reverse | K3, S-8, WEB-6b |
| OD-8 | Which hours source gates entries? [H-P2-3, O3, S-8] | **The account calendar, for every entry.** This flips V3's "no for closure" default | S-8; C7 |
| OD-9 | Score refused strategies; fold standing stops? [D11, D12] | **Score the PO-M1 levels. Fold the stops, keeping sums and letting every line expand** | S-4, PO-M1 |
| OD-10 | Watchdog delivery [H-P5a-1..6, 9440 Q2, LIFECYCLE 5; F4] | **The same chat; a VPS observer; urgent alerts only; accept paired restart pages; dispose of the backlog after a `/data` backup.** Delivery is held until after the soak, then the drills run with a cap of 4 messages. **F4: yes.** If you answer this weekend, CV-2 can merge in Wave 1 (*inference*) | CV-2, W3, F4 |
| OD-11 | Write-off rule [H-P5b-4; your 25-09 rule; B2-Q3; B2-attr] | **Yes.** A history with no deals reads `never_filled`. An account is written onto a row only from broker evidence | B2b → UI-5 |
| OD-12 | Named corrections [H-P5b-1, D5; PO-7] | **Yes; dry run first, then a named apply, with nothing deleted.** Covers the money fixes, never-filled rejections, 28 plans and 7 PRE labels | B5; UI-5 |
| OD-13 | Trace rule and thresholds [D20, D21] | **Yes, as proposed.** Note that it edits owner-confirmed CLAUDE.md text | The website merge gate |
| OD-14 | Re-Risk Apply guard [D6] | **Refuse if the proposal is older than 7 days or for another account. Otherwise confirm, naming the keys** | SAFE-0b |
| OD-15 | Should resting orders count toward the caps and margin? [PO-5; LIFECYCLE 2] | **Yes, with the values unchanged** | PO-B; OD-1 |
| OD-16 | Should the autopilot and the watchdog flip the shared list? [D13] | **Stop** | S-5 |
| OD-17 | Collapse standard, (a) triangle or (b) the Card's ▾, and memory [D19, D8] | **Tell me what your phone shows; then (a), remembered on every page** | UI-1 |
| OD-18 | Blockers fold and pre-fix labels [D9] | **Fold, labelled per row until they age out (≈26-09 22:46Z)** | UI-3 |
| OD-19 | Go-live card [D4] | **Remove it** | UI-6 |
| OD-20 | Picker location and order routing [D2] | **Put the picker under TRADING. Orders keep going to the trading account** | UI-8 |
| OD-21 | Version display [D3] | **Show the web and agent commits** | UI-4 SB2; GW-1 |
| OD-22 | M7 probes; quiet-symbol staleness [H-P1-4] | **Parallel probes under a cap, with backoff ≤ 5 min.** The staleness rule for quiet symbols in open markets (0066.HK, `V3-SEQUENCE:540`) needs your wording | M7 |
| OD-22b | Trade page snapshot interval [D22] | **Keep 5 s while the page is visible; measure it with your key** | None |
| OD-23 | Equity-stop push per side [PR-5] | **The V3 default** | C5 |
| OD-24 | Research path [H-P6-1..5; research D3's closed windows] | **Pooled replay; the tightenings; research stages S0–S5 and the 27-trial budget; the holdout declared by 28-09; three 30-day windows** | Q2; stage A |
| OD-25 | Later research inputs [H-P6-6..8, -10, Q3-ret] | **Keep the segments and the regime rows** (the regime rows before about 11-10). **Take slippage from measured fills** | Later P6/P7 |
| OD-26 | Retire fib_618_fade and ema_pullback; cancels [D14] | **Retire fib_618_fade now. Retire ema_pullback after the overlap measure. List each cancel** | D14; PO-M1 |
| OD-27 | vwap anchors and va/vp sessions [D15] | **Fix them, then review** | S-7 |
| OD-28 | Bar store, backfill and compaction [D16, D18; 9440 Q9] | **Phase 0 now.** Build the store only past p95 token wait > 5 s, or > 5 % deadline hits. Backfill 2 years of 1h, as research | HIST-1, -2 |
| OD-29 | 16 symbols armed only on unscanned timeframes [D17 = 9440 Q9] | **Show them as unreachable now. Add 4d, 3d, 12h and 8h only with a restore** | S-6 |
| OD-30 | Tick switch and ownership [D1; H-P6-9; PR-2 (a), (c)] | **Fix the label now.** Tick stays blocked under your thresholds, including on …0058 during the trial. Imports are done by you only | UI-4; the auto switch |
| OD-31 | Roster [H-P2-1 (a), (b), (d); (c) is OD-1's account scope] | **Your wording is needed.** The pins arm tsmom on …0058 only, while `momentum-account.json` says `_all`. After 18-09 the daily pass ran only on …0058, and two accounts never ran (05:01:52Z). It is not verified whether the pins or the Trade cell stop the others | P2 |
| OD-32 | Goal semantics, REC start and bar [H-P5b-3; LIFECYCLE 1] | **Show unrecoverable rows separately and don't count them. Confirm 25-09 08:50Z as the start, and "one full day with no new flag" as the bar** | P5b, REC |
| OD-33 | Close records with no reason; refuse reasonless approvals? [9440 Q3; LIFECYCLE 3] | **B4b's list (05:04:03Z): the 4 MSFT.US `pre_contract` rows labelled unrecoverable by rule; SGDJPY final "no reason recorded"; Cocoa on …0949 was adopted without the bot's label (likely your trade, *inference*), so yours to label. Yes, refuse** | REC (CLS-04) |
| OD-34 | Your logged-in session, 30–60 min [H-P5b-5] | **After Wave 1.** It checks the WEB rows, OD-17 and B4 | WEB, P5b |
| OD-35 | Broker-only positions [H-P5b-2; W15] | **Report only, labelled** | W15 |
| OD-36 | Calendar bound; money-contract closure [K1c-Q; H-P2-4] | **Keep the bound, demanded calendars first. Move the money items to P5b** | P2 closure |
| OD-37 | Small record switches [9440 Q5–Q7; I3-R7, -N7; B1-fee, B1-N7; P5bd-5; LIFECYCLE 4] | **I3-R7 off (it amends live TPs); I3-N7 yes; the conversion fee stays out; the lesson tuner skips rejected rows; L2a uses `findLimitFill`'s evidence rule; the MARKET row reading `open` with no position (Q5b) is checked against the broker and fixed by a named record; X1's "unresolved" becomes its own state; a partial hour reads "partial"; confirm fixed deposit currencies. LIFECYCLE 4 (keep referenced `risk_events` past the 90-day prune; 560.8 MB): your call on disk** | Small follow-ups |
| OD-38 | Storage and hosts [9440 Q1, Q4, Q9; H-P8-2, -4, -5, -6; F9; PERF-0 host] | **Keep 50 GB until retention days are set; weekly volume backups; one durable host for the soak and the harness. Q4: discard the empty staged Railway change after a read confirms it is empty (a Railway write: yours). H-P8-5: all 7 accounts; you own the rollback; rehearse it on demo or accept Not Verifiable; the monthly cost ceiling is your figure** | P8 T3–T5; M3 host |
| OD-39 | Positions and orders outside the rules [PO ask-first] | **Leave …0949's 12 to their stops. Your 3 manual orders stay yours. No stop-entry type now** | None |
| OD-40 | Leftovers ["reseted?"; 8,991·C2; H-P1-5] | **"reseted?" and 8,991·C2:** your wording is needed; no source was found. **H-P1-5:** allow a read-only look at the Railway logs for 24-09 23:37–23:50Z, for M4's diagnosis | None |
| OD-41 | Pre-build the gated items this weekend? [data.py:182] | **Yes** | Monday timing |
| OD-42 | NOT_EXECUTED terminal; the trigger check [H-P0-3, H-P0-4] | **Keep.** NOT_EXECUTED is terminal (#1124); the check runs every loop (1 min in production, `maxAgeMs` 180000 at 05:16:42Z; 5 min is only the fallback), at most one broker check per plan per 60 s (#1132; `momentum-partial-runtime.js:75-76`, `:107-113`) | None |
| OD-43 | Gateway `/health` after Monday [`V3-SEQUENCE:791`; 9440 Q9] | **Keep it public until GW-1.** Any change is gateway code, so it rides GW-1 (OD-6) | GW-1 |

---

## §7 The timeline (*inference*)

**Assumptions** (`roadmap/data.py:97-108`): two builders; about 50 min per S or M item; 19 min between merges; 4 in 10 checks ask for a fix first; your answers by Mon 01:00Z; no CI outage.

| Milestone | Planned (V3, roadmap v2.2) | Revised |
|---|---|---|
| No-answer items | Not in V3 | Sat 26 – Sun 27-09: about 7–9 h, up to 7 more restarts |
| Owner-gated chain "all merged" | Mon 28-09 ≈ 12:50Z | Wave 2's subset by 13:00Z. T4 on Tue 29-09. GW-1, S-8, S-4/S-5, W3, WEB-6b, C5, UI-8, B5 and Q2 from Mon 16:00Z to Wed 30-09. C7 and C11: not dated |
| P1/P4 window | Mon 28-09 13:30–16:00Z | Unchanged, if merges stop at 13:00Z and the harness runs. Otherwise Tue 29-09 |
| First natural T4 plan | 28-09 21:05Z | **Not datable**: …0058 holds 6 against a cap of 5 |
| K3 in place | Mon 08:11Z | Mon, by about 12:30Z. S-8 by 30-09 ~15:00Z |
| P5a soak ends | 29-09 04:01Z | The same. Or about Sun 27-09, if OD-10 moves CV-2 into Wave 1 |
| P5d windows | 29-09 and 22-10, 17:30Z | Unchanged |
| P2 weekend, DST | 02, 04, 05-10; 25-10, 01-11 | Unchanged |
| P6/P7 stage A | 30-09 to 02-10 | Unchanged, if OD-24 is answered by 28-09 |
| fib shadow verdict | — | New; not datable |
| P8 T2 first retire | demo 03-10, live 05-10 | Live about 25-10 to 01-11. Demo no earlier than about late January 2027 (§2) |
| Momentum checkpoint | 19-12 | Unchanged |

### Progress and on-track verdict (26-09 21:30 SGT)

**Verdict: the build is on track through Monday. The whole of V3 is not yet on track, because Wave 3 has not started and is gated on answers that are not in.**

| Stage | Planned | Actual / now | On track? |
|---|---|---|---|
| Wave 1 (7 rows) | Sat 26 → Sun 27-09 20:00Z | All 7 merged Sat 07:16–09:34Z, plus #1152 and W1-FU #1157 (12:21Z). **About 34 h early** | **Done.** One proof is still open: Reasons CLS (below) |
| Wave 2 (7 rows) | Mon 28-09 01:00–13:00Z | 4 rows ready as draft PRs with green CI or checks passed (2.1, 2.3, 2.4, 2.5). 2.2 is in its fix round. 2.6 is half built. 2.7 is draft-only | **On track** for 2.1–2.5. **At risk:** 2.6, whose second half is being built tonight. T4 needs OD-1 and OD-15 |
| P1/P4 window | Mon 13:30–16:00Z + ~20:00Z | OD-4 confirmed | On track if merges stop at 13:00Z |
| Wave 3 (GW-1, S-8, S-4/S-5, W3, C5, UI-8, B5, Q2, PO-M2) | Mon 16:00Z → Wed 30-09 | **Not started** | **At risk.** S-8 has a hard deadline of Wed 30-09 ~15:00Z (HKEX holiday 01-10). GW-1 needs a gateway window. The open answers are OD-8, OD-9, OD-16, OD-20, OD-23 and OD-24 |
| "All merged" (V3 build) | Mon 28-09 ≈12:50Z (v2.2) → revised Wed 30-09 | — | **Wed 30-09 is reachable** only if Wave 3's answers arrive by Mon 01:00Z and GW-1 and S-8 are pre-built this weekend |
| V3 acceptance (evidence, not code) | P5a soak Tue 29-09; P2 weekends 02–05-10 and the DST weekends 25-10 / 01-11; P6/P7 stage A 30-09–02-10; P8 live retire ~25-10–01-11; demo retire not before ~late Jan 2027; momentum checkpoint 19-12 | Unchanged | These are calendar-bound. No build speed moves them (*inference*, as in §7) |

**What is behind, and why:**
- **Reasons CLS.** After W1-FU it is still above the row 1.2 target of ≤ 0.25. A second fix is needed; figures in the Wave 1 actuals.
- **Row 2.6 was only half built.** The first build covered the named corrections only.
- **C9's restart quarantine.** It is dormant today, but its safety hold could lift without a reconcile. It is in a fix round.

**What keeps the whole plan on track:**
1. Pre-build GW-1 and S-8 on draft branches this weekend (OD-6 and OD-7 are answered; S-8 uses OD-8's recommended default until it is answered).
2. The answers to OD-1, OD-8, OD-9, OD-15, OD-16, OD-20, OD-23 and OD-24 by Mon 01:00Z, plus C8's live-change question (§5 Wave 2 status).

---

## §8 Invariants (P3)

| # | Invariant | Result |
|---|---|---|
| 1 | This revision changed no repo or production state | **Passed:** GETs only (`/health` and `/state/momentum-targets` at 05:16:42Z; one `/state/boot-record` returned 404 at 05:28:17Z), GitHub reads and scratch files. **Disclosed:** the synthesis's draft was pushed to #1143 (`025b342`), and your merge at 04:46:56Z restarted Node; the synthesis's earlier slip (a scratch copy of `/health`, deleted within a minute) stands |
| 2 | Thresholds, caps and mandatory TP1 are unchanged | **Passed** (OD-15 changes what counts, not the values; ask-first) |
| 3 | Gateway code ships only in a gateway window | **Passed by construction.** The watchPatterns were re-checked at `5389a83` |
| 4 | No merge or trace inside the P1/P4 window | **Not Verifiable** until the window runs |
| 5 | Owner-confirmed CLAUDE.md text is untouched without your yes | **Passed** (OD-13) |
| 6 | Principles 1 and 9: all accounts are alike | **Not Verifiable until OD-31.** OD-1's account scope holds only as your per-account arming (principle 2), never as a live-account exclusion |
| 7 | Principle 3: carried blockages are addressed | **Failed today:** the restore, the book inside the scan, the TP1 block, the cap bypass; each is scheduled |
| 8 | Principle 7: vetoes are minimised | **Failed today:** 91.1 % of stops self-inflicted (new plan §4); S-1, S-4 and OD-29 address them |
| 9 | Principle 5: the plans match the code | **Failed today:** the unchecked draft on main until 1.1; `dual-environment-plan:74` against the takeover; `V3-SEQUENCE:729` "weekdays", contradicted by the code and the Fri 25-09 21:05:40Z pass |
| 10 | Every number carries a source and a time | **Not Verifiable** as a blanket claim |
| 11 | No colour-only signal | **Passed** |
| 12 | No id collisions | **Passed after this revision's renames:** V3's research ids carry "research" (research D3, research stages S0–S5), P8 steps carry "P8" (P8 T0–T5), and a bare D-n is always the new plan's. The draft **Failed** this (D3, D5, D7, S0–S5) |

---

## §9 Not verified, and the risks (P6)

### Not verified

- **B4c's recovery:** seen only through B4b's named list (05:04:03Z).
- **Why the daily pass skips the other accounts** (pins or the Trade cell; OD-31). **Saturday passes** (*inference*: yes; next Sat 26-09 21:05Z).
- **Pre-order unknowns:** whether cTrader accepts an absolute SL on a closed-market LIMIT; the gap distribution; the spread at limit fills; the 17 PRE rows older than the risk-event window; the weekend hours of the universe's 10 commodities; the broker's weekend crypto maintenance breaks (a gap source).
- **The direction evidence behind the 4 open tsmom shorts;** the lane's "setup" grouping.
- **Lane counts not re-read:** STK-08v2's 57,807 unsent (57,817 outbox rows at 04:59:18Z); B2's 4 probing rows; CV-1's 8 skipped deploys; the 39 extra pins and 91 cells; 91.1 % self-inflicted stops; the BTCUSD spread.
- **Your phone's view** (D19) and the logged-in website rows; **S-4's fold** against 256 KiB; the **Railway** build-time commit variable and staged change (9440 Q4); the trace harness's absolute times (same-harness comparisons are valid); the content of 8,991·C2 and "reseted?"; every date in §7.

### Risks

1. **T4 turns trading back on.** OD-1 limits it to the armed accounts and to open-market orders. Its HTF limits wait for OD-15. The 3 live accounts need their own yes.
2. **S-2 changes when exits run** for 22 book rows: read back Mon 21:05Z before T4, then Fri 02-10 21:05Z. Until S-2, weekend passes send stock exits into closed markets (`MARKET_CLOSED`, Fri 25-09 21:05:40Z).
3. **Pre-orders bypass the caps.** …0949 holds 12 PRE fills against a cap of 5. Nothing re-enables them before OD-15.
4. **Every merge restarts Node.** #1143 already caused one restart (04:47Z). Wave 1 adds up to 7 on a crypto-trading weekend.
5. **The M3 record has a gap from 04:48:32Z** (the #1143 boot is missing). Restart the harness before Wave 1; land NEW-1 first.
6. **S-4 can break the scanner reference.** The declared shadow set guards it.
7. **S-4 and D12 change the numbers that 10 `decision_log` readers report.** Each is tested.
8. **GW-1 restarts both gateways.** Demo first needs cpp-acct's auto-deploy paused.
9. **K3 and S-8 can miss 01-10.** If so, the next holiday becomes the first real test.
10. **There are 45 decisions.** OD-0 to OD-8 unblock most of Waves 1–3, and OD-4 is needed by Mon 13:00Z.

---

## §10 Verification record

**The verifiers:** facts (code at `5389a83`; production 05:01–05:05Z) and reasoning (production 04:58–05:04Z, plus the lane join). Their corrections are cited as F-n and C-n, their missing items as M-n.

**Applied, after my own check:**
- **F1–F4, C1** (#1143 merged, its restart, the stale banner, new reads): GitHub about 05:17Z, `git show`, `/health` 05:16:42Z.
- **F5** (harness stopped): `ps` at 05:16:03Z. I added the container restart at about 04:56Z (uptime at 05:16:09Z) and the harness doc's own warning.
- **F7, C11** (weekend passes): the code, and the 25-09 21:05:40Z pass. **F9, C15** (watchPatterns). **F10, F11** (citations): re-read `loop.js:380-512`, `exec-engine.js:567-602`, `closed-market-limits.js`. **F12**: fixed by renaming, not only reported.
- **F13–F16, F18, F20:** `reply-9440.md`, `LIFECYCLE-SPEC:405-413`, the `V3-SEQUENCE` H-rows and :540/:623/:791, `momentum-partial-runtime.js:74-113`, `db.js:528-540, 1897`.
- **F17, M4** (F1–F9): the inventory lane, `exit-coordination:205-245`, the #1099, #1110 and #1116 commit messages, the harness doc.
- **C2–C5, C7–C10, C12–C14, C16, C17, C20:** the verifiers' saved reads and the code (C14's mechanism is `closed-market-limits.js:56-57`; C7's limit `watchdog_state.cpp:117`; …0949's 12 PRE fills from the 04:59:51Z positions read). **C18:** as notes and splits (OD-22b; OD-31(c)), without renumbering. **M1–M3, M5–M10.**

**Modified:**
- **F6 against C19 (P8 T2 dates):** the verifiers disagree, so I recomputed from the 05:05:40Z segment list and the 04:59:20Z `rate24h`. Measured rates span 0.044–0.163 GiB a day, so both dates are ranges. Rejected: "demo not before April 2027" (V3's planning rate is below the measured weekday rate) and "live no earlier than 01-11" (V3's own rate gives 25-10).
- **F19 against C6 (counts):** C6 is right by the plan's own definition; I also re-dated W3, WEB-6b and F3, giving 7 / 18 / 2 / 1.
- **F10:** cited `exec-engine.js:571-572`, where the words are, not `:570-571`.
- **F8:** S-2 cannot merge before Monday, so the first quiet-hours pass after it is Fri 02-10 21:05Z. "Scan disabled" stays a test; a production check would need a switch.
- **M1:** the Sunday 06-09 orders are not attributed to the pre-open window: 0005.HK was placed about 10 h before the HK open, outside the default 6 h.
- **C8:** PERF-0 is already merged, so NEW-1 takes its place.

**Rejected:**
- **F17's "F8 = `order_deals_inexact` (:246-249)":** that is F7 (`:236-239`); 246–249 is the timed-out attempt.
- **F14's "H-P1-5: no content found":** it is at `V3-SEQUENCE:688`.
- **The 86,600 ms first loop as my figure:** attributed to the verifier, since my GET returned 404 (05:28:17Z).

**My read times:** worktree fetch 05:12:42Z; `/health` and `/state/momentum-targets` 05:16:42Z; GitHub about 05:17Z; re-computations 05:20–05:26Z; branches 05:43:38Z.
