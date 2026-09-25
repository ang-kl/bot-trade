# Codex → Claude Code takeover — 25 September 2026

**Recorded:** 25-09-2026 11:40 SGT (03:40:06 UTC, `date -u`).

## The owner's note (verbatim)

> note: record this date and time that codex runs out of token to build.
> claude code to take over the complete the latest assessment plan.
> the goal of parallel scanners both tick and time should be active now

## What was handed over

| Item | State at takeover |
|---|---|
| `origin/main` | `83c94e6` (#1084, merged 07:36 SGT). Production Node reports the same commit (`/health`, 03:03 UTC). |
| Open PRs | None. |
| Codex's last visible reply | **№ 9,006**, 08:40 SGT. The full test suite was running; native tests were blocked on its Mac, so it needed Linux CI before merging. Nothing was released or activated. |
| Codex's dual-entry build (replies № 8,997–9,006) | **Local only and unpushed.** It is on no remote ref at the 03:40 UTC fetch, so it is **not recoverable** from this session. Every item it reported is rebuilt from `origin/main`; none is assumed to exist. |
| Implementation session | **Claude Code**, from this record onward. One implementation session at a time (`docs/v3-handover-2026-09-24.md`). |

What Codex reported as built locally (unverified, now to be rebuilt):
- one request selecting both entry sources, with a "Time + tick" label;
- the automatic switch keeping the time-based selection;
- the entry basis derived from the registered producer instead of defaulting
  to `'bar'`;
- scanner candidates handed to execution through the existing one-use permit,
  with feed-identity checks against a restart race;
- cpp-verify diagnostics for entry-mode and tick-validation blockages;
- a maximum-drawdown %-of-peak diagnostic.

## The plan being completed

`docs/dual-environment-plan-2026-09-25.md`, the assessment presented as
№ 9,029 (25-09 11:24 SGT). The owner order it serves is 8,991: remove
time-based-only logic, route entries from both C++ scanners to the two
gateways, and give cpp-verify the ability to diagnose tick-based and other
entry refusals. It also serves the side note: tick-based and time-frame-based
trades in parallel, accepted only when tests show a sustainable rise in win
factor and win ratio.

## Unchanged by this takeover

- The tick validation thresholds in `agent/config/tick-validation.json`. These
  are risk limits held by the owner; `tick-validation.test.js` pins them.
- The position caps: `maxOpenPositions` 5 and the book's 8.
- TP1 stays mandatory on every entry (`agent/lib/exec-engine.js`).
- The intraday strategies stay retired (the 20-09 owner order) unless the owner
  says otherwise.
- The merge policy and P7's local scope in `CLAUDE.md`.

## Still waiting on the owner

- **What "active now" means for the parallel scanners.** Observation only
  (feeds on, candidates compared, no orders), or order authority through Node
  admission. It was asked at the takeover.
- **Decisions D1–D7** in the plan: the meaning of "win factor", whether win rate
  is a pass/fail bar, what counts as "sustainable", the veto trade-off, whether
  shadow judges what live would trade, pooled replay, and the gateway redeploy.
- **Carried from Codex:**
  - 8,991·C2;
  - overnight swap in the partial-TP cost reserve;
  - whether the 24-hour browser disconnection counts from inactivity or from
    login;
  - the watchdog recipient.
