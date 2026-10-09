# Note to Codex from claude-builder — 08-10-2026, 23:5x SGT

Owner's order: "stop after leaving a note, let Codex finish". This is the
note, in full. The short form is on branch `agent-locks`
(`.agent-lock.json`, notes[], commit `4b8df75`). Claude · № 12,286 08-Oct.

---

## 1. What I did today (three fixes the owner ordered after № 12,279)

All three came from `docs/scan-trade-analysis-2026-10-08.md` and were merged
under the standing gate (full local gate green, CI green, mergeable clean).

| PR | Squash | What it does | Read-back |
|---|---|---|---|
| #1272 | `b9e82c5` | **Close attribution.** `attributeBrokerClose` used to return the broker receipt first whatever it said, and `reclassifyBrokerCloses` skipped the closers' journals for any row with a verified receipt. A MARKET closing order carries no initiator at cTrader, so a verified market receipt ended attribution at "initiating actor or rule not verified" even when the keeper or the book sent the close. Now a receipt that names the cause (SL/TP leg inferred from the bracket) still wins; a receipt that only proves a market fill composes with the journal: `profit_keeper: time cap (broker market close verified)`. The reclassifier uses the same receipt-aware attribution. The cross-side backfill log now names the attribution read's state when it is not idle. | Deployed 15:18Z. NAS100 trade 1775 on …0949 upgraded from the generic stamp to "stop loss hit, SL leg inferred". The five older market-close rows (02–06 Oct) are unchanged so far: they upgrade only where a journal entry exists, and the reclassify pass runs inside the reconciler. |
| #1273 | `394e70f` | **Broker roster from the loop.** The roster (which accounts the token can see) was written only by `POST /actions/ctrader-accounts`, i.e. the Connect/Accounts pages, so every link light read "unknown — roster stale" whenever nobody opened a page for a day. New `agent/services/broker-roster-refresh.js`: lists accounts by the stored token when the record is older than six hours, through the same `GET_ACCOUNTS_BY_TOKEN` and the same `recordBrokerRoster` writer (empty list never recorded; failures paced 30 min). Wired after the market-hours refresh; controller `broker_roster` (6 h, stale past 12 h) registered in `heartbeat.js` and `shared/controller-groups.js`. | Deployed. `rosterFresh: true`, all seven link lights green at 15:38Z. **Passed.** |
| #1274 | `dbde7fc` | **Capped-hybrid enrolment deal read.** Changed the read's upper bound from `now() + 2000` to `now()`. | Deployed 15:43Z. **Did not clear the error.** `momentum_partial` still fails every pass with `capped_hybrid trade 1771: cTrader error: INCORRECT_BOUNDARIES` at 15:44:41Z. My first cause was wrong. |

## 2. My mistake, and what it did to your #1271

You hold a lock since 14:25Z (`codex-history-boundary`, serial 12284) on
`agent/lib/ctrader-ws.js`, `agent/services/capped-hybrid-enrolment.js`,
`agent/services/hybrid-history-diagnostic.js` and its test, for #1271
"Diagnose the rejected hybrid position-history boundaries once".

I built and merged #1274 at 15:30–15:43Z **without re-reading the lock
file**. #1274 changed the exact line your #1271 touches, so #1271 now reads
`mergeable_state: dirty`. That is my fault. Rebase hint, one line:

- main now has `(...args, owner.positionId, now(), 4000)`
- your patch expects `(...args, owner.positionId, now() + 2000, 4000)`

Your `historyAt`/`historyTo` wrapper and the `catch` that calls
`diagnoseHybridHistory` fit around main's line unchanged otherwise.

## 3. What I found about the INCORRECT_BOUNDARIES cause

Facts, in the order I measured them (08-10, UTC):

1. 13:48Z — six minutes after #1269 deployed (13:42Z), the phase audit
   records `momentum_partial failing 4x in a row — capped_hybrid trade 1771:
   cTrader error: INCORRECT_BOUNDARIES`. The line repeats every loop since.
2. Trade 1771 is 0003.HK SHORT on **42993489, the live gateway**
   (monitored position 1728, opened 07-10 05:18Z, SL 7.117, TP 6.796).
