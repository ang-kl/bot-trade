# V3 intraday restoration - 2026-09-28, version 1

## Owner order and scope

The owner approved restoring `scan_dispatch` and intraday trade settings on all seven accounts, including live accounts, after CI and review. The same instruction requires scanning, analysis and trading on, and prohibits automated scan-off changes without human approval.

The 20 September intraday retirement is superseded for the ordinary `scan_dispatch` path. The separate `closed_market_limits`, `pending_fib_orders`, burn-in and C++ direct order paths remain retired. The two private C++ scanner market-data feeds remain outside this release. Existing account, market-session, stage, entry-mode, risk, position-protection and broker admission gates remain in force.

## Implementation

- Restore `scan_dispatch` to the automatic producer roster.
- Add the 12 intraday strategies to the global seed-once order and the enabled-account pins. `_reseed_all` gives existing accounts a new, one-time owner order without hardcoded account IDs. A later guard or human disarm survives subsequent boots.
- Reject automated and raw `scan_enabled=false` writes globally and per account. The authenticated owner UI and human Telegram commands remain able to pause scanning and use the emergency stop with an audited actor.
- Make family goal rows reflect the current producer retirement state rather than permanently describing the intraday families as retired.

The historical 19 September sample was weak or inconclusive for most intraday strategies. For example, the earlier 90-day record included `vwap_trend` PF 0.70 over 30 closes and `fib_confluence` PF 2.72 over 26 closes. The restoration is an owner decision, not evidence of positive expectancy.

## Release sequence and verification

1. Full local gate: `node --test agent/**/*.test.js`, `npx eslint .`, `npx vitest run`, `npm run build`, `npm run check:no-green`.
2. Draft PR, exact-head CI, diff and review. Hold the merge on any red check or material review finding.
3. Before merge, read back the account phases and health. The 28 September production Accounts page showed five accounts with Scan/Analyze/Autotrade on, live `43002148` with all three off (`manage_only`), and live `43069009` with Scan and Analyze off but Autotrade on. After the release, use the owner UI to turn those account phases on under this approval. Confirm all seven account phases and the 12 trade cells by readback.
4. Confirm the Node deployment commit and health, scan cadence, analysis and decision rows, then observe actual orders or risk-gate refusals at an open market session. A configured phase is not evidence of a broker fill.

## Rollback

The human emergency stop remains available. If the restoration causes unsafe orders, the owner can pause the phases from the authenticated UI or Telegram. A code rollback must not reissue the spent one-time seed token. Any later change to risk limits, credentials, market-data feed status or direct C++ entry requires separate approval.
