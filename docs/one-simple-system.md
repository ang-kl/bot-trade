# One Simple System — the simplification spec

Owner-ordered 2026-08-28: treat the 44-trade exit counterfactual (stable across
three daily reads) as primary evidence and draft this spec now, with the
forward sample continuing as validation rather than gatekeeper.

Everything in this document is either MEASURED (dated, reproducible from the
endpoints named) or explicitly marked NOT VERIFIABLE YET. Nothing here is a
taste judgement.

## P1 — Recommendation

Run the demo accounts on exactly one exit rule, one sizing rule and three
gates. Everything else the exit/management stack currently does is either
replaced by the trail or demoted to "retire after measuring", never deleted
blind.

- **One exit**: `trail_1R` — the entry's own SL and TP stand; once favourable
  excursion exceeds +1R, the stop trails 1R behind the peak and only ever
  tightens. Broker-side stop, always.
- **One size**: the flat per-trade risk percentage. No overlays that can raise
  base and cap together (the measured decoration case: a 3.5% cap sitting
  above a 3% target reduces nothing).
- **Three gates**: (1) exec guard — halt kill-switch + max order volume;
  (2) exposure — per-symbol and portfolio caps; (3) arming — live/demo
  disarm (env-disarm and the account registry).

## P2 — Evidence

Source: `GET /state/exit-counterfactual?excludeStrategy=burnin&account=all`
(30d window, clean-origin trades only, ambiguous/truncated replays excluded
from every rate — the service reports `usable` as the denominator).

Stability across four reads:

| read (SGT)      | eligible | actual PF | trail_1R PF | trail_1R expectancy |
|-----------------|---------:|----------:|------------:|--------------------:|
| baseline № 6,983 |      39 |      0.44 |        1.82 |              +0.38R |
| 26-08 day 1     |      42 |     0.572 |        1.82 |              +0.38R |
| 27-08 day 2     |      43 |     0.563 |        1.82 |              +0.38R |
| 28-08 day 3     |      44 |     0.552 |        1.82 |              +0.38R |

Full rule table at the 28-08 read (n=44):

| rule          | PF    | expectancy | win rate | note                        |
|---------------|------:|-----------:|---------:|-----------------------------|
| **trail_1R**  | **1.82** | **+0.380R** | 50.0% | 36/44 usable (8 truncated)  |
| cap_30m       | 1.67  |    +0.191R |    45.5% | closes winners early        |
| cap_120m      | 1.58  |    +0.202R |    53.5% |                             |
| tp_1R         | 1.25  |    +0.111R |    55.6% |                             |
| be_at_1R      | 1.02  |    +0.007R |    17.1% | ~breakeven — not worth code |
| as_traded     | 0.66  |    −0.265R |    18.2% | what the stack does today   |

The message has not moved in three days: every managed exit beats as-traded,
and the 1R trail beats every cap, target and breakeven variant tried.

## P3 — The rule, precisely

Semantics inherited verbatim from `agent/lib/exit-replay.js` (`trailR: 1.0`),
which is what the evidence was scored on — the live rule must match it or the
evidence stops applying:

1. Entry, SL and TP are the trade's own; the rule adds nothing at entry.
2. Track peak favourable excursion in R (bar extreme, the only excursion a bar
   can prove).
3. While peak ≤ +1R: original stop stands.
4. Once peak > +1R: stop = entry ± (peak − 1R)·risk. Monotone — the stop only
   tightens, never loosens.
5. Exit is whichever the broker hits first: stop, trailed stop, or the
   original TP.
6. Stops live at the broker, and amends round to the symbol's digits (the
   MOVE_SL INVALID_REQUEST rejection was fixed 27-08, #779, and verified
   moving a live stop in production).

## P4 — What the trail replaces

| current mechanism                            | measured verdict                    | action |
|----------------------------------------------|-------------------------------------|--------|
| time caps (30m / 120m / per-timeframe)       | PF 1.58–1.67 < trail 1.82           | replace |
| fixed bank targets (e.g. bank_target_5R)     | subsumed — TP stands under trail    | replace |
| breakeven move at +1R                        | PF 1.02 ≈ nothing                   | replace |
| profit-keeper spike/structure/arm knobs      | the $3.53 noise-floor class of bug  | replace |
| partial exits / early trim                   | not in evidence; adds paths         | replace |

"Replace" means the trail is the only active managed exit; the replaced code
paths are disabled by configuration, not deleted, until the forward sample
(§P6) confirms.

## P5 — What this spec does NOT change, and why

- **Entries.** No exit counterfactual can rank entry signals. Unchanged.
- **The 3R expectancy floor** currently vetoes at measured rates like 2,270
  vetoes per 1 approval per day (production pipeline read, 27-08). Under a
  trail exit, "R:R to TP1" is no longer the trade's expectancy, so the floor
  is answering a question the system no longer asks. Re-derivation needed —
  NOT VERIFIABLE YET; until then it stays as-is rather than being guessed at.
- **Suspect gates** (lesson_tuner SL widening ×1.3, ratchet soft/halt overlap
  with the stage matrix): each must first answer "what input makes this fire,
  and has that input ever arrived" (repo failure mode #3) before retirement.
  NOT VERIFIABLE YET — measurement tasks, not deletions.
- **Live accounts.** Nothing here touches live. The forward test has touched
  zero live positions since it began (verified daily).

## P5a — Entry-floor re-derivation (PR-C), owner-ordered 31-08

The "re-derivation needed" item above is now delivered, in the staged form
the owner approved ("go PR-C", 31-08, after the disarm leak was closed in
\#789 so the measurement starts clean):

- **Mechanism** (`agent/services/earned-floor.js`): a proposal below the 3R
  floor is admitted only when its strategy's OWN rolling win rate (last 30
  closes, minimum sample 15) yields E = W×rr − (1−W) > 0.15R at the proposed
  ratio, and the ratio still clears the strategy's declared minimum (1.5, or
  its own override). This is the dynamic expectancy test the HARD_MIN_RR
  comment has always named as the honest fix — earned by measurement, never
  by declaration.
- **Stage 1 limits**: demo accounts only (registry-checked, fail-closed on
  unknown accounts) and HALF the per-trade risk budget. Live scope is a
  separate decision, taken only after the checkpoint below.
- **Pre-registered verdict**, fixed before the first admitted trade: after
  **30 closed trades** of the admitted cohort (lineage:
  trades.risk_event_id → risk_events rows stamped `earned_floor`),
  **PF ≥ 1.5 keeps the gate**; under it, `earned_floor_json.on=false` and the
  blanket floor resumes. Read it at `GET /state/earned-floor` — the
  checkpoint is a number, not a promise.
- **Honest caveat, restated from the outcome answer (№ 7,079)**: the 44-trade
  trail evidence measured trades that PASSED the old gate; this admits trades
  that FAILED it. +0.387R/trade does not transfer by assumption — that is
  exactly what the 30-close cohort exists to measure.

## P6 — Validation, continuing

The forward sample keeps accumulating (~5 gated closes since 25-08; slow
because most positions exit at their broker SL/TP before any gate binds —
itself evidence that ONE broker-side rule is the right shape). Daily check
continues; revisit this spec's verdict at 30–50 forward closes. Known
limitations, stated rather than hidden: 8/44 trail replays truncated by the
stored bar window; intrabar stop+target bars excluded as unknowable; all
evidence is demo-account, post-probe-era.

## P7 — Costs note

Probe-era statements (26-08) measured commission drag of −1,287.79 and
−1,136.17 per period on the two heaviest demo accounts — micro-lot churn is
not free. The simple system inherits the existing minimum-size floor and adds
no new micro-trading path.
