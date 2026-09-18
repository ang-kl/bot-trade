# First-principles audit — 19-09-2026 (v2.1, independently redone with the three Railway logs)

Owner orders (19-09-2026 05:4x–06:0x SGT): "Audit thoroughly into the current
spec and codebase. Any overdrift work, compress settings, confuse algorithmic
strategies. A step back to check against the first principles of this
project." Then: commit it here; read the two attached sidecar logs; revise and
thoroughly, independently redo the audit with an action plan; execute.

v1 was the № 7,967 report (three read-only investigators + a production read).
v2 is a redo from primary sources by the session itself: every number below
was re-measured from the state routes, the closed-trade table (500 most recent
closes across the four demo accounts, 11-08 → 18-09), the Railway logs of all
three services and the three uploaded logs (cpp-exec and cpp-acct 13:53–21:32
UTC 18-09; the Node service 21:26–21:57 UTC 18-09, 1,001 lines). Where v2 contradicts v1 it says so (§J). Nothing was
changed by the audit itself; the action plan (§K) is what changes things.

---

## A. Verdict

A·1 The stack is not judged by its own evidence. Twelve scan strategies with no
positive clean record are pinned ON for every account by default; the one
system whose *design* matches the measured horizon (the weeks-long momentum
book) is disarmed globally by a 20-close watchdog verdict and survives on hand
pins — and its own live record is also a loss (23 closes, 3 wins, PF 0,
−$2,165), because it never gets to hold: the longest live hold was 11 days
against a 10–60-day edge, and the same signal fired on three or four accounts
at once.

A·2 The exits are inverted against the "exit asymmetry" principle. Of the 500
most recent closes, the exits this system chose are net losers (stops −$8,426
over 86 closes with one win; gap/liquidation stops −$4,537 over 21; time caps
−$2,779 over 168 with a median hold of 31 minutes), and the only profitable
class is the 200 closes the record cannot attribute to any owner
("closed at the broker", +$4,387). The machine's winners leave through a door
it does not know it has.

A·3 The operator surface says one thing and the engine does another: 186
operator-facing keys, 17 stored production overrides all looser than the
defaults except a $150 flat daily cap that bound 5,900 refusals in a week; a
5 % per-trade headline that is arithmetically unreachable under the 1.5 % cap;
a 69 % win-rate goal shipped against a principle that forbids it.

A·4 The process is unstable at the market close: the Node loop hung twice in
13 minutes on 18-09 (21:05 → 21:17 "scanning 1 symbols", 21:17 → 21:30
"monitoring 12 positions"), the watchdog killed it both times, and every
restart re-pushes credentials to both sidecars and re-imports 683 statement
deals. The fast monitor was skipping most of its ticks before the second
hang ("previous pass still running", 72 times in 31 minutes).

## B. What the three logs say (13:53–21:57 UTC 18-09)

B·1 cpp-exec (demo): booted on the #956 deploy at 13:53:54; `TELEMETRY_PATH`
unset so order telemetry is off; recorder spool ready, switched ON by the
keeper at 13:58:14 with the tick shadow (53 symbols subscribed); connected
4/4 demo accounts; request pacer 40/s; async session. Two further
`credentials updated via /connect (4 accounts)` at 21:18:47 and 21:32:01 with
"spot feed kept" — those are the two Node restarts (§B·3), not rotations.
No `order_submit` line in eight hours: the demo side placed nothing, which
matches the 12 approvals in `/health` all predating the deploy.

B·2 cpp-acct (live): booted 13:53:41; no spool (`TICK_SPOOL_PATH` unset), no
telemetry; connected 1/3 — …2148 and …9009 refused `CH_ACCESS_TOKEN_INVALID`
(known, B2/B7); the keeper still pushes the full tick shadow-sim cost
schedule to this side at 14:01 although nothing here can use it (an inert
push every deploy). Every line of both sidecars is logged at severity
`error` because the sidecar writes all of its logging to stderr
(`main.cpp:41`, `engine.cpp:23`, `http_server.cpp:16`); Railway's severity
is therefore meaningless for the sidecars and cannot be alerted on.

