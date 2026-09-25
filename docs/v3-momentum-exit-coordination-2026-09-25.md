# P0/P3: coordinate rank exits with the partial manager

Intent: continue the approved partial-target build by ensuring a book rank exit
and its partial close cannot both claim the same position. This is software
construction and fixture verification; it does not activate a producer or
submit a production financial action.

Scope: a shared rank-exit service, both momentum book/account close call sites,
their focused tests, the partial-plan status read and this evidence contract.
Existing entries without a partial plan keep their prior close behavior.

Invariant: before a rank exit awaits broker state, it must atomically reserve
the exact account/trade/position plan from ARMED or CONFIRMED. A partial that
already owns SENDING/AMBIGUOUS/RECEIVED prevents the rank close. A rank claim
prevents the partial manager from sending. Full volume must be freshly read
from this plan's broker account/host/instrument and match its expected initial
or residual quantity, with sole current book ownership. No local-volume
fallback is permitted for a new partial plan.

The rank attempt becomes durable before sending. A timeout, crash or invalid
receipt does not authorize a retry. A valid, matching filled closing deal and
a fresh account-scoped absence read are required to confirm completion. A
late original receipt may recover the attempt without sending again. Before
any submission, a failed read can release its reservation; a prior process's
reservation can be replaced only with a different compare-and-set token, so
its delayed continuation can no longer send.

Required evidence: both race orders; initial and residual volumes; invalid
identity, stale read and changed ownership; malformed/foreign receipts;
timeout/late receipt/restart; no-plan legacy behavior; both actual book call
sites use the shared coordinator. This closes rank-versus-partial coordination
only. Producer wiring, other automatic/manual close paths, resting-fill
lineage and natural acceptance remain explicit separate checks.

## Focused evidence and preceding release

The original row-cursor call site sent a competing close in the new behavioral
test. After routing both actual book paths through the coordinator, 124 combined
rank-exit, partial-manager, momentum-account and momentum-book checks passed.
Three additional cases then passed for token replacement, an ambiguous foreign
receipt surviving a disk backup/reopen, and readback recovery without resend.
All existing book assertions are unchanged. Full repository/CI checks remain
required. The new coordinator is reached only for an already-registered partial
plan; this build does not create such plans or activate an entry producer.

#1078 merged as `dbd390f` and deployed successfully as
`c0c9e5ae-e1f2-4c9e-896f-0d63cd11298d`. At 17:18:08Z, the two report scopes
retained their prior rows and statistics exactly; the only JSON differences
were the time-driven pending-bar estimate/countdown advancing five minutes.
The first all-account lesson report took 1,078 ms in the application / 1,280 ms
in the browser; the scoped report took 73 / 396 ms. Account engineering took
83 / 397 ms. DB initialization was 452.32 ms. At 17:19:55Z, a new post-boot
protection pass had completed in 1,682 ms without overruns/skipped bands, and
all seven fresh broker readings covered 32 positions with both SL and TP.
Entry configuration and account phases matched preflight. These are routine
passing observations, not a percentile/load or whole-V3 acceptance claim.

## V3 T2 (P0-1b): close recovery from deal history, terminal states, competing exits

25-09-2026. Production effect today: none. `recordedPlans` is 0 (read from
`GET /state/momentum-targets?all=1` at 15:20 UTC), so no partial plan row
exists and every closer below behaves exactly as before. T3 runs the manager
each loop; T4 is the first producer of plans.

### What a close attempt can prove

The gateway answers a close with the first execution event that carries its
request id (`cpp-exec/src/engine.cpp`, `dispatchFrame`). For a market close
that can be `ORDER_ACCEPTED`: an order id and no deal. The `ORDER_FILLED`
that follows is dropped as a late frame. Before T2 the partial manager read
that answer as "no receipt" and stopped at `AMBIGUOUS` for good, which also
blocked the rank exit (V3-SEQUENCE risk 2). T2 reads the position's own deal
history (`DEAL_LIST_BY_POSITION_ID_REQ`, `wsGetPositionDeals`) instead of
guessing.

