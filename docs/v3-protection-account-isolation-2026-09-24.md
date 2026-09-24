# V3 continuation: account-safe protection and remaining acceptance

24 September 2026. Starting main: `0d127431b597b28386d1eca42a79ba60ead359bf`
(#1068). This implements a demonstrated P2/P4 defect while the P3 target policy
remains unresolved. It does not establish full V3 acceptance.

## Reproduced defect and correction

`protectPosition` used a bare broker position ID for its local lookup and update.
Two synthetic accounts sharing that ID reproduced an update to both accounts
and an event attributed to the wrong account. A second fixture reproduced
arbitrary updates to two active same-account lifecycle rows.

cTrader's [position model](https://help.ctrader.com/open-api/model-messages/#protooaposition)
explicitly permits position-ID collisions across brokers, and the
[amendment request](https://help.ctrader.com/open-api/messages/#protooaamendpositionsltpreq)
requires both account and position identifiers. The regression models that
documented identity boundary; it is not a claim of a new production collision.

The HTTP path could also fall back to the selected account for an unknown
explicit account; the Telegram TP button contained no account and used primary
credentials. These are all paths into the same protection operation.

The correction:

- Resolve protection credentials only from an explicit registered account or
  one unambiguous recorded owner. Unknown, conflicting and unscoped identities
  cannot fall back to the selected account. Other manual operations are outside
  this change.
- Carry account identity in newly generated TP buttons. Legacy buttons require
  unambiguous ownership, including retained closed history so an old button
  cannot be retargeted to another account. Invalid identities produce no button;
  account IDs are never truncated to fit Telegram's 64-byte callback limit.
- After broker I/O, update only one active monitored lifecycle whose trade and
  monitor both name that account. Ambiguous/missing/conflicting attribution
  leaves local records unchanged and returns `ledgerUpdated: false` with a
  reason. Explicitly scoped broker protection does not depend on the existence
  of a local trade row.
- Refuse a resolved `alreadyClosed`, `rawError`, `error` or `ok: false` broker
  response instead of reporting success and recording protection that failed.
- Retain live missing-leg reads, the existing amendment payload and stop/target
  preservation. No target price, risk threshold, ownership setting, entry mode,
  strategy permission or numerical configuration is changed.

Tests use temporary SQLite and injected broker/Telegram transports. No message,
broker amendment, order or position close is performed by these tests. This
manual handler's successful response is broker request acceptance; independent
protection evidence remains necessary, and it is not a measured amendment
latency guarantee.

## P3 owner decision: momentum TP1

The current `buildEntrySynth` in `agent/services/momentum-book.js` explicitly
produces `tp1: null` and `tp2: null`. Both momentum entry paths reuse it. The
shared execution guard rejects missing TP1. `book-entry-write.js` preserves
broker TP but pauses the ordinary position keeper; therefore merely writing a
partial-TP number would not establish an active partial-exit manager.

| Choice | Concrete implementation | Required policy values and consequence |
|---|---|---|
| A. Whole-position broker TP1 | Generate a finite direction-aware target in `buildEntrySynth`, using an approved target rule, validated prices and the existing risk/entry checks. Preserve it through book ownership and stop updates. | Supply the target rule (for example an explicitly chosen R or ATR multiple). Reaching the broker target closes the remaining position, limiting the open-ended runner design. |
| B. Partial TP1 plus runner | Define the partial trigger and fraction; give the book one restart-safe partial-exit owner; reconcile partial fills and remaining volume; specify the remainder's broker SL and target. Preserve all account/position and risk limits. | Supply trigger rule, fraction, minimum-lot handling, and the runner's broker-target/terminal-exit rule. Explicitly define how the mandatory TP1 requirement applies after the partial. An application-only trigger does not by itself satisfy the current mandatory broker-target guard. |

Neither choice is implemented or enabled by this brief. No profitability claim
is made for either. The selection and numerical target rule are owner policy,
not a missing implementation default. There is no proposed TP1 exemption.

The existing ETHUSD/XRPUSD TP exceptions require separate, fresh position-level
evidence and exact replacement-target or exit decisions. A policy for future
entries does not retrospectively authorise amending existing positions.

## Refreshed acceptance inventory

Railway at approximately 19:53 SGT still reported #1068's Node deployment
`3e2fef06-7844-406a-8175-b8a666c8f4f8` successful and the same five successful
native deployments. Broker receipts stamped 11:53:28.139Z–11:53:29.551Z cover
seven accounts and 33 positions: all have SL; two lack TP1. These are fresh
aggregate receipts, not fresh position-specific quote or target evidence.

| Work | This continuation | Remaining evidence or decision |
|---|---|---|
| P0 protection exceptions | Refreshed broker aggregate coverage | Fresh detailed reads plus exact owner target/exit choices; no invented prices |
| P2/P4 protection account isolation | Reproduced and corrected in this package | Full source gate, release, authenticated readback; no artificial live amend for a test |
| P3 momentum policy | Concrete options above | Owner choice and target parameters, then implementation and offline validation |
| P4 protection performance | Existing book read-start/read-duration/confirmation fields identified | Representative natural broker-confirmed amendments and agreed latency limits; HTTP request time is not protection latency |
| P5a watchdog | Deployment/configuration refreshed; verifier retains its volume; Node exposes HTTP probe traffic | Authenticated backlog/owner/calendar contents, independent recipient/host provisioning and bounded delivery/outage acceptance |
| P5c scanners | Existing correction and frozen parity evidence retained | Exact runtime profile inventory, separately scoped observation feed trial, measured representative load and continuous comparison drain |
| P6/P7 research/configuration | No promotion or threshold changes | Attributable current replay/shadow data and exact profile hashes; retain eligible 48-hour evidence |
| P8/storage/roster | Railway still shows no cpp-acct volume | Intended roster, retention/persistence decision, and measured staged capacity acceptance |
| Final end-to-end | Not run | Prerequisites above, exact frozen scope and natural eligible event; no forced signal or order |

The authenticated browser could not initialise (`codex app-server exited before
returning initialize`). Railway logs/configuration do not supply the existing
authenticated endpoint response bodies. HTTP 200 probe logs are not evidence of
outbox contents, calendar coverage, account settings or statistical eligibility.
No duplicate reporting endpoint or credential extraction is added to bypass
that access limitation.

## Release scope and rollback

This package changes Node source and tests only; the checked native watch
patterns do not match it. Node tracks main without a watch filter, so merging
also restarts production Node. Current successful Node rollback reference:
`3e2fef06-7844-406a-8175-b8a666c8f4f8`. Rollback restores the known account-routing
and attribution limitations; it cannot undo a broker action or repair historical
records. No historical-money migration is included.

Before a release: full repository checks and PR review, fresh independent
coverage and confirmed release scope. After release: verify only Node changed,
broker reads/management resumed, and the read-only UI/API remains account scoped.
Do not trigger a financial operation solely to exercise a button. Any actual
position correction remains a separate owner action.

Related controlling records: [revision 3](performance-cards-reassessment-2026-09-22-revision-3.md),
[completion checkpoint](v3-completion-checkpoint-2026-09-24.md),
[bounded watchdog proposal](v3-watchdog-production-drill-proposal-2026-09-23.md),
and [scanner operator contract](v3-scanner-operator-2026-09-23.md).
