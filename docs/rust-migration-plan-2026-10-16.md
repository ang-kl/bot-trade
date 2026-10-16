# Rust migration plan — recorded, not ordered (16 October 2026)

**Owner decision, 16-10-2026 20:4x SGT: "Not now, record the plan, continue the profit work."** This document
records the plan so it can be picked up later without re-deriving it. Nothing in it is scheduled. Conversation
ref: ordered after № 15,252 (owner); plan presented at № 15,251; assessment "is it worth it?" answered at № 15,252.
Claude · № 15,253 16-Oct (claude-builder).

## 0. The question and the answer

The owner asked whether the Python and the C++ should move to Rust "as a better robust language". The answer given
and accepted: **not now**. Rust gives memory and thread safety by construction; the native tier already carries
ThreadSanitizer gates and about sixty test binaries, and no incident in October 2026 traced to a memory or race
fault — the recorded causes were protocol semantics (trail pushes, snapshot time, ratchet identity), which a port
carries across unchanged unless the contract is frozen first. The trading deficit of the period (bot's own stream
−14.8R over 14 days, № 15,226) is in strategy selection and exits, not in the language.

It becomes worth doing when one of these holds:
1. a reproduced crash or data race in a sidecar that the C++ tests cannot pin;
2. a new native component is to be written from scratch (write it in Rust then; no port needed);
3. the research plan's steps show a positive expectancy worth protecting with a rewrite.

## 1. Inventory (origin/main, 16-10-2026)

| component | source lines | test files | role | money at risk |
|---|---|---|---|---|
| `cpp-exec` (two Railway services: demo and live gateway) | 13,451 | 46 (+ TSan binaries) | cTrader WebSocket client (JSON over WSS, no protobuf), order/amend/close/cancel, positions, ratchet amends, TrailEngine, tick recorder and firer, VPO strategies, backtest, HTTP server with 19 routes | yes |
| `cpp-verify` | 3,878 | 9 | independent watchdog, incident record, `/watchdog-status` | no |
| `cpp-scan-timeframe` | 2,338 | 4 | native bar scanner; a Node parity harness exists (`scanner-comparison.js`, `test_reference.cpp`) | no (signals only; Node dispatches) |
| `cpp-scan-tick` | 1,988 | 3 | native tick scanner, profile-registry consumer | no |
| Python | 612 (two offline scripts) | 0 | `scripts/handover-md2html.py`, `docs/analysis/gtd-statement-baseline-2026-10-04.py` | none; not in the runtime |

Build and gates today: `g++` in `debian:stable-slim` with OpenSSL and libcurl; hand-rolled JSON (`json.hpp`),
WebSocket client and HTTP server; `make test`, `make tsan`, the CI build-test job. Nothing in the app, CI or deploy
calls Python.

## 2. Python disposition (no Rust)

- `scripts/handover-md2html.py`: replace with a small Node script using the repository's existing Markdown tooling,
  or delete once the handover it renders is archived. Not a Rust target: offline, rare, no latency or safety stake.
- `docs/analysis/gtd-statement-baseline-2026-10-04.py`: keep its result as a doc; the script is archived.

## 3. Phases (each a separate PR series; HTTP/JSON contracts byte-identical; no trading-policy change; no protected Node file)

**Phase 0 — contract freeze and parity harness (prerequisite for everything).**
`rust/` Cargo workspace; shared crates `bt-proto` (serde types for every sidecar request and response, generated
from the current JSON shapes), `bt-http` (axum), `bt-ws` (tokio-tungstenite + rustls). Golden fixtures recorded
from the CURRENT C++ binaries on production-shaped inputs (the scanner comparison already does this for the
timeframe scanner; extend to the verifier and the tick scanner). A black-box parity runner replays each fixture
against both binaries and diffs the JSON. CI job `rust`: `cargo build`, `cargo test`, `clippy -D warnings`, `fmt`.
Railway: Dockerfile with the `rust:1-slim` builder and the `debian:stable-slim` runtime, same ports and env.

**Phase 1 — `cpp-scan-timeframe` → `bt-scan-timeframe`** (smallest risk, best harness). Gate: parity diff empty on
seven days of recorded inputs; a shadow service on Railway beside the C++ one; Node's comparison route reads both
for a week; cut over on zero diffs; keep the C++ service stopped, not deleted, for a month.

**Phase 2 — `cpp-verify` → `bt-verify`** (watchdog, no orders). Same shadow pattern; `/watchdog-status` parity; the
incident record migrated by replay.

**Phase 3 — `cpp-scan-tick` → `bt-scan-tick`** (tick profiles; registry contract unchanged).

**Phase 4 — `cpp-exec` → `bt-exec`** (the gateway), in sub-phases: 4a read-only routes (`/health /positions
/events /decisions /depth /tick-status /trail-status /vpo-status`) in Rust with parity against the C++ on the demo
side; 4b the WebSocket session and reconcile; 4c order/amend/close/cancel with the ratchet contract (`ratchetOnly`,
direction and symbol identity) and the TrailEngine, demo side only, dual-run with the Node reconciler comparing
broker state; 4d the live side only after the demo side shows two weeks of identical journals. Every existing C++
test is re-expressed in Rust before its sub-phase cuts over.

**Phase 5 — retire the C++** after one month of Rust-only operation per service; update `docs/architecture`, the
runtime manifest and the producer inventory.

## 4. Effort (working sessions, not calendar promises)

Phases 0+1 about 4–6; phase 2 about 3; phase 3 about 3; phase 4 about 12–20 plus the shadow weeks; phase 5 one.
Each phase ends with the full local gate and Codex review under the standing rule, so the token cost scales with it.

## 5. Grounding rule for every phase PR

Expected outcomes come from the recorded C++ outputs (golden fixtures) and the broker's own responses (deal and
position reads), never from the Rust port's own design. Population: the sidecar's whole HTTP surface and WebSocket
message set. Live check: parity diff counts on the production shadow, reported Passed / Failed / Not Verifiable.