| Answer to the close | What it proves | Partial manager | Rank exit |
|---|---|---|---|
| `ORDER_FILLED` with the deal | The fill | `RECEIVED`, then `CONFIRMED` once the runner volume is read | `RANK_RECEIVED`, then `RANK_CONFIRMED` on an absence read |
| `ORDER_ACCEPTED` | The broker order id only | Order id stored on the `SENDING` row; the deal is looked up in history | Same, on the `RANK_SENDING` claim |
| Refused before transport (the adapter's credential or attempt check), the gateway's `NOT_CONNECTED` or guard refusal, no connection, an auth-family broker error | Nothing reached execution | `SENDING` → `ARMED` by compare-and-set on `attempted_at`; the attempt is not used up | Back to the plan's prior state; not counted against the bound; the exit stays owed |
| A broker error code (e.g. `MARKET_CLOSED`) | The close did not execute | Terminal `REJECTED` with the code | Back to the prior state, claim `REJECTED`; not counted; the exit stays owed |
| `POSITION_NOT_FOUND` / `alreadyClosed` | This close did not execute | Confirmed by an absence read, then `CLOSED_EXTERNALLY` | Same, `RANK_CLOSED_EXTERNALLY` |
| Timeout, `DISCONNECTED`, `SEND_FAILED`, a 5xx, anything else | Nothing: it may have executed | `AMBIGUOUS` | `RANK_AMBIGUOUS` |

### Matching a deal to an attempt

A closing deal proves an attempt only when all of these hold (`matchClosingDeal`):

- the attempt's own broker order id (stored from `ORDER_ACCEPTED` or
  `ORDER_FILLED`);
- this account (the response envelope), this position and this instrument;
- the opposite side;
- the plan's entry price, compared in ticks at the plan's digits;
- exactly the attempted volume (`volume`, `filledVolume`, `closedVolume`);
- a timestamp no earlier than `attempted_at` minus 2 s of clock skew, and no
  later than now plus 2 s;
- `hasMore` is `false`, and exactly one deal qualifies.

Without an order id nothing is attributed to the attempt. A manual partial of
the same volume, with another order id, is never taken as the receipt.

### NOT_EXECUTED waits out the whole transport

`NOT_EXECUTED` (owner default H-P0-3) needs all of:

- `now − attempted_at` above the transport horizon: the gateway's 20 s close
  wait, the JS fallback's 20 s, and 10 s of grace (50 s);
- a position read taken after that point, showing the full pre-attempt
  volume;
- a complete deal history with no closing deal since the attempt.

It is terminal. Nothing is resent; the runner's broker SL and TP, and the
rank exit, continue. A close that lands late (tested at 35 s) is never
declared `NOT_EXECUTED`.

### Terminal outcomes

| State | Meaning | Evidence kept |
|---|---|---|
| `REJECTED` | The broker refused this partial close | The error code and message |
| `NOT_EXECUTED` | Proven never executed | The read's time and volume, the order id if any, the horizon |
| `CLOSED_EXTERNALLY` | The position is gone | The absence read and the closing deal ids; a receipt already held is kept (`position_closed_after_partial`) |
| `VOLUME_CHANGED` | Another close changed the volume | The volume read and the closing deal ids |

Reasons name what was and was not proven, for example
`volume_changed_attribution_unproven` when a timed-out attempt had no order
id: the volume changed, but the deal cannot be attributed to the attempt.

Recovery, readback and these terminal states only read the broker. They run
even after the reconciler has closed the lifecycle rows. Ownership still
gates every send.

### The rank exit handles every state

- `ARMED`, `CONFIRMED`, `REJECTED`, `NOT_EXECUTED`: a reservation closes the
  full volume (the runner volume after `CONFIRMED`).
- `SENDING`, `AMBIGUOUS`, `RECEIVED` (the partial is unresolved): refused,
  with no competing close. The partial manager resolves them.
