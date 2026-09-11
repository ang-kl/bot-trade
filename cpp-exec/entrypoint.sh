#!/bin/sh
# cpp-exec/entrypoint.sh — P3b (11-09-2026). Railway mounts a volume
# root-owned; the sidecar runs as the unprivileged appuser (uid 10001), so
# its first start with TICK_SPOOL_PATH=/data/tick logged "mkdir /data/tick
# failed: Permission denied" and the recorder stayed off. This runs as root
# only long enough to create and hand over the spool (and the telemetry
# file's directory when TELEMETRY_PATH is set), then drops to appuser for
# the process itself — the binary never runs as root.
set -e
prepare() {
  dir="$1"
  [ -n "$dir" ] || return 0
  if mkdir -p "$dir" 2>/dev/null && chown appuser "$dir" 2>/dev/null; then
    echo "[entrypoint] $dir prepared for appuser"
  else
    echo "[entrypoint] cannot prepare $dir (the recorder will report why)"
  fi
}
prepare "$TICK_SPOOL_PATH"
[ -n "$TELEMETRY_PATH" ] && prepare "$(dirname "$TELEMETRY_PATH")"
exec runuser -u appuser -- /usr/local/bin/cpp-exec "$@"
