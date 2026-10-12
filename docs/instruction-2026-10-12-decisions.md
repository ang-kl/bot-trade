# Instruction — the decisions of № 13,345, built, deployed and proven live

Claude · № 13,346 · 12-10'26 05:38 SGT · claude-builder. Written on the owner's
order "create an instruction from № 13,345, knowing the fixes should work after
implement live and tested". Source of every item: № 13,340·G, № 13,341·E,
№ 13,344·A/B and the consolidated list in № 13,345. Facts below were read from
production (commit a99ab09) and the code on 12-10 between 05:20 and 05:38 SGT.

This document is an instruction, not an approval. **Each work item starts only
after the owner approves its ID** (№ 13,345·D·1: "reply with the IDs you
approve"). Held items are listed in §4 with what would reopen them.

---

## 1. Definition of done (applies to every item)

An item is done only when it works **live** and the evidence says so. Green
tests alone are not done.

1. **Branch and PR.** One PR per item, or a group when §3 says so, on the
   working branch, restarted on `origin/main` after every squash-merge. PR body:
   what and why, the boundary output, the tests, `Conversation ref:` (ordered
   and reported serials), `Effort:` read from `get_session`. No model name.
   Changed lines carry `// Claude · № N DD-Mon (ordered № X; claude-builder)`.
2. **Tests that can fail.** Every behaviour change gets a test that fails on
   the unfixed code and passes on the fix. Show both. Prefer the real path:
   real SQLite (`initDB(':memory:')`), the real route over HTTP, and a
   stand-in broker socket (`_setWebSocketForTests`, as in
   `agent/routes/order-route-post-approval.test.js`). A source pin, checked
   on source with comments stripped, is for wiring only.
3. **Mutation checks.** For each rule the item adds, assert that the target
   text is present, mutate it, confirm it is gone, run the suite, then
   restore from a saved copy (never `git checkout` on a dirty file). Every
   mutation must be killed by a named test. Report the list.
4. **Never mutate while the full gate runs.** Twice on 11-10 a gate had to be
   stopped and re-run because a mutation loop edited files under it.
5. **Full gate**, all green: `node --test agent/**/*.test.js`, `npx eslint .`,
   `npx vitest run`, `npm run build`, `npm run check:no-green`,
   `node scripts/ui-control-inventory.mjs --check`. Paste
   `scripts/check-protected-boundary.sh` into the PR. A protected path changes
   only with the owner's yes **naming that file**.
6. **Review.** Request `@codex review`. Fix every finding with a failing-then-
   passing test, reply on the thread, then resolve it. **Mark the PR ready
   before merging and wait for the review that marking ready triggers.** On
   #1322 that review found a real issue after the merge.
7. **Merge** (squash) once CI is green, `mergeable_state` is clean and every
   review thread is closed. Then unsubscribe, restart the branch and add a
   note on `agent-locks`.
8. **Deploy read-back (every item):**
   - `/health` reports the merged commit;
   - all `/state/heartbeats` controllers are ok, or any warning is explained
     and seen to clear;
   - every open position keeps a broker stop (`broker_sl`).
9. **Live acceptance (per item, §2).** Run the item's own check in production
   and report it as **Passed**, **Failed** or **Not verifiable until <time>**.
   If it can only pass when a market opens or a trade happens, book a
   check-in (`send_later`) and say so. Never report it as done before then.
10. **Timing.**
    - Deploys and research runs avoid the first hour after the Sydney (23:00
      UTC), London and New York opens.
    - Research never starts within 30 minutes of a restart: the bar-form job's
      own 0.5 busy-share limit would abort it.
    - A docs-only change rides with the next code PR, so it doesn't cause a
      restart on its own.

---

## 2. Work items

### W1 — D1: the postmortem measures R against the stop at entry

- **Why.** `agent/services/loss-postmortem.js` (≈ line 535) divides by
  `trades.sl_price`, which the momentum book overwrites with each trail. 39 of
  56 momentum postmortems divided by a trailed stop. The r-audit
  (`/state/theory-gap?section=r-audit`) shows PF 0.60 against the broker's
  initial stop, where the reports say 1.45.
- **Change.** Take the R denominator from the stop at entry, in this order:
  `broker_sl_initial`, the risk event's proposal stop, then the monitor's
  `initial_risk`. When none exists, record "no initial stop on record" and
  write no R; never fall back to the trailed stop. Existing rows are left
  as they are, unless the owner orders a re-score.
- **Tests.** A momentum trade whose `sl_price` was trailed: the old code
  scores the inflated R (red), the fix scores R against the initial stop
  (green). A trade with no initial stop gets no R and a named reason.
- **Live acceptance.** The next postmortem written for a trailed momentum
  trade carries R against the initial stop. Compare it with the r-audit row
  for the same trade; they must match. Until such a trade closes:
  **Not verifiable**, with a check-in on the next momentum close.
- **Trading effect.** None.

### W2 — D2: regime-gate refusals record stop, target and conviction

- **Why.** 385 trend-against-trend refusals in 30 days can't be scored,
  because `recordRegimeBlock` (`agent/services/gate-skips.js:33`) stores only
  bias, side and entry.
- **Change.** `gate-skips.js` only. The caller (`loop.js:1765`) already
  passes `synth` and `signal`. Add `sl`, `tp1`, `tp2` and conviction to
  `detail`, taken from `signal ?? synth`. No change to `loop.js`, the
  gate's decision or the stage. (This corrects № 13,345, which said it
  touches the loop file.)