- `CLOSED_EXTERNALLY`, `RANK_CLOSED_EXTERNALLY`: nothing to close. The error
  leaves the book row owed until the reconciler closes it. No "rank exit"
  close is journaled for a close the rank exit did not make.
- `VOLUME_CHANGED`, `RANK_VOLUME_CHANGED`: `{ handled: false }`. The plan's
  volumes no longer describe the position, so the caller's own close of the
  broker's volume applies, as it does with no plan.
- `RANK_SENDING`, `RANK_AMBIGUOUS`: resolved from deal history with the
  claim's order id. A rank close proven not executed gets one logged
  re-reservation (principle 3: an owed exit is never left unretried). The
  bound is `RANK_EXIT_MAX_SENDS` = 2 sends that may have reached the broker.
  After the second is proven not executed, the plan is `RANK_NOT_EXECUTED`
  and the exit stops for the owner.

### Competing exits

`agent/services/momentum-exit-coordination.js` reads the plan row for a
position.

| Closer | Refuses while | Why |
|---|---|---|
| Loss cap (`loss-cap.js`) | `SENDING`, `RANK_SENDING` | A request is in flight for seconds. The pass is deferred without stamping the once-per-breach key, so the next pass closes. Once the request has ended, even ambiguously, a full close of the broker's current volume is correct. |
| Profit ratchet flatten (`profit-ratchet.js`) | `SENDING`, `RANK_SENDING` | Same. The skipped position is reported in the notice's failures. |
| `POST /actions/position-close` (close and partial), `POST /actions/position-reverse` | `SENDING`, `AMBIGUOUS`, `RANK_SENDING` | A manual partial while the partial's outcome is unknown could close the same volume twice. Refused (409) before any broker call. |

`POST /actions/close-all` is not guarded. It stays the owner's emergency
flatten. A full close racing a partial cannot double-close: the second request
finds a smaller volume or no position.

### The 24-09 21:05 UTC `KO.US: close failed — MARKET_CLOSED`

Diagnosed from `GET /state/momentum-account` (read 25-09 15:20 UTC).
`lastPass.skipped[0]` reads:

`KO.US: close failed — {"description":"Trading is not available: Market is closed.","errorCode":"MARKET_CLOSED"}`

The pass ran at `2026-09-24T21:05:34Z` on 46130058. The same line appears on
43097342 (17-09 21:18 UTC) and 47790949 (18-09 21:05 UTC).

- The line has no account prefix. That is the format of
  `exitDroppedHoldings` in `agent/services/momentum-account.js`
  (`${row.symbol}: close failed — …`), the daily pass.
- The row-cursor path in `momentum-book.js` writes
  `${accountId} ${symbol}: close failed — …` and checks the broker's hours
  first.
- The daily pass runs after `dailyRunAfterUtc` 21:05. That is after the US
  cash close (20:00 UTC), so a US-listed rank exit on that path is sent into
  a closed market.
- `exitDroppedHoldings` has no hours check. It also does not mark the row
  `exit_pending`, so the owed exit waits for the next daily pass (another
  closed market for US names).

Recorded here; not changed by T2. It is a follow-up and an owner question: an
hours-aware deferral on the daily path changes when live exits are sent.

The same answer is the sidecar's real shape for a definite broker
rejection. T2's classifier and tests use it verbatim.

### Not covered

- An attempt whose closing order fills in several deals: each deal alone is
  inexact, and `exactly one` is not met. The row stays unresolved with
  `order_deals_inexact` for owner review. It is not called `VOLUME_CHANGED`,
  because the order was the attempt's own.
- A timed-out attempt never learns its order id. The gateway journals the
  late frame by `clientMsgId`, which Node does not read here. Such an attempt
  resolves to `NOT_EXECUTED`, `CLOSED_EXTERNALLY` or `VOLUME_CHANGED`, with
  the attribution stated as unproven. It is never `CONFIRMED` on inference.
