# cpp-verify — the independent position verifier

The keeper writes a closed-position record. This service re-fetches the same
position's deals **from cTrader directly** and says whether the record matches.
It exists so that nothing certifies its own work: `cpp-exec` places the orders
and `agent/` writes the history, so neither of them may be the thing that
declares that history correct.

## What it is, structurally

The binary links its own verifier code and vendored read-only transport:

| File | Why |
|---|---|
| `src/verify_session.cpp` | app auth, account auth, trader, deal list and open-position reconcile |
| `src/protection_watch.cpp` | an independent clock for open-position SL/TP checks |
| `src/verdict.cpp` | closed-position comparison against broker deals |
| `src/journal.cpp` | the verifier's own verdict journal |
| `src/main.cpp` | HTTP routes and separate history/protection sessions |
| `src/{ws_client,http_server}.cpp` | vendored transport, pinned to cpp-exec by tests |

`cpp-exec/src/engine.cpp` is **not** in that list, and that is the whole
guarantee: there is no code path from an HTTP request to an order because the
code is not in the process. `make all && nm -C bin/cpp-verify | grep -i
placeOrder` returns nothing, and it is meant to stay that way — a future
change that links the engine breaks the only claim this service makes.

## Routes

| Route | Auth | Does |
|---|---|---|
| `GET /health` | public (Railway's probe sends no headers) | sessions per host, whether `CTRADER_HOST` was set and ignored |
| `POST /connect` | bearer `EXEC_SECRET` | `{host, clientId, clientSecret, accessToken, accountId, accountIds[]}` — opens or refreshes the session **for that host** and authorizes each account |
| `GET /protection-status` | bearer `EXEC_SECRET` | latest independent open-position readings, account identities, errors and broker-check timestamps |
| `POST /verify` | bearer `EXEC_SECRET` | `{host, accountId, fromMs, toMs, record{…}}` → a verdict |

### Open-position protection

`POST /connect` accepts `purpose: "protection"` to create a separate read-only
session for that host. It cannot replace the history session. The verifier
reconciles those accounts on its own thread, then waits 60 seconds after each
pass. The Node relay provisions every registered account and polls results
without supplying expected SL/TP values. Controllers marks missing, failed,
future-dated or older-than-three-minute results unverified. The verifier only
reports broker protection; it never changes an order or chooses an exit price.
A Node outage stops the UI relay but does not stop this broker-check thread.

### One verifier, both environments

`cpp-exec` and `cpp-acct` each pin one broker host through `CTRADER_HOST` and
hold a single session. The owner's requirement (17-09-2026) is **one** verifier
covering demo *and* live, so sessions live in a map keyed by host and the host
arrives per request. `CTRADER_HOST` must therefore be **unset** on this
service; if it is set it is ignored, and `/health` reports
`hostPinIgnored: true` rather than letting a silently-ignored variable sit
there looking effective.

## The verdict

Four states, and the difference between them is the point:

- `verified` — every field the keeper recorded agrees with the broker.
- `disputed` — at least one field disagrees. The reply **names the field** and
  carries both readings (the 26.9% P&L episode: "the data is corrupt" was the
  wrong diagnosis, `entry_price` was the disagreeing field and `net_pnl` was
  sound on all 276 matched pairs).
- `absent` — the broker reports no deal for that position in the window. Not a
  dispute.
- `unverified` — we could not judge: the fetch was incomplete, the position is
  still open, or the opening deal falls outside the window.

A **partial fetch can never produce `verified` — and never produces `disputed`
either.** A gap in our reading is our gap, not evidence against the keeper; a
verifier that judges on a truncated read manufactures findings.

An **absent keeper field is a dispute**, not a zero. The record is required to
be completely filled, and `double = 0` cannot tell "recorded nothing" from
"recorded zero" — the same shape as `Number(null) === 0`, which has cost this
project three separate defects.

Broker figures are **copied, never recomputed**: net P&L is the sum of the
broker's own `grossProfit + swap` over the closing deals plus `commission` on
every deal including the opening one, not a number derived from the price move.

## Paging

`ProtoOADealListReq` has no cursor token: a page is bounded by timestamps and
`hasMore` says another exists. The walk carries the cursor **to** the last
execution timestamp rather than past it, so nothing sharing that millisecond
is skipped, and drops the resulting overlap by `dealId` — skipping is
invisible, duplicates are not. If `hasMore` stays set while the window does
not advance, the fetch stops and reports **incomplete**; it neither spins nor
returns a partial set dressed as whole.

This is pinned by `test_deal_paging.cpp` because the keeper's own importer
(`agent/lib/broker-history-import.js`) sends `maxRows: 500` and never reads
`hasMore`, while `agent/services/entry-ledger.js:550` in the same repository
pages correctly. The verifier must not inherit the first shape.

## Build and test

```
make all     # bin/cpp-verify
make test    # test_verdict, test_deal_paging (loopback fake broker, no network)
```

Both build from the repository root's perspective: the Makefile reaches into
`../cpp-exec/src` for the transport, and the Dockerfile's build context is the
repository root for the same reason.

## Railway service configuration (owner-side)

| Setting | Value | Why |
|---|---|---|
| Root directory | `/` | the build needs `cpp-exec/src` |
| Dockerfile path | `cpp-verify/Dockerfile` | |
| Builder | `DOCKERFILE` | not RAILPACK |
| Healthcheck path | `/health` | |
| `CTRADER_HOST` | **unset** | a host pin makes one-verifier-for-both impossible |
| `EXEC_SECRET` | same bearer as the other sidecars | the service refuses to start without it |
| `PORT` | `8080` (default) | |

`EXEC_URL`, `EXEC_URL_DEMO`, `EXEC_URL_LIVE` and `TRAIL_TICK_ENABLED` are inert
on this service — it calls nothing and trails nothing.

Private address: `cpp-verify.railway.internal:8080`.
