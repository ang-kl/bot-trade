# Tick-momentum breakout — programme record

**Status: PROPOSAL UNDER CONSTRUCTION. Nothing here is approved for trading, and
no tick order can be placed by this repository.** The per-account entry mode
does not exist yet; when it does it defaults to `TIME_BASED` with tick
observation `OFF` (see `agent/lib/entry-contracts.js`, `defaultEngineStatus`).

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
| P0 | Contracts as code (`agent/lib/entry-contracts.js`), the producer inventory pinned by test (`agent/lib/entry-producers.js`), the runtime manifest with unknowns labelled (`agent/services/runtime-manifest.js`, `GET /state/runtime-manifest`), this folder | this change |
| P1 | Entry-mode / admission services, DB migrations, producer closure at the final boundary | planned |
| P2 | Async broker session, durable intent ledger, one-use permits, mode fencing | planned |
| P3 | Normalized tick feed, symbol workers, bounded recorder and archive | planned — needs the volume mapping (B18) |
| P4 | `tick_momentum_breakout`, reference oracle, replayer, trial ledger | planned |
| P5 | Registry, stages, watchlists, horizon, every UI surface, readiness endpoint | planned |
| P6 | Shadow, then demo, each an explicit operator action | planned |
| P7 | Live rollout and rollback rehearsal | planned |

## Owner-held preconditions

- Railway volume mapping for both C++ services (mount path, free bytes, UID) — gates P3 (B18, TM-27).
- Any new recorder service or volume is an infrastructure change and is asked first.
- The authenticated bearer token — gates every preflight read in P0/P7 (TM-37).
- Evidence thresholds, the drawdown budget and position caps are risk limits: ask-first, never lowered to make a setup feasible (plan §12).
