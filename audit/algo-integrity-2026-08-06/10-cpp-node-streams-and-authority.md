> Frozen SHA `0e6465158337c40d70952334b685551c7afdd289` · generated 2026-08-05 UTC · READ-ONLY, no live action.
> Narrative and verdicts live in [`instr/Result_Bot-Trade_Algorithmic_Decision_Integrity_Audit_2026-08-06.md`]( ../../instr/Result_Bot-Trade_Algorithmic_Decision_Integrity_Audit_2026-08-06.md ). This tree is the evidence pack.

# 10 — C++ / Node streams and authority

## Executed

`make -C cpp-exec CXX=g++ test` → exit 0 (306s). `backtest-parity.mjs` → exit 0.

Structural facts read from source at this SHA:

- **One `ExecEngine`, one `host_`, for the process lifetime.** `main.cpp:144` creates
  exactly one; `setCredentials` (`engine.cpp:106-115`) *replaces* `host_` and tears the
  session down. Live and demo accounts cannot share one process. This is the root of
  F-CONN-01.
- **Monotonic `clientMsgId`** so each response is matched to its own request — pairing
  by `payloadType` alone previously returned buffered execution events as the current
  call's success (audit #1).
- **`requestedAccountIds_` vs `accountIds_`** kept separate so a transient auth failure
  on one account is retried on reconnect rather than silently shrinking the roster.
- **`authErrorAction`** is a pure, free-standing rule so an auth-family error can be
  charged to the account instead of killing the session — the fix for the 2026-08-04
  incident where one unauthorised account caused a reconnect roughly once a second.

## The health-endpoint problem — §13, explicitly

> "A health endpoint is not proof of useful work. Demonstrate a recent successful
> broker session, authorised account, fresh tick, completed request and reconciled
> state."

**This could not be demonstrated.** `exec-parity.js` exited 1 before reaching the
sidecar. No broker session, authorised account, fresh tick or reconciled state is
evidenced by this audit. That is the honest state, and it is the reason F-CONN-01's
C++ half rests on reading `engine.cpp` rather than running it.

## BLOCKED

Locks and thread ownership under load, queue ordering, timeout behaviour, reconnect
storms, stale ticks, memory/lifetime safety under fault injection, telemetry drops,
deployment restart isolation, and repeated/ambiguous submits. Also the §13 semantic
parity list beyond what `make test` covers.
