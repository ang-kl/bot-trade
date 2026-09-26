# Performance traces through the Chrome DevTools MCP

This is the owner's mandate of 26-09-2026: every website PR is traced before and after it merges. The baseline, how to read the results, and the proposed rule are in `docs/plan-ui-and-strategy-review-2026-09-26.md` §13.

## What it does

- `run-traces.sh` does four things in order:
  1. starts Chromium with a debugging port;
  2. checks the TLS certificate Chrome receives (`certpin.mjs`);
  3. runs `trace.mjs`;
  4. checks the certificate again and stops Chromium.
- `trace.mjs` drives the official **chrome-devtools-mcp** server over MCP stdio. It uses:
  - `performance_start_trace`, `performance_stop_trace` and `performance_analyze_insight`;
  - `list_network_requests`, `list_console_messages` and `evaluate_script`;
  - `emulate`, `resize_page`, and `new_page` with an isolated context.
- Each page is traced `RUNS` times (default 3), each time in a fresh browser context, on each profile:
  - **desktop:** 1440×900;
  - **phone:** 390×844, CPU 4× slower, Fast 4G.
- `out/summary.md` gives the median LCP, CLS, element count, table rows and data calls for each page and profile. One trace per run is saved as `.json.gz`, with its insights, network and console in a matching `.txt`.

## Rules it keeps

- **Read-only key only (`AGENT_SECRET_READ`).** That key cannot authorise any non-GET request (`agent/lib/auth-tiers.js`). The key is scrubbed from every saved response.
- **One known exception:** the page's presence ping (`GET /state/client-ping`) registers the tab while it is open.
- **Privacy:** CrUX lookups and usage statistics are off, and network headers are redacted.
- **Certificates:** no blanket certificate bypass. If an egress proxy terminates TLS, pass its CA's SPKI hash in `PROXY_CA_SPKI`; exactly that CA is then trusted. `certpin.mjs` stops the run before any key is sent if the certificate differs from `CERT_EXPECT_*`.

## Run

```sh
# plain network
AGENT_SECRET_READ=… scripts/perf-trace/run-traces.sh

# behind the Claude Code sandbox egress proxy
AGENT_SECRET_READ=… TRACE_PROXY=http://127.0.0.1:41843 \
  PROXY_CA_SPKI='<sha256 SPKI of the proxy CA>' \
  CERT_EXPECT_SUBJECT=sg-trade.up.railway.app CERT_EXPECT_ISSUER='CCR Upstream Proxy CA (staging)' \
  PAGES=/performance,/reasons RUNS=3 TRACE_OUT=/tmp/perf-out scripts/perf-trace/run-traces.sh
```

The DevTools MCP packages are installed into `scripts/perf-trace/.tools/` on first use. That directory is ignored by git and is not part of `package.json`.

## Reading the numbers

- **LCP** is the time until the largest content is drawn. Good is ≤ 2.5 s.
- **CLS** is how much the layout jumps while loading. Good is ≤ 0.1.
- Run-to-run noise is large: about ±0.15 CLS, and seconds of LCP on the phone profile. So only medians are compared.
- Absolute times behind a proxy are not a user's device. Before and after on the same harness is the comparison that counts.
