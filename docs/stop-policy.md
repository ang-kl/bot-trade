# Stop-loss policy: Opposite trigger and broker-side trailing

Date: 02-10-2026. Owner order: "Opposite for stop-loss and broker-side trailing."
Decision: broker-side trailing turns on **once the stop locks profit** (stop at or past entry).
Code: `agent/lib/stop-policy.js` (pure), stamped at `agent/lib/exec-engine.js amendPosition`.

## What it asks the broker for

Two fields on the amend that sets a position's stop (`ProtoOAAmendPositionSLTPReq`):

| Field | Value | Meaning |
|---|---|---|
| `stopLossTriggerMethod` | OPPOSITE = 2 (TRADE 1, DOUBLE_TRADE 3, DOUBLE_OPPOSITE 4) | A long's stop fires on the ask, a short's on the bid. It fires up to one spread later than TRADE and rides through spread spikes (the owner's 24-07-2026 concern). |
| `trailingStopLoss` | true | The broker trails the stop server-side and keeps trailing through a bot or sidecar outage. |

The trigger method is on every stop. The trailing flag is sent only when the stop locks profit, the row is not a momentum-book row (the book's own daily 3×ATR trail is its only stop authority), and trailing is `on_lock`. The bot never sends `trailingStopLoss:false`: it does not turn a trailing stop off.

The new-order `stopTriggerMethod` is for pending STOP orders only, so a position's stop trigger can only be set by an amend after the position exists. Entries place MARKET/LIMIT orders with relative SL/TP and amend nothing after fill, so new positions are stamped by the desired-state controller (PR-2).

## Where it is stamped

Every Node amend passes `exec-engine.amendPosition`. Callers say what the stop **means** (`stopContext: {side, entry, book}`); the policy decides the fields. `agent/stop-policy-callsites.test.js` pins that no other production file names the two fields. The sidecar's TrailEngine stamps its own amends from a `stopPolicy` block pushed with `/trail-config` and a per-spec `entryPrice` (it computes the lock rule itself).

## The never-loosen rail

Broker-side trailing moves a stop between the bot's reads, so a decision computed from the stored `current_sl` can be looser than what the broker holds. `executeBrokerAction` MOVE_SL (and the runner leg) therefore send `ratchetOnly` + `expectedDirection`: the sidecar reads the live broker stop, refuses to loosen it, carries the broker's own take profit, and confirms by read-back. The stored `current_sl` becomes the broker's confirmed value. `expectedSymbolId` is deliberately not sent (`symbol_id_map` belongs to the selected account).

## Config and kill switch

`agent_state.stop_policy_json`: `{enabled, triggerMethod, trailing: 'on_lock'|'off', encoding: 'number'|'name'}`. Loaded at boot, before any amend.

```
POST /actions/stop-policy  {"enabled": false}        # no amend carries the fields; takes effect on the next amend
POST /actions/stop-policy  {"trailing": "off"}       # Opposite stays; trailing no longer requested
GET  /state/stop-policy                              # policy, wire value, counts since boot, last 50 amends
```

The TrailEngine picks a change up with the keeper's next `/trail-config` push (within a minute).

## What is NOT verified (each becomes a measurement)

1. `ProtoOAPosition.trailingStopLoss` read-back: Spotware logged a 2021 bug where it read false when enabled. Trailing drift is therefore enforced only when read-back is proven reliable.
2. Whether an amend that omits the two fields preserves or resets them (the docs say so only for `guaranteedStopLoss`).
3. Whether trailing distance anchors to the price at amend time or to entry.
4. Whether `stopLossTriggerMethod` also changes take-profit triggering (docs: "for SL/TP of the position").

If the broker refuses an amend that carries the flags, the stop level still goes through: the sidecar retries once without them, records the refusal and cools down that account and symbol for six hours.

Sources: Spotware Open API `ProtoOAAmendPositionSLTPReq`, `ProtoOAPosition`, `ProtoOAOrderTriggerMethod` (help.ctrader.com/open-api); cTrader protections page (trigger table).

## Existing positions: the desired-state controller (PR-2)

`agent/services/stop-policy-controller.js`, a fast-monitor band job (heartbeat `stop_policy`, 60 s). It sends each open position that has a broker stop one `policyOnly` amend: the sidecar reads the live stop and target itself and re-sends them with the two policy fields, so Node never sends a stale level; when the broker already carries the policy the sidecar answers `unchanged` and sends nothing. The stop LEVEL never moves.

- **Both broker sides.** The band job is handed the selected account's credentials, which reach one host. The controller builds one context per side the way the protection audit does (`runProtectionAuditBothSides`), so every enabled account is covered; a side with no credentials is an error (the heartbeat goes red), never a quiet gap.
- **Canary first, confirmed by a real stamp.** Until one amend has been applied AND read back as confirmed, the pass is sequential and the first real stamp ends its pass. A no-op (the broker already carries the policy) neither confirms the canary, nor holds it, nor uses up its one stamp. A refusal, an error, a disagreeing read-back or one that cannot vouch for it holds the whole controller for 30 minutes.
- Then at most one policy call per account per pass, accounts in parallel. A soft deadline (3.5 s) stops new calls so the band's 5 s budget is not overrun; the rest wait for the next pass.
- A position is not asked again for 6 hours (5 minutes after an error), so an unreliable trailing read-back is "unverifiable", never a re-stamp every minute. The tracked map is bounded (2,000).
- Skips: no broker stop, a row the owner paused, `keeper_opt_out`, no monitored row, policy off. Momentum-book rows are paused BY DESIGN (the book pauses its own rows) and ARE stamped: the trigger method, never the trailing flag. (The first live pass skipped all five …0058 book rows as `paused`; fixed in the follow-up.) Position ids are matched with `normPosId` (either side may carry the float spelling).
- A policyOnly amend has no JS fallback: an amend with neither stop nor target would clear both.
- `GET /state/stop-policy` carries a `controller` block (canary time, hold, tracked positions, last pass).
- Rollback: `POST /actions/stop-policy {"enabled":false}` stops further stamps; it does not revert positions already stamped. `{"triggerMethod":"TRADE"}` makes the controller re-stamp the trigger back (design inference, untested live). The bot never sends `trailingStopLoss:false`, so a trailing flag it set can only be cleared by hand in cTrader.

## A broker-trailed stop is not tampering

The bot records each position it asked the broker to trail (`stop_policy_trailing_json`, loaded at boot). The reconciler adopts a broker stop move quietly (journal event `sl_moved`, source `broker_trailing`; no TAMPER row, no Telegram) only when the position is in that registry, the stop moved the safer way, and it is not looser than the stored stop. Anything else is still a manual change. `broker_sl_initial` is not taken from a trailed position.

## Independent view

`policyView` (independent-protection.js) reads the verifier's rows: stops carrying the policy's trigger method, differing, unknown (not reported), trailing. DRIFT is narrow: a position the controller confirmed more than 10 minutes ago that now reads a different trigger method; it flips that account's independent reading to unverified. Unstamped or unreported positions are counted, never alarmed. The trailing flag is shown, never judged.

## Integrated tests and the live grader (PR-3)

| What | Where |
|---|---|
| A stateful sidecar + broker model: an amend that replaces protection, server-side trailing, a refusable policy, the four unknowns as switches (`omittedFlags`, `trailingAnchor`, `trailingReadback`, `refuseFlags`) | `agent/test-support/stop-broker-model.js` |
| Sequences through the real executor, exec-engine, controller and trailing registry, run under both answers to each unknown: ladder, broker trailing ahead of a stale decision, a seeded random walk (the stop never loosens, stays Opposite, keeps its target), controller stamping, a refused policy and its cooldown, the kill switch | `agent/stop-loss-integrated.test.js` |
| MAE / Chandelier through the real fast monitor and slow pass to the broker model: the stop tightens at the broker, Opposite, target kept, receipt confirmed with the policy outcome, `GET /state/mae-chandelier` counts agree | `agent/services/stop-loss-chandelier-integrated.test.js` |
| One set of wire literals shared with the C++ test: the C++ test must still contain them, Node stamps the same fields, the model answers the same policy block | `agent/test-support/fixtures/stop-policy-golden.json`, `agent/lib/stop-policy-golden.test.js` |
| Live, read-only grader over `/state/stop-policy`, `/state/mae-chandelier`, `/state/heartbeats`; verdicts PASS, FAIL, NOT VERIFIABLE; `--baseline file` compares take-profit levels across runs | `agent/lib/stop-loss-grader.js`, `scripts/verify-stop-loss-integrated.mjs` |

The model is a copy of the CONTRACT pinned by `cpp-exec/src/tests/test_protection_ratchet.cpp`, not of the C++ code, and the four unknowns are inventions until measured live: the integrated tests prove Node's behaviour under either answer, not which answer the broker gives. The grader reports what the broker reads back and says NOT VERIFIABLE where the evidence has not arrived (no Chandelier amend yet, no baseline). The C++ side needed no new test binary: PR-1 already pins the ratchet, the policy-only amend, the refusal fallback and the TrailEngine stamping in `test_protection_ratchet.cpp` and `test_trail_engine.cpp`.