B·3 Node (from the Railway log, same window): `[watchdog] LOOP HUNG — no cycle
activity for 12m, stuck in phase "scanning 1 symbols" (loop #409, started
21:05:29)` → exit 1 at 21:17:42 after 26,611 s uptime; boot; then `LOOP HUNG
… "monitoring 12 positions" (loop #1, started 21:17:51)` → exit 1 at
21:30:51; boot. Both hangs sit in the US close / after-hours window, in
phases that call the broker (bars, positions). The 21:30 boot then logged
`GD.US: close failed — MARKET_CLOSED` and `KO.US: close failed` on …7342 and
…9908 every pass (owed book exits retried into a closed market) and `…7342:
margin exhausted (headroom $-1664.55)`.

B·4 The Node service log (21:26–21:57 UTC, 1,001 lines) adds four facts.
(a) The machine's own arming ledger, printed at 21:53:12, agrees with this
audit: "pinned cells: 69 across 7 accounts … 68 have too few own closes to
judge an edge … 5 would be disarmed right now on their own evidence" — and
the five are `tsmom_long` on …0058 (6-loss streak), …0949 (6), …7342 (5 of
8), …9908 (3 of 3) and `vwap_trend` on …7342 (7). The book is pinned by
exception against the account's own record, not only the pooled one.
(b) The fast monitor is overrun: "previous pass still running — skipped N
tick(s)" 72 times in 31 minutes, beside "Cycle past soft deadline — skipping
pending-order phase". That is the shape of the "monitoring 12 positions" hang
the watchdog killed at 21:30:51.
(c) 404 `[protection]` lines in 31 minutes — 156 of them "N targetless — N
momentum-book (trail only)", 124 "deferred to target-restore", 124 "target
NOT restored — nothing to restore (MSFT.US, KO.US, …)": a guard reporting,
every minute, that book rows carry no take profit, which is their design.
(d) `Pending orders skipped: fib_618_fade not trade-armed for …0949` every
cycle: a retired strategy's path still runs and reports each minute. Also:
the recorder at 1,506,418 events / 0.33 GB with 48.19 GB free; the tick
shadow closing a trade every ten minutes (ledger seq 102 → 105); two pending
orders; reconcile quiet.

B·5 The momentum daily pass at 21:17:52 (right after the first restart) built
the universe for all seven accounts: 280 rows, 114 tradable, 151
`below_min_lot`, 15 `unknown_symbol`; on …3489 (live, $56 equity) 0/56
tradable. It entered nothing.

## C. Strategy confusion (07-09 P5: one system per horizon, one account per system)

C·1 Sixteen producers can open risk, eight automatically
(`agent/lib/entry-producers.js:29-146`). `agent/config/strategy-pins.json`
`_all` pins thirteen keys — fib_618_fade, cup_handle, inv_cup_handle,
ema_pullback, donchian_breakout, rsi_meanrev, vwap_trend, vp_value,
rsi2_reversion, fib_confluence, va_breakout, fvg_retrace, tsmom_long — ON for
every enabled account, across eight timeframes from 5 m to 1 mo, on the same
universe. Two of them ship `defaultOn: false` by owner order (fib_618_fade,
fvg_retrace; `strategies.js:61,75`) and are pinned anyway. The horizon
mechanism (`services/account-horizon.js`, `config/account-horizons.json`) is
empty by design.

