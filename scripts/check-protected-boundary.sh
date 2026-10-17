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
# Claude · № 15,001 15-Oct (owner: "#36 research isolation — CI step only when research files change" after № 14,989; claude-builder): the merge base is computed on its own and checked. A shallow clone
# (CI's default fetch-depth 1) has none; the old form sent that error to
# /dev/null and diffed against an empty ref — OK whatever had changed, a guard
# whose trigger never fires (CLAUDE.md failure mode #3).
mb="$(git merge-base "$BASE" HEAD 2>/dev/null)"
if [[ -z "$mb" ]]; then
  echo "protected-boundary: no merge base between $BASE and HEAD (shallow clone? check out with fetch-depth: 0)" >&2
  exit 2
fi
changed="$(git diff --name-only "$mb" -- "${PROTECTED[@]}")"
# Claude · № 15,074 16-Oct (owner on #1381: "Merge on test+review green; add a marker in a
# follow-up"; claude-builder). An owner-authorised change to a protected path
# names that path, one line per path, in the PR body (CI passes it in
# PROTECTED_AUTHORISED) or, locally, in HEAD's commit message:
#   Protected-change-authorised: agent/loop.js (owner, § 15,032·C)
# A differing path that is named is reported as AUTHORISED and does not fail;
# a differing path that is not named still fails. The marker DOCUMENTS the
# authorisation — anyone can write the line — it does not prove who gave it;
# the PR body and the conversation reference it carries are the record.
# Claude · № 15,284 17-Oct (owner: "B: empty PR body", independent audit
# finding B / Codex P1 on #1383; claude-builder). SET-BUT-EMPTY IS NOT UNSET.
# CI always sets the variable — to the PR body, which may be empty — so an
# empty body must authorise nothing; only a local run, where the variable is
# not set at all, reads HEAD's commit message. The old `-z` test treated an
# empty body as absent and fell through to the commit message.
if [[ -n "${PROTECTED_AUTHORISED+set}" ]]; then
  authorised_src="$PROTECTED_AUTHORISED"
else
  authorised_src="$(git log -1 --format=%B HEAD 2>/dev/null)"
fi
authorised="$(printf '%s\n' "$authorised_src" | sed -nE 's/^[[:space:]]*Protected-change-authorised:[[:space:]]*([^[:space:]()]+).*$/\1/p')"
unauthorised=""; allowed=""
while IFS= read -r p; do
  [[ -z "$p" ]] && continue
  if printf '%s\n' "$authorised" | grep -qxF -- "$p"; then allowed+="$p"$'\n'; else unauthorised+="$p"$'\n'; fi
done <<< "$changed"
if [[ -n "$unauthorised" ]]; then
  echo "protected-boundary: FAIL — protected path(s) differ from $BASE:"
  printf '%s' "$unauthorised" | sed 's/^/  /'
  [[ -n "$allowed" ]] && { echo "protected-boundary: authorised by marker (Protected-change-authorised):"; printf '%s' "$allowed" | sed 's/^/  /'; }
  exit 1
fi
note=""; [[ "$missing" -gt 0 ]] && note=", $missing missing in base"
if [[ -n "$allowed" ]]; then
  echo "protected-boundary: OK — protected path(s) differ from $BASE under an owner-authorisation marker:"
  printf '%s' "$allowed" | sed 's/^/  /'
  echo "protected-boundary: every other protected path identical to $BASE (base $(git rev-parse --short "$BASE"))$note"
  exit 0
fi
echo "protected-boundary: OK — ${#PROTECTED[@]} protected path(s) identical to $BASE (base $(git rev-parse --short "$BASE"))$note"
exit 0
