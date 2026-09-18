#!/bin/sh
# cpp-verify/entrypoint.sh — make the mounted volume writable, then DROP ROOT.
#
# WHY THIS EXISTS, measured 18-09-2026 03:2x UTC. The volume was attached at
# /data and cpp-verify's /health immediately reported:
#
#   "journal": { "configured": true, "dir": "/data/verdicts",
#                "writable": false, "written": 0,
#                "lastError": "mkdir: Permission denied" }
#
# Railway mounts the volume root-owned. The service runs as `appuser`
# (uid 10001, --no-create-home), so it cannot create its journal directory —
# and every verdict would have gone unrecorded while the service looked
# perfectly healthy. That is the failure the boot-time write check was built
# to expose, and it fired on the first deploy.
#
# The Dockerfile used to say "no entrypoint script: this service holds no
# state". That was true and is no longer: it holds the verdict trail. The
# comment is corrected rather than left to mislead.
#
# THE PROCESS STILL RUNS AS appuser. Root is used for exactly two syscalls —
# mkdir and chown on the journal directory — and then dropped before exec.
# A read-only verifier running as root would trade a recording failure for a
# privilege one, which is a bad exchange.
set -eu

JOURNAL_DIR="${VERIFY_JOURNAL_DIR:-}"

if [ -n "$JOURNAL_DIR" ]; then
  # Failures here are NOT fatal. The journal reports its own writability at
  # boot and on /health, so a service that cannot write its diary still
  # verifies — refusing to start would turn a recording problem into an
  # outage. But it says so.
  if mkdir -p "$JOURNAL_DIR" 2>/dev/null && chown -R 10001:10001 "$JOURNAL_DIR" 2>/dev/null; then
    echo "[entrypoint] journal dir $JOURNAL_DIR prepared and owned by uid 10001" >&2
  else
    echo "[entrypoint] WARNING: could not prepare $JOURNAL_DIR — the journal will report unwritable" >&2
  fi
fi

# setpriv is part of util-linux, which is Essential in Debian, so it is present
# in debian:stable-slim. The guard is here anyway: if it ever is not, running
# as root SILENTLY would be the worst outcome, so that case is loud.
if command -v setpriv >/dev/null 2>&1; then
  exec setpriv --reuid=10001 --regid=10001 --init-groups /usr/local/bin/cpp-verify "$@"
fi

echo "[entrypoint] WARNING: setpriv not found — running as root, which this service does not want" >&2
exec /usr/local/bin/cpp-verify "$@"
