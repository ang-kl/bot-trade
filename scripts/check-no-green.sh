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
#
# `public/vendor` is excluded too (18-09-2026): it holds third-party files
# copied verbatim from node_modules (GSAP, self-hosted so a hanging CDN
# cannot blank the site). A minified library's colour-name table is data the
# app never paints with; the rule is about what THIS UI draws, and the same
# files were already exempt while they lived under node_modules.
#
# TWO GREPS, NOT ONE. Hex colours are case-insensitive to CSS, so the first
# pass runs with -i: until 02-09-2026 `#22C55E` would have walked straight
# past a list that only knew `#22c55e`. Class and word tokens stay
# case-sensitive in the second pass, so prose like "Green" in a comment is
# not a violation while `bg-green-500` still is.
#
# `#14b8a6` and `teal` were added the same day: TradeCockpit painted the
# EMA-9 line teal for a month, outside every token here. Blue-green is the
# one hue family the owner cannot tell from green, so it is banned by name
# and by value, not left to a reviewer's eye.
HEX_MATCHES="$(grep -RInEi \
  --include='*.js' --include='*.jsx' --include='*.css' --include='*.html' \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=vendor \
  -e '#10b981' -e '#22c55e' -e '#16a34a' -e '#15803d' -e '#14b8a6' \
  "$ROOT" || true)"
WORD_MATCHES="$(grep -RInE \
  --include='*.js' --include='*.jsx' --include='*.css' --include='*.html' \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=vendor \
  -e 'bg-green' -e 'text-green' -e 'border-green' -e 'from-green' -e 'to-green' \
  -e '\bemerald\b' -e '\bgreen-[0-9]' -e '\bteal\b' \
  "$ROOT" || true)"
MATCHES="$(printf '%s\n%s' "$HEX_MATCHES" "$WORD_MATCHES" | sed '/^$/d')"

if [ -n "$MATCHES" ]; then
  echo "FAIL: green colour tokens found in bot-trade/" >&2
  echo "$MATCHES" >&2
  echo "" >&2
  echo "The owner is red/green colour-blind." >&2
  echo "Use blue #2563eb for up/long/positive and red #dc2626 for down/short/negative." >&2
  exit 1
fi

echo "OK: no green colour tokens in bot-trade/"
