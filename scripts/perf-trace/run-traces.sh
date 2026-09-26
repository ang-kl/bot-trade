#!/bin/bash
# Performance traces through the Chrome DevTools MCP (owner mandate 26-09-2026).
# Launches Chromium with a debugging port, checks the certificate Chrome sees,
# runs trace.mjs (medians of RUNS fresh-context traces per page and profile),
# checks the certificate again, and stops Chromium. See README.md.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
CHROME="${CHROME:-/opt/pw-browsers/chromium}"
PORT="${CDP_PORT:-9333}"
TOOLS="${TRACE_TOOLS:-$HERE/.tools}"
if [ ! -f "$TOOLS/node_modules/chrome-devtools-mcp/package.json" ]; then
  mkdir -p "$TOOLS" && (cd "$TOOLS" && [ -f package.json ] || npm init -y >/dev/null)
  PUPPETEER_SKIP_DOWNLOAD=1 npm i --prefix "$TOOLS" --no-audit --no-fund chrome-devtools-mcp@1.10.1 @modelcontextprotocol/sdk >/dev/null || exit 2
fi
UD="$(mktemp -d)"
ARGS=(--headless=new --no-sandbox --disable-gpu --remote-debugging-port="$PORT" --user-data-dir="$UD")
[ -n "${TRACE_PROXY:-}" ] && ARGS+=(--proxy-server="$TRACE_PROXY")
# Trust exactly one extra CA (for example a sandbox egress proxy), by key hash. Never a blanket bypass.
[ -n "${PROXY_CA_SPKI:-}" ] && ARGS+=(--ignore-certificate-errors-spki-list="$PROXY_CA_SPKI")
"$CHROME" "${ARGS[@]}" about:blank >/dev/null 2>&1 &
CPID=$!
trap 'kill $CPID 2>/dev/null; wait $CPID 2>/dev/null; rm -rf "$UD"' EXIT
sleep 3
node "$HERE/certpin.mjs" || { echo "ABORT: certificate check failed before the run"; exit 4; }
TRACE_TOOLS="$TOOLS" node "$HERE/trace.mjs"; rc=$?
node "$HERE/certpin.mjs" || echo "WARNING: certificate check failed after the run"
exit $rc
