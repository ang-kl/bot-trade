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
