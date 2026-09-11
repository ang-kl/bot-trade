# Tick-momentum breakout — programme record

**Status: PROPOSAL UNDER CONSTRUCTION. Nothing here is approved for trading, and
no tick order can be placed by this repository.** The per-account entry mode
exists since P1b (#879) and defaults to `TIME_BASED` with tick observation
`OFF` (see `agent/lib/entry-contracts.js`, `defaultEngineStatus`);
`TICK_MOMENTUM` is refused until the strategy (P4) and its evidence (P6) exist.

## What is in this folder

| File | Author | What it is |
|---|---|---|
| `plan.md` | Codex, 10-09-2026 | The implementation and verification plan (sections 1–17). Its companion links point at the author's machine; the companions are the files below. |
| `cpp-parallelism-investigation.md` | Codex, 10-09-2026 | The C++ concurrency / Railway / cTrader investigation the plan builds on. Two defects reproduced (VPO re-arm, telemetry loss). |
| `readiness-register.csv` | Codex, 10-09-2026 | The 42 requirements TM-01…TM-42. **Every row was PLANNED when filed.** Status changes are made by pull requests that cite the evidence, never by editing the row alone. |
| `storage-capacity.csv` | Codex, 10-09-2026 | Six storage scenarios, all `SCENARIO_NOT_MEASURED`. The 20 symbols × 100 events/s × 96 B case is 16.6 GB/day. |
| `research-profile.json` | Codex, 10-09-2026 | The research parameter envelope. Its own first line: `RESEARCH_PLAN_ONLY_NOT_DEPLOYABLE_CONFIG`. |

## Measured gap at filing (11-09-2026)

A separate Codex artefact (an install script) described the engine as
"implemented with local tests" and cited fifteen source files. None of those
files existed on `main` or any branch of this repository when checked
(10-09-2026 20:20 SGT). The register above is the honest one: all PLANNED.

## Phase map and what is done

The programme adopts the plan's own phases (§14). Each phase lands as one or
more pull requests under the repository's merge gate, with the register row
updated in the same change.

| Phase | Content | State |
|---|---|---|
| P1a | The four sidecar defects from the investigation (telemetry producer lock, VPO pending-fire skip + CAS transitions + fire snapshot, send-boundary halt recheck, 9 s heartbeat) and the audit wording | **merged #877, 11-09-2026** |
| P0 | Contracts as code (`agent/lib/entry-contracts.js`), the producer inventory pinned by test (`agent/lib/entry-producers.js`), the runtime manifest with unknowns labelled (`agent/services/runtime-manifest.js`, `GET /state/runtime-manifest`), this folder | **merged #878, 11-09-2026** |
| P1b | Entry-mode service (`agent/services/entry-mode.js`), `admitEntry` at every Node producer and re-checked in `exec-engine.placeOrder`, the VPO arming fence, `POST /actions/entry-mode`, `GET /state/entry-engines`; register TM-06/TM-16 IMPLEMENTED, TM-10/TM-11/TM-39 PARTIAL | **merged #879, 11-09-2026** |
| P1c | Drain of the account's resting entry orders by stored broker id on a switch to STOPPED (`agent/services/entry-drain.js`): QUIESCING → RECONCILING → STABLE on a post-cancel broker snapshot, run once from the route and every loop cycle until settled; register TM-14 IMPLEMENTED (Node side) | **merged #880, 11-09-2026** |
| P2a-1 | The durable entry-intent ledger with one-use permits on every Node-placed order (`agent/services/entry-ledger.js`, `exec-engine.placeOrder`), the sidecar's epoch-fenced permit check at its send boundary (`order_guard.cpp validatePermit`, ring details naming the intent), the guard sync pushing entry epochs, the VPO disarm push on STOPPED, `GET /state/entry-intents`, `POST /actions/entry-intents/:id/resolve`; register TM-13 IMPLEMENTED (Node side), TM-17 PARTIAL, TM-10 evidence updated | **merged #881, 11-09-2026** |
| P2a-2 | The VPO tier's pre-issued permits: one per armed strategy and side with each push, bound to the sized volume and the epoch, refreshed by the next push, released on disarm (`reserveVpoPermits`), attached by the sidecar on every fire, the `permit_waived` path removed; register TM-10 / TM-11 IMPLEMENTED | **merged #882, 11-09-2026** |
| P2b-1 | The execution-event journal (`event_journal.*`, `POST /events`, `cpp_events`) so a late frame or an unsolicited fill settles an UNKNOWN intent by clientMsgId or label tag, and the request pacer against cTrader's documented 50/s per connection with a reserved protection share (`request_pacer.*`, `/health pacer`); register TM-24 PARTIAL, TM-25 IMPLEMENTED | **merged #882, 11-09-2026** |
| P2b-2 | The async broker session: a reader thread per connection, every request a future keyed by its clientMsgId and awaited outside the execution mutex, late frames journaled under their id, a disconnect failing every request in flight, the heartbeat from the reader (`engine.*`, `ws_client.*` reader/writer split with the OpenSSL I/O lock and a plain loopback transport for tests); the scripted fake broker (`cpp-exec/src/tests/fake_broker.hpp`) and `test_async_session.cpp`, run under ThreadSanitizer in CI (`make tsan`); `/health session`; register TM-24 IMPLEMENTED | **merged #883, 11-09-2026** |
| P3a | The bounded tick recorder on the sidecar (`cpp-exec/src/tick_recorder.*`): every raw spot event as a versioned, checksummed 40-byte record with side presence, change, snapshot, crossed and repeat flags; 64 MiB segments sealed by fsync + atomic rename; a 2 GiB spool cap retiring the oldest sealed segment; a free-space reserve (the larger of 2 GiB and 20% of the mount) that pauses recording with a gap on disk; one writer per spool; torn tails quarantined; `GET /tick-status` with statvfs; `/health tick`. OFF twice over: the recorder exists only when the sidecar is started with `TICK_SPOOL_PATH` (a Railway variable, ask-first, NOT set by this change), and writes only when an account on its side has tick observation `RECORD` (`POST /actions/tick-observation`), pushed by the exec guard sync as `tickRecord`; `POST /actions/tick-symbols` names the symbols to carry; `GET /state/tick-recorder`; the heartbeat logs the recorder's state and the mount's free bytes. Register TM-02 / TM-23 / TM-28 / TM-31 IMPLEMENTED, TM-21 / TM-27 PARTIAL | **merged #883, 11-09-2026** |
| P3b | Recording switched on for the first account from the repo (`agent/config/tick-observation.json`, seeded once per content: ACCT-DEMO-3 `RECORD`, the momentum universe as the symbols to carry; `TICK_SPOOL_PATH=/data/tick` set on cpp-exec by the owner's word 11-09 11:15 SGT); symbol workers with fixed shards and per-symbol ordering (`cpp-exec/src/tick_workers.*`, `TICK_WORKERS`, default 2; TM-22 / TM-23 IMPLEMENTED); the replayer over sealed segments (`agent/lib/tick-segment.js`, `scripts/tick-replay.mjs`, format pinned to the C++ header by test); hourly `tick_status_samples` and the measured 24 h events/sec and bytes/day in `GET /state/tick-recorder` against `storage-capacity.csv`. Not built: the archive (TM-29) — needs a Railway bucket, ask-first | this change |
| P4 | `tick_momentum_breakout`, reference oracle, replayer, trial ledger | planned |
| P5 | Registry, stages, watchlists, horizon, every UI surface, readiness endpoint | planned |
| P6 | Shadow, then demo, each an explicit operator action | planned |
| P7 | Live rollout and rollback rehearsal | planned |

## Owner-held preconditions

- Railway volume mapping for both C++ services (mount path, free bytes, UID) — gates P3 (B18, TM-27). Measured 11-09-2026: cpp-exec (demo) has a 50 GB volume at `/data`, unused; cpp-acct (live) has none. Setting `TICK_SPOOL_PATH` (e.g. `/data/tick`) on cpp-exec is the owner's call; the recorder reports the mount's free bytes and UID problems itself once set.
- Any new recorder service or volume is an infrastructure change and is asked first.
- The authenticated bearer token — gates every preflight read in P0/P7 (TM-37).
- Evidence thresholds, the drawdown budget and position caps are risk limits: ask-first, never lowered to make a setup feasible (plan §12).
