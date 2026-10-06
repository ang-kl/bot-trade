# Addendum to the 04-10-2026 handover: MAE and Chandelier, and the stop-loss

Prepared 04-10-2026 07:25 SGT (03-10-2026 23:25 UTC) by Claude Code.
Addendum to [`docs/handover-2026-10-04.md`](handover-2026-10-04.md) (PR #1221, merged as `8b4b360a`). A merged pull request cannot be edited, so this addendum ships as its own docs PR and corrects the handover where it was wrong.

Conversation ref: ordered № 10,966 (owner: "create an addendum to the PR for the changes, upload to /doc ... explain why we need to use Chandelier and MAE to address Stop-loss and how to make sure it works") · Effort: high.

Marks: **Verified** (read from code, git, a test or a production route in this session), **Inference** (reasoned, not proved), **Not Verifiable** (cannot be checked from here). No claim in section 2 is backed by a backtest of Chandelier or MAE; none exists in this repository.

---

## 1. Corrections to the handover

1. **cpp-verify never served MAE or Chandelier readings.** Handover §2.2 says "#1180 observe-only MAE and Chandelier readings (served from cpp-verify, later removed in #1207)". What cpp-verify had was `GET /mae-chandelier-observe` (commit `faad8440`, 01-10): it read no broker and no position and returned constants (`mode: observe_only`, `mayAmend: false`, `readOnly: true`, one sample call on empty input), backed by a 50-line header `mae_chandelier_observe.hpp`. It was a guard showing the verifier cannot amend, not a source of readings. **Verified** (`git show faad8440`). The real per-position readings lived in Node (a fast-monitor tick and `GET /state/mae-chandelier`) and, from #1182, could send stop moves with receipts.
2. **MAE was not removed by #1207.** My answer at № 10,965 said MAE and MFE are "no longer computed or recorded anywhere I can see". That was wrong. `agent/services/position-manager.js` (`evaluatePosition`) refreshes `mfe_r` and `mae_r` for every open position, `agent/loop.js:2714` and `agent/services/fast-monitor.js:553` persist them every loop and every fast tick, `agent/db.js:206-207` defines the columns, `agent/services/cockpit-snapshot.js` shows `maeR`, and `agent/services/weekend-watch.js` and `agent/services/loss-postmortem.js` read them. **Verified.** What #1207 removed is the separate OBSERVER: its record, its bar cache and fetch, its tick, its amend path and receipts, the route and the verifier stub.
3. **What survives of Chandelier** is the since-entry trail spec: `sinceEntryTrailSpec` in `agent/services/mae-chandelier-observe.js` (the file kept its name because `agent/stop-policy-callsites.test.js` reads it), called by `agent/services/profit-keeper.js:776`, which pushes it to cpp-exec's TrailEngine (`POST /trail-config`). The spec is 3 × Wilder ATR(22) behind a peak that starts at the entry; its `source` is `mae_chandelier_since_entry`. **Verified.**

---

## 2. Why Chandelier and MAE belong in the stop-loss

### 2.1 The problem the numbers show (all from `docs/replays-2026-10-03.md`, production read-only 03-10 11:28Z to 13:00Z)

- Profit factor 0.78 over 294 closes in 30 days. **Verified.**
- 79% of gross losses came from stop fills at or beyond the original stop within hours. **Verified.**
- Replay D1: a wider initial stop (1.5×, 2×) did not help. PF fell 0.75, 0.70, 0.68 once unresolved trades were counted at their window mark. This is a bound, not a measurement. **Verified.**
- The risk gate already floors the stop by the hourly ATR (the replays measured it widening the stop by a median 4.1×). So the initial stop is already volatility-aware, and widening it further is unsupported.

So the loss is concentrated in initial stops, and moving them outward is not the answer. Two different questions follow, and MAE and Chandelier each answer one.

### 2.2 MAE answers "is the initial stop in the right place?"

MAE (maximum adverse excursion, kept here in R, so `mae_r` of −0.8 means the trade went 0.8 of its risk against the entry) says how far trades go against you before they work.
- If winning trades rarely draw down beyond some depth, a stop beyond that depth carries risk that buys nothing, and a tighter stop could cut loss size without cutting winners.
- If winning trades often reach deep drawdowns first, the stop is too tight or the entry is early. `loss-postmortem.js` already names that case: "escaped" is MAE ≤ −0.8R before winning, "the entry was nearly stopped out" (`loss-postmortem.js:167-171`).
- MAE is a measurement. It does not move a stop. Its job is to tell whether a stop rule is right before any rule is changed, which is the discipline the owner asked for after the replays ("nothing changes the live record for the better" until measured).

**Not Verifiable:** whether an MAE distribution would change any live stop. No MAE-distribution study of closed trades has been run. Whether closed trades keep their final `mae_r`, or only open positions do, I did not check.

### 2.3 Chandelier answers "does the stop follow a winner without choking it?"

The Chandelier exit (LeBeau) trails a stop at the highest price since entry minus a multiple of ATR, 3 × ATR(22) here. Three properties matter for this book:
- **Volatility-scaled.** It sits further back in noisy markets and closer in quiet ones, so it neither strangles trades on ordinary pullbacks nor gives everything back.
- **Ratchet only.** It moves the stop in the trade's favour and never loosens it. cpp-exec's TrailEngine and the stop policy's never-loosen rail enforce that independently of this spec.
- **Targets the "gave back" failure.** `loss-postmortem.js:174-177` names the case where a trade peaked at +NR and banked far less ("Bank earlier or trail tighter for this setup"). A trail is the mechanism that converts a peak into a banked gain.

Where it sits in the stop policy (`docs/stop-policy.md`): every bot stop uses the Opposite trigger; once a stop locks profit, the broker trails it server-side so it survives a bot or sidecar outage; the Chandelier spec supplies the level the TrailEngine ratchets towards.

### 2.4 What is NOT shown

- **No evidence in this repository that Chandelier or MAE raises profit factor.** The replays measured stop width, direction, the R:R gate and pooled verdicts, not a Chandelier trail. The C·6 exits grid (nine points, 477 trials) found no passing combination; I do not claim it tested Chandelier.
- The removed observer's own record is weak evidence either way: its one recorded production reading (06:25Z 03-10) was a Saturday with one position monitored, so it shows the observer had nothing to measure, not that the idea fails.
- The case for keeping the trail is therefore structural (it addresses the "gave back" shape and cannot loosen a stop), not empirical. The case for MAE is that it is the missing measurement.

---

## 3. What is in place today (Verified)

| Piece | Where | State |
|---|---|---|
| MAE/MFE in R per open position | `position-manager.js` `evaluatePosition`, persisted by `loop.js:2714` and `fast-monitor.js:553`, columns `mfe_r`, `mae_r` | Running every loop and fast tick |
| Since-entry Chandelier spec | `mae-chandelier-observe.js` `sinceEntryTrailSpec`, called at `profit-keeper.js:776` | Pushed to the sidecar; test `profit-keeper.test.js:646` pins the spec and its source |
| Trail execution | cpp-exec `trail_engine.cpp/.hpp`, `POST /trail-config`, `GET /trail-status` (`cpp-exec/src/main.cpp:1171,1235`); test `test_trail_engine.cpp` | Ratchets towards the spec's level |
| Stop policy and never-loosen rail | `agent/lib/stop-policy.js`, `stop-policy-controller.js`, `exec-engine.js`, `cpp-exec/src/protection_ratchet.hpp` | Live since #1183 to #1187 |
| Independent read of the broker stop | cpp-verify `verify_session.cpp` (trigger method and trailing flag per position) | Read-only |
| No second stop authority | `agent/services/fast-monitor-no-observer.test.js` | Pins that no `mae_chandelier` amend is sent |

---

## 4. How to make sure it works

Work through the layers in order. A layer that fails is a stop; do not read the next layer's numbers as evidence.

### 4.1 Wiring (offline; run now)

```
shopt -s globstar; node --test agent/services/profit-keeper.test.js agent/services/fast-monitor-no-observer.test.js agent/stop-policy-callsites.test.js agent/stop-loss-integrated.test.js
cd cpp-exec && make test          # includes test_trail_engine and test_protection_ratchet
```
Pass means: the keeper builds a spec with the right source, no second amend path exists, the stop policy stamps correctly, and the TrailEngine only ratchets. **These tests exist and passed in the last gate (Node 7,474 tests, 0 failures); they prove the logic, not the market.**

### 4.2 Live, read-only, during market hours (Monday; US open 13:30Z)

Do this with positions open and the market open. A Saturday read proves nothing (the observer died on one).
1. **Specs are pushed.** The Node log line `[since-entry-trail] trail-config N spec(s)` should appear, and N should equal the number of open positions that have bars and symbol digits. **Failure sign: N = 0 with open positions.** That is the same cause that killed the observer (bars never reached the cache). Check the bar cache and digits first.
2. **The engine holds them.** `GET /trail-status` on cpp-exec (bearer) should list each spec with its `peakPrice`, `trailDistance` (3 × ATR) and `currentSl`.
3. **Stops only tighten.** For each position, `currentSl` over time moves only in the trade's favour, and never beyond price. **Failure signs:** a stop that loosens, a stop on the wrong side of price, or a TAMPER row from the reconciler on a bot-moved stop.
4. **The broker agrees.** cpp-verify's independent read of each position's stop (`GET /protection-status`) matches the TrailEngine's last sent level within a refresh, with the Opposite trigger set and trailing set once the stop locks profit. `GET /state/stop-policy` shows no `policy_refused`. **Not Verifiable until live:** the four broker unknowns in `docs/stop-policy.md` (does trailing read back, do omitted flags reset, where does trailing anchor, does the trigger change take-profit triggering).
5. **Nothing else moves the stop.** `agent/services/fast-monitor-no-observer.test.js` pins that no `mae_chandelier` amend is sent; a log line with that source would be a regression.

### 4.3 Outcome (needs weeks of closes; the owner sets the bar)

Wiring and read-backs prove the stop moves as designed. They do not prove it helps. To judge that:
1. **Record before comparing.** For each closed trade keep its entry R, MAE (R), MFE (R), banked R and exit cause. **Not Verifiable:** that closed trades retain `mae_r`/`mfe_r` today; `loss-postmortem.js` recomputes them from bars, which clips early holding periods (`loss-postmortem.js:515-518`). If they are not retained, add that record first.
2. **Fix the success test in advance.** Proposal for the owner to confirm or change (I have not been given these thresholds): trailed positions bank a larger share of their MFE than before (the "gave back" share falls), the share of winners stopped out at a small profit does not rise, and profit factor is not worse. Use the repository's own evidence bar (30 closes, a positive lower bound on expectancy); fewer closes is not evidence.
3. **Compare like with like.** There is no randomisation, so compare the same strategies and accounts before and after, and report the sample size. Sides flip with the window in this data (replays, point 2), so do not read one window's result as an edge.
4. **A bad outcome has a switch.** The stop policy can be turned off with `POST /actions/stop-policy {"enabled":false}` with no redeploy; it does not revert positions already stamped, and the bot never sends `trailingStopLoss:false`.

### 4.4 Known gaps that can make it silently not work

- **Bars missing.** The spec is dropped when ATR or digits are missing (`sinceEntryTrailSpec` returns null, "so the keeper drops the row rather than push a spec the sidecar cannot round"). A position with no spec has no Chandelier trail and nothing says so. Add a counter of dropped rows if layer 4.2.1 shows N below the open count. **Inference** that this could recur; the cause was found for the observer on 02-10 and fixed in #1193 (bars from the position's own host).
- **Momentum-book rows.** The stop policy gives book rows the Opposite trigger but no broker trailing (the book's own daily 3 × ATR trail is their stop authority). I did not verify whether the keeper builds a Chandelier spec for book rows; check this before reading the trail's effect on them.
- **Weekend and closed markets.** No bars and no quotes by design; a closed-market read is expected to show nothing.

---

## 5. What depends on a human

1. **Decide whether the observer's visibility should come back.** Removing it also removed the one place that showed, per position, whether a Chandelier level existed. Options: nothing (rely on 4.2 reads), a read-only status line of spec count against open positions, or a restored read-only `GET /state/...` view. This is your call; none is built.
2. **Confirm or change the success test in 4.3.2.** I will not invent the thresholds.
3. **Run or authorise the Monday reads.** I can do the read-only checks in 4.2 once the market is open and the session is running; they need the read secret and market hours.
4. **Anything that moves a stop by hand, changes a risk limit, or touches a broker order** stays with you.

---

## 6. Verified 07-10-2026 (Claude · № 11,583·A, fixed under № 11,596·D·1)

The owner's condition was "proceed after this verification on the stop-loss programming (Chandelier, MAE, etc.) is active on all accounts". Read-only, production, 06-10 21:00–21:35Z:

| Part | Verdict | Evidence |
|---|---|---|
| Opposite trigger on every stop, broker trailing once the stop locks profit | Passed, all 7 accounts | `/state/stop-policy`: enabled, OPPOSITE on_lock; controller last pass 7 accounts, 9 positions, 9 amends, 9 read back. Verifier: 9/9 `stopLossTriggerMethod: 2`; the 3 live accounts read ok with 0 positions. Trailing 0/9 is right: the two profit-locked stops (ETHUSD 1644, SHOP.US 1692) are momentum-book rows, trigger-only by design. |
| MAE / MFE readings | Passed, every managed position | `mae_r`/`mfe_r` refreshed by the position manager and persisted each loop and fast tick on …7342, …9908, …0949; book rows read 0/0 by design. |
| Chandelier since-entry trail | **Failed outside the selected account …0949** | Node log: `[since-entry-trail] trail-config N spec(s) for account 47790949` only; nothing for …9908 or …7342 since 05-10 while they held eligible managed positions (1722, 1723, 1724). Cause: `agent/loop.js` starts the guardian with `getCtraderCreds` and `agent/services/guardian.js` ran the trade guards and the profit keeper with that one account's credentials. `loop.js` no longer calls either, so the guardian's sweep was the only caller. |
| Engine-side spec held by cpp-exec | Not Verifiable at the time | `GET /trail-status` on the gateway needs EXEC_SECRET; no Node read existed. |

**The fix (PR under № 11,596·D·1).** The guardian's sweep walks every enabled registered account on both sides, the stream's account first (`sweepAccounts`), and runs the trade guards and the keeper per account. One constraint shaped it: the sidecar's `POST /trail-config` is a single full replace per gateway (`cpp-exec/src/trail_engine.cpp`, `configure`: `byPosition_.swap(next)`), so account-by-account pushes would each wipe the others' specs. Each keeper pass therefore defers its push (`deps.deferTrailPush`, `summary.trailSpecs`) and the sweep sends one union per side. A backstop sweep now runs at least every 5 minutes while anything is held, so a gateway restart no longer waits for the next 0.05% move to get its specs back. `GET /state/trail-status?account=<id>` reads the engine's live set for that account's side, which turns the last row above from Not Verifiable into a read: the union must list every eligible managed position on both gateways.

**Read-back to do after the deploy:** `[since-entry-trail] trail-config N spec(s) pushed for the demo side (accepted)` and the same for the live side in the Node log; `/state/trail-status?account=46979908` listing 1722/1723/1724 beside …0949's positions; the heartbeat `guardian` ok.