3. The enrolment's one deal read is `wsGetPositionDeals(..., positionId,
   toTimestamp, 4000)`, which sends `DEAL_LIST_BY_POSITION_ID_REQ` with
   `fromTimestamp: 0` (1970) and the given `toTimestamp`.
4. The cTrader message reference documents no maximum period for
   `ProtoOADealListByPositionIdReq` (fromTimestamp ≥ 0, toTimestamp ≤
   2147483646000) and does not mention INCORRECT_BOUNDARIES. (Fetched
   from help.ctrader.com/open-api/messages, 08-10.)
5. The same read with `fromTimestamp: 0` is **answered on the demo
   broker**: `P&L position history [46979908]: positionId 242004561 …
   state recovered, scanned 2, closingDeals 1` at 15:37Z.
6. On the **live** account the same read appears never to be answered:
   the cross-side backfill logs `P&L backfill [42993489] cross-side: 0
   filled, 4 deals read, 3 gaps before read` on every pass all day. The
   "4 deals read" is `wsGetDeals` (DEAL_LIST_REQ, a bounded window) and
   works; the three gaps are position-deal reads (from 0) that never fill.
   A failed read there is swallowed as "not evidence", so no error line.
7. After #1274 removed the 2-second-ahead upper bound, the error persisted
   (deployment caa10fad, 15:43:38Z; failing line at 15:44:41Z from that
   deployment). So the upper bound was not the cause.

My reading: the live broker refuses a window that opens at 1970, the demo
broker accepts it. I cannot prove which bound it objects to without a probe
against the live broker — which is exactly what your #1271 does (four
bound variants, recorded, read-only). **Your diagnostic should land first
and settle it with broker evidence.** The follow-up should also fix finding
6: every position-deal read on the live account (`cross-side-pnl.js`,
`position-lifecycle-evidence.js`, `old-position-pnl.js`, `pnl-backfill.js`)
uses the same 1970 window and has the same symptom. That is the broader
defect behind your "history-fix" note, and it is bigger than the capped
hybrid.

## 4. The correction I have built and am HOLDING (not pushed)

Kept as a git stash and a patch in my container; not on any branch.

- `agent/lib/ctrader-ws.js`: `wsGetPositionDeals(..., toTimestamp,
  timeoutMs = 5000, fromTimestamp = 0)` — a trailing optional, so every
  existing caller keeps its 1970 window unchanged; the payload sends
  `fromTimestamp: from` where `from` is the floor of a positive finite
  value, else 0. One ws unit test asserts both payload shapes.
- `agent/services/capped-hybrid-enrolment.js`: the candidate query also
  selects `t.opened_at`; new `dealWindow(openedAt, nowMs)` returns
  `[opened − 1 d, min(now, opened + 6 d)]`, or `[now − 7 d, now]` when the
  open time is unknown or in the future; the read passes `to` and `from`.
  A close after the window is caught by the existing held-volume check
  (`openingReceipts` requires the opening total to equal the broker's held
  volume). Two tests: the live-host scene receives exactly that window and
  enrols; `dealWindow` edge cases.
- 99 tests pass across capped-hybrid, momentum-partial-runtime, ctrader-ws,
  ctrader-ws-retry, position-lifecycle-evidence and cross-side-pnl.
  Mutation M7 (lower bound back to 0) red on the named test; tree restored.

I will not push it, nor touch your two locked files, until your lock is
released or you say so on `agent-locks`. Your call:

- (a) you land #1271, read the probe result on 1771, and take the fix
  yourself — I will hand over the patch on request;
- (b) you land #1271 and tell me to push mine as the next PR;
- (c) you fold the bounded window into #1271.

## 5. State as I stop

- Main `dbde7fc`; my working branch is on it, clean. No open PR of mine.
- Nothing subscribed, no check-in armed, no agent running.
- Owed, to ride the next code PR of mine: the CLAUDE.md ledger line for
  #1272/#1273/#1274.
- Read-backs still open: the five market-close rows on …0949 (A·2) after
  the next reclassify pass; the `momentum_partial` controller after your
  fix lands.

Conversation ref: ordered "stop after leaving a note" after № 12,284 · this note № 12,286
Effort: max
Session: https://claude.ai/code/session_01C1hz86KuE5JKVq6W2KtUE2
