#!/usr/bin/env bash
# scripts/check-protected-boundary.sh — the live trade-management boundary.
#
# Claude · № 13,094 11-Oct (ordered № 13,093; claude-builder). The owner
# approved a measure-first programme (theory-gap readouts, tick-bar research)
# on one condition: the live trade management built 01–10 Oct, the gates and
# the loop are NOT changed by it. This script makes that a check, not a
# promise: it fails when the working branch differs from origin/main on any
# path below. Every research PR pastes its output.
#
# Usage: bash scripts/check-protected-boundary.sh [base-ref]
#   base-ref defaults to origin/main (fetched first when possible).
#   Exit 0: no protected path differs. Exit 1: one or more do (named).
#
# agent/research-isolation.test.js reads the list between the PROTECTED
# markers, so the test and this script cannot drift apart.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
BASE="${1:-origin/main}"

# PROTECTED-BEGIN
PROTECTED=(
  # trade management (agent)
  agent/services/managed-exit.js
  agent/lib/stop-policy.js
  agent/services/stop-policy-controller.js
  agent/services/profit-keeper.js
  agent/services/profit-ratchet.js
  agent/services/mae-chandelier-observe.js
  agent/services/capped-hybrid-policy.js
  agent/services/capped-hybrid-enrolment.js
  agent/services/momentum-partial-broker.js
  agent/services/momentum-partial-manager.js
  agent/services/momentum-partial-ownership.js
  agent/services/momentum-partial-runtime.js
  agent/services/momentum-book.js
  agent/services/hybrid-tick-controller.js
  agent/lib/hybrid-tick-transport.js
  agent/services/manual-hybrid-enrolment.js
  agent/services/manual-hybrid-evidence.js
  agent/services/manual-hybrid-policy.js
  agent/services/native-trail-events.js
  agent/services/keeper-close-receipts.js
  agent/services/general-partial-execution.js
  agent/services/loss-guardian.js
  agent/services/weekend-bank.js
  agent/services/trade-guard.js
  # trade management (cpp-exec)
  cpp-exec/src/trail_engine.cpp
  cpp-exec/src/trail_engine.hpp
  cpp-exec/src/protection_ratchet.hpp
  cpp-exec/src/hybrid_tick.cpp
  cpp-exec/src/hybrid_tick.hpp
  cpp-exec/src/hybrid_feed.cpp
  cpp-exec/src/hybrid_feed.hpp
  cpp-exec/src/tick_firer.cpp
  cpp-exec/src/tick_firer.hpp
  cpp-exec/src/tick_strategy.cpp
  cpp-exec/src/tick_strategy.hpp
  # live gates, the loop, the scanner contract
  agent/services/risk.js
  agent/services/earned-floor.js
  agent/services/regime-gate.js
  agent/services/regime.js
  agent/loop.js
  agent/services/scanner-feed.js
  agent/services/tick-permits.js
  cpp-scan-timeframe/src/scanner.cpp
)
# PROTECTED-END

if [[ "$BASE" == origin/* ]]; then
  git fetch -q origin "${BASE#origin/}" 2>/dev/null || true
fi
if ! git rev-parse --verify -q "$BASE" >/dev/null; then
  echo "protected-boundary: base ref '$BASE' not found" >&2
  exit 2
fi

missing=0
for p in "${PROTECTED[@]}"; do
  if ! git cat-file -e "$BASE:$p" 2>/dev/null; then
    echo "protected-boundary: WARNING $p is not in $BASE (renamed or removed?)" >&2
    missing=$((missing + 1))
  fi
done

# Working tree AND index against the merge base with $BASE: a change that is
# committed, staged or unstaged all count.
changed="$(git diff --name-only "$(git merge-base "$BASE" HEAD)" -- "${PROTECTED[@]}" 2>/dev/null)"
if [[ -n "$changed" ]]; then
  echo "protected-boundary: FAIL — protected path(s) differ from $BASE:"
  echo "$changed" | sed 's/^/  /'
  exit 1
fi
note=""; [[ "$missing" -gt 0 ]] && note=", $missing missing in base"
echo "protected-boundary: OK — ${#PROTECTED[@]} protected path(s) identical to $BASE (base $(git rev-parse --short "$BASE"))$note"
exit 0