- **Tests.** A regime block written through the real recorder carries the
  four fields. A missing field is recorded as `null`, never guessed.
- **Live acceptance.** After deploy, the newest `decision_log` rows at stage
  `regime_block` carry the fields: read them through
  `/state/theory-gap?section=regime-blocks` or the blocker report's records.
  Before the first new refusal: **Not verifiable**.
- **Trading effect.** None.

### W3 — H1: a read-only capped-hybrid status card

- **Why.** The hybrid runs every minute: 21,978 passes, 0 plans on 12-10.
  But its decisions are readable only through a private diagnostic
  (`readHybridVerdicts` in `agent/services/diagnostic-readout.js`).
- **Change.**
  - `GET /state/capped-hybrid`: the redacted view `readHybridVerdicts`
    already builds (enrolled, excluded with the allow-listed reason,
    delegated, deferred, errors, coverage, pass age), scoped by
    `?account=`.
  - A card on the positions page: one line per open position, showing
    enrolled (trigger, half size), or excluded with the reason in plain
    words.
  - Read-only. No new write, and no broker read.
- **Tests.** The route against a stored pass record (enrolled and excluded
  rows), the redaction (no raw error text), and a missing record shown as
  "not available" (never an empty healthy list). Add a vitest for the card,
  and regenerate the UI inventory.
- **Live acceptance.** The card lists all open positions with a verdict
  matching the rules. Today's expected verdicts:
  - …0949 crypto: manual, outside the manual scope;
  - NVDA, JPYX: mean reversion;
  - book positions: paused, the book's own rules.
- **Trading effect.** None.

### W4 — T2: tick switch policy set to automatic

- **Why.** Owner principle 2: tick is switched on and off by a human **and
  automatically by the bot**. Every account's policy is manual today.
- **Change (operation, no code).**
  `POST /actions/entry-mode-policy {accountId, policy:'auto', expectedRevision}`
  for each **enabled** account (…0949, …7342, …0058, …9908, …3489). Read
  `configRevision` from `/state/tick-readiness` first, and handle a 409 by
  re-reading.
- **Live acceptance.** `/state/tick-readiness` shows `auto` for each enabled
  account. `requestedEntryMode` and `effectiveEntryMode` stay `TIME_BASED`.
  `readyCount` stays 0. No entry-mode change happens until an account is
  ready.
- **Trading effect.** None until a profile passes validation (W6, then T4).

### W5 — D0: longer stored history after each trade

- **Why.** 102 of 151 clean trades (68%) run past the end of their stored
  history before the stop or target is reached, so no exit rule can be
  ranked.
- **Change (operation).**
  - Read `GET /state/aftermath-extend-preview` for the count, the bars and
    the storage estimate, and report them.
  - Then apply with `POST /actions/extend-aftermath` in bounded batches,
    outside the market opens.
  - Check `/data` usage before and after (it was 6.0 of 10 GB on 11-10 and
    grows about 1 GB a week).
- **Live acceptance.** `/state/exit-counterfactual` over the same 90 days:
  the truncated share drops from 102 of 151, and the common cohort (51 of
  151 on 11-10) grows. Report both numbers, and the `/data` delta.
