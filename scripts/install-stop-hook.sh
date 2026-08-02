#!/bin/bash
#
# Copy the repo's corrected stop hook over ~/.claude/stop-hook-git-check.sh.
#
# Run from .claude/settings.json on SessionStart. Idempotent: byte-identical
# target is left alone, so a resumed session does no work and says nothing.
#
# Silent on success by design — a SessionStart hook that prints on every start
# is its own kind of noise. It only speaks when it replaces a differing file
# (so the replacement is visible in the transcript) or when it cannot.
set -u

# Consume the hook's stdin JSON; nothing here needs it, but leaving the pipe
# unread can hand the caller an EPIPE.
cat >/dev/null 2>&1 || true

src="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/stop-hook-git-check.sh"
dst="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/stop-hook-git-check.sh"

if [[ ! -f "$src" ]]; then
  echo "{\"systemMessage\": \"stop-hook installer: source missing at $src\"}"
  exit 0
fi

if [[ -f "$dst" ]] && cmp -s "$src" "$dst"; then
  exit 0
fi

mkdir -p "$(dirname "$dst")" 2>/dev/null
if cp "$src" "$dst" 2>/dev/null && chmod +x "$dst" 2>/dev/null; then
  echo '{"systemMessage": "Installed the repo copy of stop-hook-git-check.sh over ~/.claude/ (the stock one flags pushed, signed commits as Unverified)."}'
else
  echo "{\"systemMessage\": \"stop-hook installer: could not write $dst\"}"
fi
exit 0
