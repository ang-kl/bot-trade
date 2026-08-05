> Frozen SHA `0e6465158337c40d70952334b685551c7afdd289` · generated 2026-08-05 UTC · READ-ONLY, no live action.
> Narrative and verdicts live in [`instr/Result_Bot-Trade_Algorithmic_Decision_Integrity_Audit_2026-08-06.md`]( ../../instr/Result_Bot-Trade_Algorithmic_Decision_Integrity_Audit_2026-08-06.md ). This tree is the evidence pack.

# 09 — Trade management and profit retention

## Writer inventory — executed

Sixteen Node modules can amend or close a position:

`lib/exec-engine.js` · `loop.js` · `routes/actions.js` · `services/acting-layer.js` ·
`broker-history-import.js` · `loss-cap.js` · `loss-guardian.js` · `pnl-backfill.js` ·
`position-protect.js` · `profit-keeper.js` · `profit-ratchet.js` · `restrategize.js` ·
`tp-suggest.js` · `trade-consistency.js` · `trade-guard.js` · `weekend-bank.js`

Plus the C++ side: `engine.cpp`, `trail_engine.cpp`, `order_guard.cpp`.
Machine-readable: `machine/writer-authority.csv`.

## Arbitration — H08 disproved

`acting-layer.js` enforces two invariants with mechanism rather than convention:

1. **Single-flight per layer.** A module-level `Map` so a guardian tick arriving
   mid-pass joins the pass in flight instead of starting a second one. Cleaned in
   `finally` on both paths, so a throwing pass cannot lock the layer out permanently.
2. **Ledger AND broker agreement.** `scopeToAccount` refuses to act unless the row's
   stamped account does not contradict the pass *and* the broker's own reconcile lists
   the position. The broker gate is required, not optional.

The file records that both invariants were previously assumed and both were false.

## The unarbitrated pair — provisional

**Node and C++ are not under a shared lock.** The C++ TrailEngine ratchets on ticks;
Node's profit keeper ratchets on its own clock. Both only ever *tighten*, which bounds
the damage — but "both only tighten" is a property of the current code, not an
enforced invariant, and nothing would catch a future writer that widens.

## BLOCKED — DATA UNAVAILABLE

Every measurement in §12: MAE, MFE, realised R, MFE capture ratio, giveback from peak,
time to break-even, time to first ratchet, ratchet lag from threshold to broker ack,
amendments per position, partial-profit and runner contribution, time-cap
contribution, % closed inside 0.1R/0.25R/0.5R, % reaching broker SL/TP, and profit
factor before vs after management costs.

And all nine §12 exit counterfactuals (broker-bracket-only, no-early-breakeven,
no-time-cap, no-scale-out, wider runner, management matched to timeframe, …).

**H14 — defensive drift and winner truncation — is therefore `blocked`, not
disproved.** It is the hypothesis most likely to be true and least testable from here.