- **Trading effect.** None. It is a write to the postmortem store.

### W6 — T1: tick research over every tick recorded since September

- **Why.** Tick entries can switch on only after a profile passes the
  owner's bar in `agent/config/tick-validation.json` (replay: 40 trades,
  PF ≥ 1.3, max drawdown 8R, expectancy lower bound ≥ 0). The last research
  (03-10) covered about 17 hours of live ticks, and nothing passed.
- **Change (operation).**
  - `POST /actions/tick-research` with `dryRun: true` first: list the
    sealed segments on both sides (demo since 11-09, live since 27-09),
    the trial count and the record count against `maxRecords`.
  - Report the plan, then run it without `dryRun`, one job only, in the
    research slot.
  - Before, during and after: heartbeats, fast-monitor skipped ticks and
    busy share, event-loop lag, broker stops, Railway CPU and memory for
    bot-trade and the serving gateway. Afterwards the segment cache should
    be empty.
- **Live acceptance.**
  - The job finishes, or is aborted with the reason named.
  - Trials are imported to `/state/tick-research`, each with its replay
    verdict.
  - Protection is unchanged before and after.
  - Report the best profile per symbol class against each threshold.
  - A profile reaching REPLAY_PASSED goes to T4 (§4), which needs the owner.
- **Trading effect.** None.

### W7 — D4: the bar-form small run

- **Why.** It is the only comparison of tick-built bars against time bars.
  The dry run passed on 11-10 at 12:52 SGT; nothing has run since.
- **Change (operation).**
  - After W6, re-run the dry run first: segment names change as the spool
    rolls.
  - Then make the same request without `dryRun`: demo side; NATGAS
    (10055) and AVGO.US (11668); 10 segments; cross-check [10055]. The
    limits come from `agent/config/research.json`. The predeclared design is
    in `docs/comparison-design-2026-10-11.md`.
- **Live acceptance.**
  - `/state/bar-form-research` shows the run, its cells and the
    cross-check.
  - The resource receipt (runtime, memory, pulls per minute, temporary
    bytes) is within the declared limits, with before and after read-backs
    as in W6.
  - The results are reported as candidates, not conclusions (design §2.4).
- **Trading effect.** None.

### W8 — M1: the momentum TP1/TP2 plan on every account

- **Why.**
  - The book builds its orders with no target (`buildEntrySynth`, `tp1: null`),
    so the order step refuses them unless the account is listed in
    `agent/config/momentum-entries.json`.
  - Only …0058 is listed. On the other four accounts momentum can't trade.
  - The last momentum order opened on 30-09.
- **Change.**
  - Teach `loadMomentumEntrySwitch` (`agent/services/momentum-entry-switch.js`)
    an `"_all"` token meaning every enabled registry account, matching
    `momentum-account.json`. This is principle 9: no hardcoded account list.
  - Then set `"accounts": ["_all"]`.
  - A missing or malformed file still means off.
  - The plan itself is unchanged (`risk_coverage_partial_v1`):
    - TP1 = 3R + the cost reserve;
    - about 25% is closed at TP1, sized so the trade nets about zero if the
      rest is later stopped at the original stop;
    - TP2 = TP1 + 1R, set as the broker take-profit;
    - the runner trails on the book's 3×ATR stop.
- **Tests.**
  - `_all` covers every enabled account and leaves out disabled ones.
  - An explicit list still works.
  - Malformed means off.
  - Through the real dispatch: a book entry on an account other than …0058
    now carries the plan; on the old code it is refused for having no
    target (red).
- **Live acceptance.**
  - `/state/momentum-targets?account=<id>` shows the switch on for every
    enabled account.
  - The next momentum entry anywhere records a plan (`recordedPlans` ≥ 1),
    and the broker shows TP2 as the take-profit.
  - When TP1 is reached, the partial executes with a confirmed fill and a
    confirmed remaining position, recorded in one transaction.
  - Each of these needs a natural entry or trigger: **Not verifiable** until
    then, with a daily check-in after the 21:05 UTC pass.
