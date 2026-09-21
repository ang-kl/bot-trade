# Option 2 — turning tick observation on for the live broker side

**Status: EXECUTED 21-09-2026, runtime verified at 15:07 UTC / 23:07 SGT.**

The owner subsequently instructed continuation including live tick activation.
After fresh live protection and zero in-flight/unknown intent checks,
`TICK_SPOOL_PATH=/data/tick` was set on cpp-acct. Deployment
`bf6a03db-1a21-48bd-a8ea-eee4ea97b2b9` succeeded on `394fa78`.
Both services now show recording and shadow ON in Controllers, zero tick
entry accounts and all seven accounts TIME_BASED. The live feed timestamp
advanced to 15:06:53 UTC and its first simulated close was collected at
15:06:58 UTC. The funded live position remained protected after restart.
No persistent volume was added. Full observations and unresolved TP issues:
[`railway-log-review-2026-09-21.md`](../railway-log-review-2026-09-21.md).

The original preparation and expected outcomes below are retained as the
rollout record; predicted capacity and readiness are not fresh measurements.

Written 21-09-2026 for §1 of the approved Option 2 + Priorities 1–6 plan. The
decision it serves: *make every sidecar tick-capable so tick trading can be
switched on the moment a profile passes the evidence bar — without arming
anything.* Option 1 (two broker sessions per process) is deferred unless
measured failures justify it.

---

## 1. What is actually being changed

**One Railway variable:** `TICK_SPOOL_PATH=/data/tick` on **cpp-acct**
(service `a370f641-1e1b-4893-83af-e5eb1e8ffb3c`, environment
`7bc0dfc6-82c5-406c-a621-fd3ff549674d`).

Nothing else. No volume, no paid provisioning, no code deploy, no account-mode
change, no threshold change.

**Why that one variable is the whole job.** `TICK_SPOOL_PATH` is the
construction gate for the *entire* tick block on a sidecar, not merely its disk
writer — recorder, symbol workers, strategy, shadow books, firer and
`/tick-status` are all built inside `if (tickRecorder)`
(`cpp-exec/src/main.cpp:191-265`, `:764`). Unset, the sidecar answers
`{"enabled": false, "reason": "TICK_SPOOL_PATH not set"}` and a `tickShadow`
push is silently dropped (`:1361`).

**Why no volume.** `TickRecorder::start()` needs only a creatable directory and
an exclusive `flock` (`tick_recorder.cpp:311-363`). The shadow reads the **raw
feed tap**, not the spool file (`tick_tap.cpp:17-21`), and a full spool stops
`writeRecord` alone (`:587-600`). A volume may be required before **arming** — not before shadow — because
`disk_reserve_clear` is a `PAUSE_CHECK` (`tick-permits.js:51`) that withholds
live tick permits. "May": if the container filesystem happens to satisfy the
reserve the check clears without one, which §2 below allows for. The honest
rule is that the reserve must clear, not that a volume must exist.

**Why `/data/tick` works with no volume.** `cpp-exec/entrypoint.sh:13` runs
`mkdir -p "$dir"` and `chown appuser` **as root** (called for the spool at `:19`) before dropping
privileges. cpp-acct runs the same image and root directory. (The C++ itself
uses a single-level `::mkdir`, so without the entrypoint a multi-level path
would fail — the entrypoint is what makes this safe.)

---

## 2. What is expected to happen — stated in advance, so a surprise is visible

The recorder's limits are **compiled in and not tunable** (`tick_recorder.hpp:172-185`):
spool cap 2 GiB, `reserveMinBytes` **2 GiB**, `reservePct` 20, segments 64 MiB.
`main.cpp:194-199` overrides none of them.

A Railway container filesystem is small. So the most likely steady state is:

| reading | expected value |
|---|---|
| `/tick-status` `enabled` | `true` |
| `/tick-status` `state` | **`PAUSED_RESERVE`** (the reserve cannot be met) |
| `recorder_recording` | false |
| `disk_reserve_clear` | false |
| `shadow_strategy_running` | **true** — the shadow runs off the raw tap |
| `shadowReady` on …3489 / …2148 / …9009 | **true** (predicted, not yet observed) |
| `ready` on every account | **false** — `profile_pinned`, `replay_evidence`, `validation_stage` |
| `entry.places` | **false** |
| `entry.accounts` | **0** |

