#!/usr/bin/env bash
# Accessibility CI gate — user is red/green colour-blind.
# Fails if any source file mentions green colour tokens.
# Allowed up tokens: blue #2563eb. Allowed down tokens: red #dc2626.
#
# Phase 8 wires this into CI; we seed it in Phase 1 so every later phase
# is forced to keep the rule.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Search every js / jsx / css / html file under bot-trade.
# Excludes node_modules / dist and the script itself.
MATCHES="$(grep -RInE \
  --include='*.js' --include='*.jsx' --include='*.css' --include='*.html' \
  --exclude-dir=node_modules --exclude-dir=dist \
  -e '#10b981' -e '#22c55e' -e '#16a34a' -e '#15803d' \
  -e 'bg-green' -e 'text-green' -e 'border-green' -e 'from-green' -e 'to-green' \
  -e '\bemerald\b' -e '\bgreen-[0-9]' \
  "$ROOT" || true)"

if [ -n "$MATCHES" ]; then
  echo "FAIL: green colour tokens found in bot-trade/" >&2
  echo "$MATCHES" >&2
  echo "" >&2
  echo "Per HANDOVER-V2.md the user is red/green colour-blind." >&2
  echo "Use blue #2563eb for up/long/positive and red #dc2626 for down/short/negative." >&2
  exit 1
fi

echo "OK: no green colour tokens in bot-trade/"