C·2 Arming state, verified from the boot line and the pins file: 94 pinned
cells (7 × 13 + 3 reseeds); 73 still true; 21 "held" = pinned once, since
disarmed by a guard, never restored by the file (…3489 ×5, …7342 ×3,
…0058 ×6, …0949 ×7) — 23 % of the matrix is off and the config does not say
which. `tsmom_long` is OFF in the global list ("1 seeded before and since
disarmed"): the edge watchdog disarmed it 07:46 UTC 17-09 on 20 closes at
PF 0, and the `_reseed` entries (`…0949/…0058/…7342:tsmom_long:2`) restored
it by exception on three accounts. The book's master switch has no repo seed
(`momentum-book.js:139 enabled: false`; production has it true in the DB).

C·3 Five definitions of trend in one stack (SMA50, SMA100, EMA20/50/200,
SMA20/50/200, VWAP slope) beside a shared regime gate that fails open after
240 minutes (`regime-gate.js:169-174`) and that five producers never call
(pending fib limits — the counter-trend strategy the gate exists for —
closed-market limits, burn-in, VPO, the tick firer).

C·4 Live evidence per strategy, 90 days, all accounts (`/state/attribution`,
groupBy strategy; only 45.9 % of the 436 rows are this system's own dispatch):

| strategy | closes | win | PF | net |
|---|---|---|---|---|
| fib_confluence | 26 | 58 % | 2.72 | +2,656 |
| (unlabelled) | 38 | 45 % | 1.80 | +3,129 |
| rsi2_reversion | 31 | 61 % | 1.13 | +147 |
| donchian_breakout | 29 | 41 % | 1.09 | +428 |
| vwap_trend | 30 | 60 % | 0.70 | −385 |
| vp_value | 18 | 50 % | 0.61 | −554 |
| fib_618_fade | 49 | 24 % | 0.62 | −2,670 |
| rsi_meanrev | 8 | 38 % | 0.22 | −514 |
| ema_pullback | 14 | 36 % | 0.10 | −2,733 |
| tsmom_long | 6 (23 incl. adopted rows) | 0 % | 0 | −1,030 (−2,165) |
| va_breakout | 3 | 0 % | 0 | −683 |
| fvg_retrace | 1 | 0 % | 0 | −490 |
| other | 182 | 35 % | 0.47 | −2,764 |

No strategy has a clean record of ≥ 30 closes at PF ≥ 1.5. fib_confluence is
the closest (26 closes). The "PF 1.5–2.9" momentum figure in the plans is the
shadow trail rule at 10–60-day holds, not a live record; the live book has
never held that long.

C·5 The momentum book's 23 live closes, read one by one (`/state/trades`):
holds 0–263 h (median about 6 days); 19 of 23 carry origin
`reconciler_adopted` although the book placed them (the book's own entries
are adopted back as external and so excluded from "clean" evidence — a
measurement blind spot); the same symbol closed at the same minute on 3–4
accounts nine times (JPM.US ×4, 0005.HK ×4, LLY.US ×3, US30/US2000 ×2 —
correlated stacking, the E·2 mechanism, which #956 addressed only for the
scan path); 17 of 23 closes are "closed at the broker … not closed by the
bot" — the book's own rank/stop exits are not attributed to the book.

C·6 Verdict per strategy (revised from v1):
- KEEP AT HORIZON, ONE ACCOUNT, SMALL: tsmom_long via the daily momentum pass
  — the only design aligned with the measured horizon, but with a live PF of
  0 it earns a pre-registered trial, not a default.
- SHADOW: cup_handle, inv_cup_handle, donchian_breakout, vwap_trend,
  va_breakout, ema_pullback, rsi_meanrev, rsi2_reversion, vp_value.
- TRIAL (the one positive live record, under 30 closes): fib_confluence,
  half risk, until 30 closes.
- RETIRE: fib_618_fade and fvg_retrace (owner-disabled, pinned anyway,
  negative), burn-in (−$3,989 over 122 deals, 69 time-cap closes), VPO
  (bypasses the Node gate), the row-cursor book path (dead by its own header).

## D. Exits (07-09 P2: exit asymmetry sets expectancy)

D·1 500 most recent closes, four demo accounts, by exit owner:

| owner | n | wins | net |
|---|---|---|---|
| closed at the broker (unattributed) | 200 | 105 | +4,387 |
| time cap | 168 | 36 | −2,779 |
| stop hit | 86 | 1 | −8,426 |
| stopped beyond the SL (gap/liquidation) | 21 | 0 | −4,537 |
| bank at +1R (managed exit) | 9 | 9 | +241 |
| take profit | 8 | 7 | +342 |
| loss cap flatten | 1 | 0 | −2,535 |

D·2 Time caps: 168 closes, median hold 31 minutes, 69 of them burn-in and 68
"other". The cap closes a third of everything at sub-hour holds. Stops: 107
closes, one win, −$12,963; by strategy donchian −3,696, vp_value −2,282,
vwap_trend −2,112, rsi2 −1,210, va_breakout −1,162; by symbol JPM.US −2,499,
NAS100 −1,951, AVGO.US −1,776, NatGas −2,108 across 23 stops.

D·3 The keeper is a second stop authority on every book row, verified: the
book sets `monitored_positions.paused = 1` (`momentum-account.js:465`,
`momentum-book.js:520,785`); the keeper (`profit-keeper.js:406-416`) and the
loss guardian (`loss-guardian.js:143`) select by `keeper_opt_out` only and
both run with scope `all`, mode adaptive, 1h ATR in production. "The keeper
is paused on these positions" (`momentum-book.js:1161`) is text, not code.
The daily equity stop (`loop.js:5170-5210`), the daily cap
(`account-pregate.js:74`) and the loss-streak cooldown (`risk.js:1251-1278`)
also apply to book rows. Exempted correctly: the protection audit / target
applier and the weekend bank (`book-held.js:120`), the +1R take
(`managed-exit.js:123`).

## E. Settings

E·1 186 operator-facing keys: 66 risk (`risk.js:232-511`), 21 keeper, 20 goal
targets, 68 route-written switches, 11 config files; 141 controls on the Risk
and Tune pages; none decorative at the wiring level.

E·2 Nine guards inert at defaults. `perTradeRiskPct` 5 % unreachable under
`maxRiskCapPct` 1.5 % (`risk.js:874`). `dailyLossLimit` and `dailyLossPct`
out of force while the tier rule is on (`daily-loss-pacing.js:160-163,204`).
Carry, commission and slippage gates each need two edits to switch on.

E·3 Production `risk_config_json` overrides 17 keys: minSLDistancePct 0.02
(the price stop floor was effectively off — the NatGas mechanism, now
covered by E·1's ATR floor), minRR 1.6 (below HARD_MIN_RR 3.0, ignored),
maxOpenPositions 16, allowNegativeExpectancyOverride true, minTradesForKelly
10, kellyFraction 0.5, equityStopPct 0.15, maxSpreadFracOfSL 0.03, both
cooldowns 5 min, maxClusterExposure 5, maxNotionalXBalance 4,
maxConsecutiveLosses 4, marginLevelFloorPct 200, maxMarginUsagePct 0.4, and
dailyLossLimit $150 — the one tight override, binding on a $44k account
against a 3 % cap of $1,358 and the reason for 5,900 refusals in seven days.

E·4 Compression: ~28 of 66 risk keys removable, mergeable or derivable with
no behaviour change; the owner's-call residue is ~15 (the four daily tier
knobs, maxRiskCapPct, maxOpenPositions, maxAccountsPerSymbol, minRR /
minExpectancyR, maxNotionalXBalance, marginLevelFloorPct, maxMarginUsagePct,
maxSpreadFracOfSL, maxEntryDriftFracOfSL, maxConsecutiveLosses).

## F. Vetoes (11-09 P7)

Seven days: 357 approvals, 24,840 vetoes, 66,052 upstream skips, 124 distinct
reasons, approval rate 1.4 %. Largest: unfundable at min lot 17,677; bad R:R
against the 3.0 floor 14,371 + 4,626; `max_positions=…/16` 13,248 on …0949
(the book fills its own cap: 16 tsmom rows of 18); `vwap_trend OFF` 12,025 (a
disarmed cell asked every cycle). Goal target `vetoRateMax 0.9` reads green
at 90 % refused.

## G. First-principles table (07-09)

| # | Principle | Verdict | Evidence |
|---|---|---|---|
| 1 | Horizon = weeks; daily-close decisions; weekly loss accounting | PARTIAL | daily pass exists (`momentum-account.js:267,346`); loop 5-min; min hold 24 h; no weekly accounting; live holds ≤ 11 days |
| 2 | Exit asymmetry; PF + tail share, no win-rate goal | VIOLATED | §D; `goal-table.js:53 trailWinRatePct: 69`, `edge-bars.js:37,45` |
| 3 | Vol-target sizing at portfolio level; affordability at universe build | PARTIAL | per-account vol target; affordability rebuilt per cycle in batches of 40 |
| 4 | Breadth as data | HOLDS | `config/momentum-universe.json`, 56 names |
| 5 | One system per horizon, one account per system | VIOLATED (repealed by 11-09 P9) | `momentum-account.json "_all"`; `risk.js:1550-1556` |
| 6 | Judge at the cadence: equity curve, 3-month checkpoint | VIOLATED | no equity snapshot in the codebase; every verdict counts 30 closes |
| 7 | Costs and gaps in the rule | PARTIAL | min hold yes; no re-entry throttle; gap stops −$4,537 over 21 |
| 8 | The machine reports itself | VIOLATED | no `services/daily-report.js`; the report was a chat session |

## H. Size as a drift signal

93,258 source lines under `agent/`, 78,540 test lines, 435 test files; 126
test files assert on source text, 65 of them on the 6,082-line `loop.js`.
`docs/plan-execution-audit-2026-09-11.md` is 256 KB; CLAUDE.md is 807 lines,
about 60 % serial ledger; 17 of 25 plan documents predate 05-09. The 07-09
principles are recorded in no docs file.

## I. Stability

Two watchdog restarts in 13 minutes at the US close (§B·3), each re-pushing
`/connect` to both sidecars, re-importing 683 statement deals and re-running
the 35–44 s fast-monitor first pass (a pre-existing boot stall). The hangs
are in broker-calling phases with no visible per-call timeout. The
`MARKET_CLOSED` close retries on GD.US/KO.US run every pass all night.

## J. Where v2 corrects v1

- v1 said "keep tsmom_long, it has PF 1.5–2.9". That figure is the shadow's
  trail rule, not the live book; the live book is 23 closes at PF 0. v2 keeps
  the momentum design on a pre-registered trial, one account, small.
- v1 merged vp_value and fib_confluence as "one thesis". Their live records
  differ (PF 0.61 vs 2.72); v2 trials fib_confluence and shadows vp_value.
- v1 called the state routes 401; they answered 200 to the read bearer.
- v1 did not see the exit inversion (§D), the adopted-origin blind spot (§C·5),
  the watchdog restarts (§B·3), or the stderr severity problem (§B·2).

## K. Action plan (ordered; each wave one PR under the standing gate; a checker on each)

Executed on the owner's "Execute" (19-09-2026). Risk-limit-shaped steps are
named as such; each ships as repo config or code, reviewable and reversible,
never as a hand edit of production state.

**Wave 1 — arm by evidence (config + small code).**
1. `strategy-pins.json`: `_all` keeps only what has earned it: `tsmom_long`
   (trial — the arming ledger says it would be disarmed on its own streak on
   every account, so the trial runs on ONE account at the verdict's pending
   half-risk scale, and its 30-close verdict is replaced by the dated
   checkpoint in wave 3) and `fib_confluence` (trial, half risk via the
   verdict's pending scale). The nine shadow strategies leave `_all`; fib_618_fade, fvg_retrace
   leave every list. A `_shadow` note names them so the evidence shadow keeps
   measuring them at zero cost.
2. `global-strategies.json`: `tsmom_long` re-armed with a reseed marker; the
   edge watchdog judges the momentum family at its horizon (exempt from the
   20-close window; judged by the checkpoint in wave 3), so it cannot be
   disarmed again by a sample it cannot have.
3. `config/momentum-book.json` seed for the book's master switch and its cap
   derived from `maxOpenPositions` (one cap, not three).
4. The book's dispatch passes `sharedAccounts` (accounts where the symbol is
   tradable this pass) so E·2's 1/N split covers the book, ending the
   same-minute four-account stacking.
5. Burn-in retired from the producer inventory (`on: false` becomes absent);
   VPO left OFF and marked retired in the inventory.

**Wave 2 — one horizon rule (code).**
6. A `horizon` read (`paused` today) exempts book rows from the keeper, the
   loss guardian, the equity stop, the daily cap and the streak cooldown in
   one function used by all five; the book's summary text becomes true.
7. Weekly loss accounting for the momentum family (week anchor already in
   `perf-ledger.js:33`), reported on the goal table.
8. Book exits attributed: a rank exit or book stop writes its own close
   reason; book entries carry origin `bot_market_dispatch`, never adopted.
9. Time cap: burn-in gone removes 69 of 168; the remaining "other" 68 are
   audited for the strategy that owns them and the cap is per-family, not
   per-timeframe.

**Wave 3 — judge at the cadence (code).**
10. Goal table: `trailWinRatePct` and the go-live/arm win-rate bars deleted;
    PF ≥ 1.5, tail share (closes > +2R) and max drawdown added per family.
11. Nightly equity snapshot table + `/state/equity-curve` (MTM per account).
12. Pre-registered checkpoint on the goal table: momentum trial verdict on
    2026-12-19 (PF ≥ 1.5, tail share ≥ 20 %, max DD ≤ budget), one row, one
    date.

**Wave 4 — settings (risk-limit shaped; ordered).**
13. A `config/risk-config.json` seed that resets the 17 stored overrides to
    defaults except the owner's own ($150 cap replaced by the tier rule;
    maxOpenPositions back to the one cap), applied once with a content hash.
14. Compression to ~38 keys per §E·4, with the Risk page regenerated and the
    inventory test re-pinned.

**Wave 5 — stability and reporting.**
15. Per-call timeouts on every broker call in the scan and monitor phases;
    the watchdog logs the stuck call, not just the phase; the fast monitor's
    pass budget is measured and its overrun ("previous pass still running")
    becomes a health field with a target; owed book exits are not retried
    into a closed market (hours check first); the protection audit stops
    reporting trail-only book rows as targetless every minute (one line on
    change); a retired strategy's pending-order path is not run and reported
    each cycle.
16. `services/daily-report.js` reading the DB and posting to Telegram on the
    loop's daily cursor.
17. Sidecar logging to stdout for info, stderr for errors only.

**Wave 6 — docs.**
18. The 07-09 first principles written into `docs/first-principles.md` beside
    the 11-09 owner principles, with P5 vs P9 reconciled in one sentence:
    "every account may run every system it can fund; a system on trial runs
    on one account until its checkpoint".
19. Plan documents older than 05-09 archived under `docs/archive/`.

Each wave's read-back: the boot line, the goal table and the veto breakdown
after deploy, recorded in §L of this file as it happens.

## L. Execution log

- 19-09-2026 06:1x SGT: v2 filed as PR #957; v2.1 folds in the Node service
  log (§B·4). Merged 06:24 SGT (39ba525).
- 19-09-2026 06:4x SGT: **Wave 1 built** (this PR). `strategy-pins.json`
  gains `_off` (the eleven shadow strategies switched OFF on every enabled
  account, seed-once) and `_trial` (`tsmom_long` ON on …0058 only, OFF
  elsewhere; checkpoint 2026-12-19); `_all` = `fib_confluence`; `_reseed`
  emptied. The seeder writes OFF orders under `off:<strategy>` records so a
  human re-arm afterwards stands. The edge watchdog and the adaptive breaker
  skip the momentum family (`judgedAtHorizon`, `strategies.js`), reported as
  `skipped: judged_at_horizon`. `agent/config/momentum-book.json` seeds the
  book's master switch (enabled, daily cadence, 24 h hold) — the one switch
  with no seed. ONE cap: the book's slots are `min(maxPositions,
  risk.maxOpenPositions)` for the account (`effectiveSlots`, wired from
  loop.js), used for both the vol-target split and the entry cap. The book's
  dispatch carries `sharedAccounts` so E·2's 1/N split covers it. The loop no
  longer calls burn-in (heartbeat slot kept); `burn_in_probe` and
  `vpo_cpp_direct` are `retired` in the producer inventory and excluded from
  the automatic roster. Tests: pins shape, trial/off/late-joiner/human-re-arm
  semantics, scratch-file `_off`/`_trial`, watchdog and breaker exemptions,
  book seed, burn-in removal pin, effectiveSlots. Mutations red-then-restored:
  the OFF write, the two exemptions, the slot minimum. Read-back owed after
  deploy: boot line "N switched off", `_trial` ON on …0058 only, arming
  ledger no longer names tsmom_long as "would be disarmed", the momentum pass
  logging "at maxPositions … (risk maxOpenPositions caps the book's 8)" where
  it binds.
- 19-09-2026 06:25 SGT: Wave 1 merged as #958 (e8a24c1). Read-back owed
  (recorded in the next entry when read).
- 19-09-2026 06:3x SGT: **Wave 2 built** (this PR) — §K items 6–8, with
  two corrections to the plan's own text. (6) "One function used by all
  five": the keeper and the loss guardian now skip rows the momentum book
  holds (open or `exit_sent`, matched by position id or trade id through
  `makeBookHeldCheck`, counted as `bookSkipped` in each summary); the loss
  streak cooldown ignores closes labelled with a horizon-judged family
  (`horizonJudgedKeys()`); the daily EQUITY STOP was already exempt —
  `selectActivePositions` filters `paused` rows and the book pauses its
  rows — so the audit's "five guards reach the book" was four, corrected
  here; the daily CAP is deliberately left touching book rows: a cap on
  the day's realised loss is an account rule, not a per-position guard,
  and widening it is a risk-limit change (ask-first). (8) A rank exit
  journals its position event by trade id when no position id is known;
  an adopted `tsmom_long` row the book links is upgraded from
  `reconciler_adopted` to `bot_pending_fill` (`origin_source: book_link`)
  — not `bot_market_dispatch`, because the book's own entry path is the
  pending-fill path and the origin vocabulary already names it; the
  reconciler's close attribution gains matcher (c): a broker-side close
  of a book-held row is attributed to the book's 3×ATR trail stop, or to
  the book's `exit_sent` note. (7) `weekToDateFor(db, accountId)` (closes,
  wins, net of the momentum family since the week anchor) is on the
  momentum report per account — NOT yet on the goal table; the goal-table
  row lands with Wave 3's PF/tail-share/DD goals, where the weekly window
  is the momentum family's cadence for all three. (9) DEFERRED: the
  per-family time cap needs the audit of the 68 "other" cap closes against
  the strategy that owns them, which needs the token-gated trade rows;
  carried to Wave 5 with the exit-retry-into-closed-market item. Tests:
  keeper/guardian book-row skip, streak exclusion (three momentum losses
  → no cooldown; three vwap losses → cooldown), reconciler matcher (c) by
  trade id, position id, account scope and `exit_sent` note,
  `weekToDateFor`, source pins for the origin upgrade and the journal
  condition, consumer pins for the book-held helper. Mutations
  red-then-restored: the keeper filter, the guardian filter, the streak
  exclusion, the reconciler matcher.
- 19-09-2026 06:41 SGT: Wave 2 merged as #959 (c5eb105); deployed 06:42
  SGT, boot "0 applied, 0 switched off, 87 unchanged, 4 held" (seed-once
  held), book on one account. The keeper/guardian `bookSkipped` counters are
  summary fields, not log lines; they read back from the state routes.
- 19-09-2026 07:xx SGT: **Wave 3 built** (this PR) — §K items 10–12, plus
  the goal-table row for item 7. (10) `trailWinRatePct` deleted: the trail
  row is judged on PF alone and prints the win rate as a measured figure,
  never a target; the go-live and arm bars (`edge-bars.js`) lose
  `winRatePct`, the goal tracker's win-rate target and "wins needed" go, the
  go-live readiness verdict and the per-combo "armed" read become PF (+
  sample) only, and the strategy autopilot's ARMING decision drops its
  win-rate term (a stored `minWin` override is reported as ignored). Four
  new goal rows, one per strategy family (`family_edge_<family>`), judge PF ≥
  1.5, tail share ≥ 20 % (closes beyond +2R over decidable closes) and max
  drawdown ≤ 8R on the cumulative R curve over a 90-day window, measurable
  from 30 decidable closes; `/state/family-edge` serves the numbers. R is
  `realised_rr` (the broker's first stop) or its recomputation; a close with
  no readable R is COUNTED undecidable, never guessed. The 8R drawdown
  target is an evidence target for a verdict, not a risk limit: nothing
  sizes or halts on it. (11) `equity_snapshots`: one row per enabled
  account per nightly pass on both sides (balance + the broker's own net
  unrealised P&L = equity; a night the broker did not answer is a null
  point with the error), on a persisted 24 h stamp
  (`equity_snapshot_last_at`, the housekeeping due rule), heartbeat
  controller `equity_snapshot`, `/state/equity-curve?account=&days=`.
  (12) `momentum_checkpoint`: one row, the date read from
  `strategy-pins.json _trial_note` (2026-12-19) and the trial account from
  `_trial`, judged on that date and not before on the trial account's
  momentum closes since the Wave 1 deploy (`momentumTrialSince`), by the
  same three family targets; before the date it reports the decidable
  closes so far and (item 7) the week-to-date closes and net. The goal
  table grows 14 → 19 rows (the two count pins updated, per the repo's
  convention). Not built: a page for the goal table — nothing in `src/`
  renders it today, so items 10 and 12 are API + tests; a page is a Wave 6
  candidate. Tests: family-edge (PF/tail/drawdown in close order, the
  stamped R, undecidable rows, label over strategy, window/since/account
  scope), equity-snapshot (due rule, equity from balance + net P&L on the
  account's own host, a failed read written as a gap, both-sides sweep with
  token-refused skipped and the stamp before the work, the curve's change
  and drawdown over readable nights, wiring pins for the loop/route/
  heartbeat), goal-table (no WR target, family rows on/off/not_measurable
  by each of the three targets, the checkpoint row before and on its
  date). Mutations red-then-restored: the family PF term, the checkpoint
  due rule, the net-vs-gross P&L sum, the +2R tail rule, plus the maker's
  two on the win-rate bars.