**`PAUSED_RESERVE` here is the fail-safe working, not a fault.** If the recorder
instead reports `RECORDING`, that is also fine and simply means the container fs
had room.

**Shadow-ready is not trade-ready.** `shadowReady` gates nothing
(`tick-readiness.js` view note); only `ready` gates promotion
(`entry-mode.js:188`, `:291`), and `ready` cannot become true without evidence
that does not exist.

### Capacity — PRODUCTION READINGS (not verifiable from the repo)

Every figure in this block was read from `/state/tick-recorder` on cpp-exec over
24 h (53 symbols) on 21-09-2026. They are measurements of the running system,
not facts about the source tree, and a reader checking this document against the
repo alone cannot confirm them:

- **12.353 events/s → 42.7 MB/day**, `dropped 0`, `gaps 0`
- 2 GiB cap ⇒ **≈1,207 h (50 days)** of retention
- workers 2, `consumed == dispatched`, **queue depth 0** — no backlog

The live side carries 3 accounts and fewer monitored symbols, so its rate will
be at or below this. `storage-capacity.csv` gives 0.83 / 3.3 / 16.6 GB/day — **20–400× above what
this recorder actually writes**. That file is not wrong: every row is stamped
`SCENARIO_NOT_MEASURED` and assumes 20 symbols at 5/20/100 events/s. It is a
scenario table, and the measured figure above is what to plan against.

---

## 3. Conflicting state that exists TODAY, before any change

Reported here rather than discovered during rollout:

`agent/config/tick-observation.json` already declares `_all: SHADOW`, and the
runtime record for **all three live accounts already reads `tickObservation:
SHADOW`**. That is a declaration the live sidecar cannot act on, because it
builds no tick block.

So this rollout **does not change any account's observation setting**. It makes
an existing declaration effective. That distinction belongs in the approval
decision.

**Do not roll out by editing `tick-observation.json`.** Its `_all` key
re-applies to *every* enabled account on any content-hash change
(`entry-mode.js:544-551`), overwriting operator switches elsewhere. If an
observation change is ever wanted, use `POST /actions/tick-observation` per
account.

---

## 4. Risk

Setting the variable **restarts the live sidecar**. Consequences, all understood
and none silent:

- the broker feed drops; `fast-monitor` falls back to broker prices (designed
  behaviour, `fast-monitor.js:330-340`)
- `trail_engine` in-memory state resets; **broker-side SL/TP are untouched and
  hold**
- an in-flight order resolves to `UNKNOWN` via `expireStale` — which is correct,
  and an `UNKNOWN` intent blocks that account's mode changes until resolved

**Do it with the live book flat, or at a session boundary.** Confirm
`/state/entry-intents` shows zero `UNKNOWN` **before and after**.

---

## 5. Read-back after the change — all read-only

1. `GET /tick-status` on cpp-acct → `enabled: true`; record `state` and `spoolDir`
2. `entry.places: false`, `entry.accounts: 0`, `permitsHeld: 0`, `sent: 0`
3. `GET /state/tick-readiness` → `ready: false` on **all seven**;
   `shadowReady: true` on the three live ids; `recorderDestination` names the
   path and state
4. `GET /state/entry-engines` → `effectiveEntryMode: TIME_BASED`,
   `admittedBases: null`, `entryModePolicy: manual` on all seven — unchanged
5. `GET /state/entry-intents` → zero `UNKNOWN`
6. `GET /state/tick-shadow` → a `cpp_exec` (live) side begins reporting; it will
   have no closed trades for some time, and **zero is the honest first reading**
7. the live book's open positions still priced and protected by the fast monitor

## 6. Rollback

**Unset `TICK_SPOOL_PATH` on cpp-acct.** On the next restart the entire tick
block ceases to be constructed and the sidecar returns to exactly today's
behaviour. One step, no data loss, no migration. The readiness reporting added
in this PR is inert without it.

---

## 7. What this does NOT do

- it does not arm any account for tick entries
- it does not change any account's mode, `admittedBases`, or policy
- it does not change any validation threshold
- it does not change the momentum trial
- it does not provision paid storage

Each of those is a separate decision with its own approval.