- **Review point (owner's).** After 30 momentum closes, report PF measured
  against the stop at entry (W1). Recommend stopping if it stays under 1.0.
- **Trading effect.** Yes: momentum entries resume on every enabled account,
  under the existing regime gate, entry brake, 10% volatility sizing and
  8-position cap.

### W9 — H3: the manual-position hybrid on every account

- **Why.** `agent/config/manual-hybrid.json` names only …7342 and …3489.
  Owner principle 9: setups apply to every account.
- **Change.** The same `"_all"` token for `accounts`, read by
  `agent/services/manual-hybrid-policy.js`. The evidence rules are unchanged:
  - a complete opening record;
  - a recorded original stop, never inferred from the current stop;
  - a broker take-profit beyond 2R;
  - two halves the broker can execute.
- **Tests.** A manual position on an account outside today's list:
  `manual_account_not_authorised` on the old code (red), and judged on its
  evidence on the new code (green). The NAS100-shaped refusal
  (`manual_original_stop_missing`) still holds.
- **Live acceptance.** The W3 card shows manual positions on every account
  judged on evidence; no `manual_account_not_authorised` remains. A real
  partial needs a natural 2R: **Not verifiable** until then.
- **Trading effect.** Yes, but only on manual positions that meet the
  evidence rules.

### W10 — H2: the hybrid's 2R trigger and 50% fraction become stored settings

- **Why.** Principle 9. Today `capped-hybrid-policy.js` fixes 2R and the
  exact half in code.
- **Change.**
  - A stored setting (for example `capped_hybrid_json`), defaulting to 2R
    and 50%, with ranges validated.
  - The plan must **carry the values it was made with**: `validPlan`
    re-computes the plan and compares it exactly, so changing a setting
    later must not invalidate plans already armed.
  - `capped-hybrid-policy.js` is protected. Start only on the owner's yes
    naming this file.
- **Tests.**
  - A byte-identical check: with no stored setting, every plan and refusal
    matches today's.
  - A stored 2.5R produces a 2.5R trigger.
  - A plan armed before a settings change still validates.
- **Live acceptance.** After deploy, with no stored setting, the W3 card and
  the pass record show the same verdicts as before the deploy.
- **Trading effect.** None until someone changes a value.

### W11 — the book's daily trail skipped XOM.US (no decision needed)

- **Why.** On 12-10 `/state/momentum-book` showed XOM.US (…9908) with
  "not reached: account not in this pass", while UNH, SHOP and MA were
  checked.
- **Change.** Find why …9908 was missing from the book's trail pass, and fix
  it if it is a defect. The broker stop (157.45) is still held.
- **Live acceptance.** The next book pass shows XOM checked (trailed or
  declined with a reason).
- **Trading effect.** The book's own stop is maintained, as designed.

---

## 3. Order

| Phase | Items | Trading effect |
|---|---|---|
| A — now, no trading effect | W1, W2, W3, W4, W11 | None |
| B — research and storage, one at a time | W5 (D0), then W6 (T1), then W7 (D4) | None |
| C — changes to live trading | W8 (M1), W9 (H3), then W10 (H2) | Yes; each with its own live check |

W3 comes before W9 and W10, so their acceptance can be read on the card.

---

## 4. Held, with what reopens each

| ID | Held | Reopens when |
|---|---|---|
| D3 | Any exit or R:R-floor change | 30 days after W5, if an exit rule then ranks above the live stack on the common cohort |
| H4 | Lock +1R at 2R when a position can't be halved | The same evidence as D3 |
| T3 | Lowering the tick validation bar | Not proposed. The profile on the gateway measured PF 0.29–0.34 |
| T4 | Deploying a passing tick profile to the gateways | W6 produces a REPLAY_PASSED profile. Pushing the registry was refused to the agent's session on 07-10, so this step may need the owner |
| M2, M3 | Keep only …0058; hand book positions to the general profit-taking | Not recommended |

---

## 5. Reporting

- Each item ends with a stamped reply giving:
  - what was built;
  - the PR and merge commit;
  - the tests and mutations;
  - the deploy read-back;
  - the live check as **Passed**, **Failed** or **Not verifiable until <time>**, with the check-in that will settle it.
- Nothing is reported as working before its live check passes.

---

## 6. Status, corrections and findings (kept current; Claude · № 13,401 12-Oct, updated № 13,489, № 13,571, № 13,638 and № 13,672; claude-builder)

This section records what happened to each item, so the document stays
checked against the code (owner principle 5). Each later PR updates it.

### 6.1 Approvals received (12-10, SGT)

| Item | Approval | Protected files named |
|---|---|---|
| W1, W2, W3, W4, W11 | "W1 W2 W3 W4 W11" (after № 13,350) | W11: `agent/loop.js`, `agent/services/momentum-book.js` (06:16) |
| W5, W6, W7 | "go B" (after № 13,381) | none |
| W8 | "go W8" (after № 13,381); "go W8 W9 W10 merge when green" (after № 13,449) | `agent/loop.js`, for the Codex P1 fix on #1327 (yes after № 13,458) |
| W9 | "yes to W9 … manual-hybrid-policy.js" and "Okay W9" | `manual-hybrid-policy.js`, `manual-hybrid-enrolment.js` |
| W10 | "yes to … W10 … capped-hybrid-policy.js", then "yes to W10, capped-hybrid-enrolment.js" | `capped-hybrid-policy.js`, `capped-hybrid-enrolment.js` |
| Lot fix (not in §2) | "Go lot fix" (after № 13,394) | none |
| Hybrid audit text (Codex P2 on #1327) | "Yes, change it" (after № 13,483) | `momentum-partial-runtime.js` |
| W6 code (not in §2) | "Raise the cap (code change)" (after the W6 dry run's 413) | none |
| #1330's Codex findings | "Fix in #1330 now" (spill directory; CLI output), "Add a spill-byte cap", "Record it on the trials" (12-10, № 13,615–13,635) | none |
| Mixing live and demo in one W6 job (Codex P1 on #1330) | "Merge now, decide later" (after № 13,637); then "Key streams by side" and "One PR, 3 items" (12-10, before № 13,670): the sides fix and #1330's two post-merge Codex P2s in one PR | none |
| W5 batches | "Resume slower", then "Stop W5 for today" (12-10) | none |

### 6.2 Item status

| Item | Built | PR | Live check |
|---|---|---|---|
| W1 | `initialRiskOf` (broker first stop → proposal stop → monitor `initial_risk` → `sl_price` only for a trade the book never trailed) | #1325, merged 12-10 07:48 SGT | Not verifiable until the next momentum-book close (check-in 05:20 SGT 13-10) |
| W2 | `recordRegimeBlock` stores `sl`, `tp1`, `tp2`, `conviction` | #1325 | **Passed** 12-10 07:52 SGT: the first refusal after deploy has stop, target and conviction (`scorable` 1) |
| W3 | `GET /state/capped-hybrid` + the Trade-page card, one line per Open positions row | #1326, merged 12-10 08:20 SGT | **Passed** 12-10 08:23 SGT: the card's rows equal the Open positions table for all accounts and for each of the five; 10 rows, each with a verdict and a reason |
| W4 | `policy: auto` on all five enabled accounts | operation, no PR | **Passed** 12-10 06:13 SGT: auto, TIME_BASED, STABLE, readyCount 0 |
| W11 | the book trail reaches manage-only accounts (`registryManageAccounts`); the summary counts them apart | #1326, merged 12-10 08:20 SGT | after the next book pass (21:05 UTC) |
| W8 | `"_all"` in `momentum-entries.json` names every enabled account; every caller checks the registry | #1327, merged 12-10 08:36 SGT | **Passed** 12-10 08:41 SGT: the plan is on (market and limit) on all five enabled accounts, and archived …2148 is off with the reason named. The next momentum entry carrying its plan is not verifiable until one opens |
| W9 | `"_all"` in `manual-hybrid.json` | #1327 | **Passed** 12-10 08:40 SGT: no `manual_account_not_authorised` remains. The manual enrolment now examines the four …0949 pad positions and defers them on `monitor_entry_conflict` (§6.4) |
| W10 | `capped_hybrid_json` (default 2R / 50%) read by both enrolments; exact or refused at any volume | #1327 | **Passed** 12-10 08:41 SGT: nothing stored, the setting reads the defaults, and the card's verdicts are unchanged |
| Lot fix | an empty pad Lots box sends no cap | this PR | the next blank-lots pad order is risk-sized |
| W5 | batch 1 applied 12-10; batch 2 stalled (0 updated, 25 errors). The fetch window now starts at each row's last bar and steps forward; "no newer bars yet" is not an error; a stopped call returns `resumeFrom` | #1331, merged 12-10 (7feb4e49); then the batches (operation) | after batch 1: truncated 99 → 71 of 152, common cohort 51 → 79 of 152, `/data` +3 MB. After batch 7 (each about 82 s, 100 fetches, 0 errors): truncated **55** of 152, common cohort **95** of 152, `/data` +36,864 bytes over the batches. **Stopped for today** (owner): 406 rows remain, to resume another day from cursor `1786321592000:865` |
| W6 | the dry run answered 413: 92,274,616 records (live 40,265,284; demo 52,009,332; 55 segments) against the 5,000,000 cap. The replay streams one symbol at a time above 5,000,000 records; cap 150,000,000; worker heap 4,096 MB; abort and `clearCache` | #1330, merged 12-10 11:52 SGT (80d79f71); streams keyed by side in this PR | **Passed** 12-10 12:03 SGT: `maxRecords` 150,000,000 live; 44 controllers ok/retired/idle; 10/10 positions with a broker stop. The run waits for this PR, then for the owner's word |
| W7 | not started (after W6) | operation | — |

### 6.3 Corrections to §2 (what the text said vs what the code needed)

- **W2.** §2 said "taken from `signal ?? synth`". The record takes them from
  `synth` first: the two are equal except after a watchlist direction
  override, which mirrors synth's stop and targets, and the record's side is
  synth's. Taking the signal's values first would store a long's stop on a
  SELL row.
- **W8.** §2 named only `momentum-entry-switch.js`. `_all` needs the registry,
  which that leaf module has no handle on, so every caller passes `isEnabled`
  (`registryEnabled`): the resting limits, the status route and the market
  path in `loop.js`. With no reader, `_all` names no account. The first build
  let the market path trust the caller's roster; Codex (P1 on #1327) showed
  the roster can fall back to the legacy roles list, so `loop.js` changed too,
  with the owner's yes naming it.
- **W9.** §2 named `manual-hybrid-policy.js`. The manual enrolment
  (`manual-hybrid-enrolment.js`) selects trades with `account_id IN (list)`,
  so `_all` also needed that file; without it the manual hybrid would have
  stopped on every account.
- **W10.** §2 named `capped-hybrid-policy.js`. Both enrolments build the plan,
  so the stored setting is read there (`capped-hybrid-enrolment.js`,
  `manual-hybrid-enrolment.js`). The partial manager's journal and log lines
  in `momentum-partial-runtime.js` read "capped hybrid 50% at 2R" whatever the
  plan carried; after Codex's P2 on #1327 and the owner's yes they are the
  plan's own, and a default plan's text is unchanged. The research replay's
  "current policy" also follows the stored setting (Codex P1 on #1327).
- **W3.** §2 said "one line per open position". The first build read open
  trades; the Open positions table it sits under reads active monitors. A
  monitor with no linked trade, or whose trade is no longer open, showed in
  the table and not on the card (Codex P2 on #1326, twice). The card now reads
  the table's rows and scope, with no row cap, and names a row the hybrid
  cannot examine.
- **W11.** §2 said "no decision needed"; the fix needed `loop.js` and
  `momentum-book.js`, both protected, so it waited for the owner's yes.
- **W6.** §2 assumed one job could replay every tick since September. The
  keeper refused any job over 5,000,000 records, and the dry run counted
  92,274,616. Raising the number alone was not safe: the replay held about
  104 bytes of heap per record (measured on a full 64 MiB segment), so the
  whole spool needed about 9.6 GB in a worker of the trading process. The
  replay now spills each symbol's quotes to a temporary file (32 bytes a
  record) and replays one symbol at a time; over four segments its peak RSS
  was 1,016 MB against 1,979 MB in memory, and it stays flat as segments are
  added. The trials are the same, trial ids included. The worker's heap is
  capped at 4,096 MB, so an overflow stops the worker, not the process.
  `POST /actions/tick-research/abort` stops a run with a named reason, and
  `clearCache: true` empties the temporary segment cache when the job ends.
- **W6, the two sides** (№ 13,672). The replay keyed each stream by symbol
  id, and `replayCostContext` said the two sides' ids "do not collide in
  practice". 27 ids are recorded on both (§6.4), so one job over both sides
  interleaved two instruments in one stream, a gap on one side re-warmed the
  other, and an id was charged whichever side's cost class the stored map
  listed first. In a job over both sides each stream is now
  `<environment>:<symbol id>`; each trial names its environment; a gap
  re-warms and is listed for its own side only; the cost class and the regime
  name come from the trial's own side; and the parity report reads a trial's
  side from its environment. A job over one side is unchanged, trial ids
  included (pinned in `tick-replay-sides.test.js`), except that its cost
  class is now its own side's: an id its side does not classify is no longer
  charged the other side's class, so its trial reads `costSource` none, which
  the replay rung refuses. Codex (P2 on #1332; owner "Per side + parity"):
  the manifest's 200-gap list is capped per side, each side says whether
  its list was cut, and the parity report reads a mismatch past the last
  gap a cut list names as not comparable (`gap_list_truncated`), on one
  side or both: past that point a recorder drop cannot be ruled out.

### 6.4 Findings while building (decisions for the owner)

- **The book's rank exits do not run on manage-only accounts** (W11). The
  per-account entry/exit pass is the entry roster; W11 fixed the trail only.
  A manage-only account's book position therefore exits by its stop, never by
  the daily rank. Changing that touches `momentum-book.js` again.
- **A durable "trailed" marker on book rows** (Codex P2 on #1325). The
  postmortem cannot tell an untrailed book row from a trailed one after the
  fact; today it writes no R when no entry-time stop is recorded (0 of 57
  tsmom trades in 365 days). A marker would be written in `momentum-book.js`.
- **The pad's empty Lots box sent a hidden 0.01 cap** (the DOGEUSD question,
  № 13,394). Fixed by the lot fix.
- **W3 read-back: the book positions read `trade_origin_not_bot`**, not
  `monitor_paused` as §2's expected verdicts said. Both exclude them; the
  origin is simply the first rule that applies. No change needed.
- **The four …0949 pad positions defer on `monitor_entry_conflict`** (W9
  read-back, 12-10 08:40 SGT). For each, the position monitor's entry and the
  trade record's entry differ in ticks, so the manual hybrid will not act on
  them until they agree. Which field is right has not been measured yet
  (failure mode #6: find the disagreeing field against the broker first).

- **W6 takes hours, and one job mixes the two sides.** The replay costs
  about 20.5 µs per quote per stage-A grid point (measured on a synthetic
  segment; the oracle's windows are O(rangeEvents) per quote). Twelve grid
  points over 92,274,616 records is about 6.3 hours of one core: about 2.7 h
  for the live side and 3.5 h for the demo side. A Node redeploy during the
  run loses it. Both sides land in one cache and one job, and a symbol id
  that exists on both sides interleaves the two feeds out of time order.
  **Measured 12-10 12:00 SGT** (`/state/tick-recorder`, per-symbol counters):
  54 ids recorded live, 61 demo, **27 on both**. Codex raised the same point
  on #1330. Options: refuse a job that mixes the sides (W6 then runs one side
  at a time, naming its segments: 24 live, 31 demo, at most 64 per request),
  or key each stream by side and symbol id. **Decided** (12-10): "Key
  streams by side", built in the PR that carries this line (§6.3). W6 runs
  on the owner's word after it merges: one job over both sides, or one per
  side (about 2.7 h live, 3.5 h demo).
- **`verify_watchdog` failures on 12-10 are not explained by the W5
  batches.** They occurred at 00:40, 01:57 and 05:25 UTC, the first two with
  no batch running. The first batch call did coincide with 3.9 s of Node
  event-loop lag at 05:10:20 UTC. Whether the batches add to the watchdog's
  failures is not established; the batches stopped for the day before it
  was.

### 6.5 Held items (§4) — unchanged

D3, H4, T3, T4, M2 and M3 stay held as §4 says.

### 6.6 Working rule (owner, 12-10, about 10:07 SGT)

*"Merge when green. Don't fix on 'fly by the seat of your pants' and on a
whim."* From then on, every fix in this work:

1. names the failure and its evidence first (a reproduction or a measurement);
2. traces the real path;
3. writes a test that is red before the change;
4. then changes the code.

A review finding is a claim to trace, not an order. Each new Codex finding on
#1330 was traced and brought to the owner before any code changed (§6.1).
