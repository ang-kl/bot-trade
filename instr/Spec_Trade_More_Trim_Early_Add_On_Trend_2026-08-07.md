# Spec — trade more · trim earlier on profit · add when trending

Owner, 2026-08-07: *"trade more and shrink lot size earlier if symbol is profit
to take gains earlier if necessary. add if trending."*

Written 2026-08-07 01:05 UTC against `f970eb9`.
**Spec only — no code changed. Every number below is a PROPOSAL for you to
correct, not a decision I have taken.**

---

## Read me first

This is three separate behaviour changes wearing one sentence, and they pull in
different directions. Stated plainly so you can accept or reject them
individually rather than as a bundle:

| # | Your words | What it changes | Direction |
|---|---|---|---|
| **T1** | "trade more" | the entry gate lets more through | more risk taken |
| **T2** | "shrink lot size earlier if symbol is profit" | partial exit at a profit threshold | less risk carried, **lower** average win |
| **T3** | "add if trending" | a second entry on the same symbol while winning | more risk, **higher** variance |

**T2 and T3 are in tension.** Trimming early caps the winner; adding on trend
needs a winner big enough to be worth adding to. Running both without an
ordering rule produces a position that is trimmed, re-added, and trimmed
again — churn that pays spread every time. §4 proposes the ordering.

**And one honest warning.** T2 is exactly the mechanism the Defensive-Drift
audit suspects is already truncating winners — 60% of postmortems classify
`time_cap`, and spike tightening pulls the trail from 2.5 ATR to 1.0 ATR while
a move is running. Phase 7's replay (#680) exists to measure that and **has not
been run** — it needs ~7 days of clean-origin rows, so roughly 13-08.
**Shipping T2 before that runs means changing the exit policy while the
instrument that would tell you whether the exit policy is the problem sits
unused.** My recommendation is to run the replay first; it is your call.

---

## T1 — trade more

**The constraint is not the strategy gates.** Measured: 27 `return veto(...)`
sites in `risk.js`, and the ones that actually fired were not strategy quality:

- `unknown_daily_pnl` — 194 of the last 200 decisions on 06-08. **Fixed in
  #683** (the repair now retries at grace cadence instead of backing off to
  six hours).
- `daily_loss_limit_hit limit=16.16` — 4,717 in seven days. **Fixed in #684**
  (the $200 floor).

**Those two were the whole story.** Before adding any new looseness, let those
land and re-measure — the honest next step for "trade more" is a one-day
`/state/veto-breakdown`, not a threshold change.

**If the rate is still low after that**, the candidates in order of how much
they cost you and how well-evidenced they are:

| Knob | Now | Proposed | Why |
|---|---|---|---|
| `minRR` effective | 4.5–6.16 | **1.5** (the configured value) | The gate is running 3–4× stricter than configured. Nobody chose 6.16; it is drift. This is the single biggest entry unlock and it is a *correction*, not a loosening. |
| `symbolCooldownMinutes` | 5 (override) | 60 (the merged default) | Your live override is *looser* than the code default. Clearing it tightens. Noted for completeness — it does not help "trade more". |
| `maxOpenPositions` | 8 | unchanged | Concurrency is not the binding constraint at a 1.7% approval rate. |

**Recommended T1 action: none yet.** Measure first. The two fixes shipped today
may be the entire answer.

---

## T2 — shrink the lot when the symbol is in profit

**What exists already.** `profit-keeper.js:63` — `scaleOutFrac`, default `0`
(off). When armed it closes that fraction **once** (`:221`, capped at 0.9,
`scaledOut` guard prevents repeats). So the mechanism is built and disabled; T2
is largely a matter of turning it on and deciding the trigger.

**What is missing:** the trigger today is "once the keeper arms", which is an
ATR/balance condition, not a profit level. Your words are *"if symbol is
profit"* — a profit threshold.

### Proposed rule

```
when unrealised >= trimAtR (in R)
 and the position has not already been trimmed
 and remaining volume after the trim >= broker minimum lot
then close trimFrac of the position, and move SL to breakeven
```

| Knob | Proposed | Reasoning — argue with these |
|---|---|---|
| `trimAtR` | **1.0 R** | At 1R the trade has paid for its own risk. Below that a trim banks noise; above it you are into the territory the replay needs to settle. |
| `trimFrac` | **0.5** | Half is the conventional choice and the only one that makes "risk-free runner" exactly true after the breakeven move. |
| `trimOnce` | **true** | Repeated trims are the churn failure above. |
| `moveSlToBreakeven` | **true** | Without it, trimming reduces the win without reducing the risk — the worst of both. |

**Cost, stated honestly:** on trades that would have run to 3R you now collect
~2R. The gain is a higher win rate and a lower variance; the loss is payoff
ratio. **Which of those matters more to your 1.68 profit-factor target is
precisely what the unrun replay would tell you.**

**Guard:** never trim below the broker's minimum lot — a trim that leaves an
unclosable remnant is worse than no trim. `minLotSize` already exists in config.

---

## T3 — add if trending

**Nothing like this exists.** `grep pyramid|addToWinner|scale_in` returns
nothing. This is genuinely new behaviour, and it is the riskiest of the three:
adding to a position converts a winner into a larger position that can round-trip.

### Proposed rule

```
when the position is >= addAtR in profit
 and SL is already at breakeven or better        ← non-negotiable
 and the trend test passes (below)
 and adds so far < maxAdds
 and total symbol exposure after the add <= maxPositionsPerSymbol and the
     cluster/currency caps
then open addFrac × the ORIGINAL size, with the SAME stop as the existing leg
```

| Knob | Proposed | Reasoning |
|---|---|---|
| `addAtR` | **1.5 R** | Above `trimAtR`, deliberately — see §4. |
| `addFrac` | **0.5** | An add the size of the original doubles risk in one step. |
| `maxAdds` | **1** | Start with one. A ladder is a different feature. |
| Trend test | **price > EMA20 > EMA50 on the entry timeframe, and the last 3 bars' closes rising** (inverse for short) | All three indicators already exist in `src/lib/indicators.js` and server-side in the chart path. No new data. |

**The non-negotiable:** the stop must already be at breakeven on the original
leg before any add. Without that, an add turns a 1R winner into a 2R loser on a
reversal — the exact way pyramiding destroys accounts.

**Interaction with the existing caps:** `maxPositionsPerSymbol` currently
defaults to a small number and the duplicate-cluster detector treats same-symbol
positions as suspicious. An add-on leg would look like a duplicate to that
detector. **This must be resolved before T3 ships** — the add needs to be
labelled as an intentional second leg (`origin: 'add_on'`, parent trade id) or
the dedup sweep will close it.

---

## 4. Ordering, so T2 and T3 do not fight

```
0.0R ────── 1.0R ────── 1.5R ────── runner
            trim 50%    add 50% if trending
            SL → BE     same stop
```

- `trimAtR (1.0) < addAtR (1.5)` **always**. Enforce it in config validation:
  an add threshold at or below the trim threshold is rejected, not silently
  reordered.
- After an add, the trim flag stays set — **one trim per position, ever**, not
  one per leg. Otherwise every add re-arms a trim and the churn returns.
- Both off by default. Each ships behind its own flag, log-only first.

---

## 5. What I would do, in order

1. **Nothing on T1** until `/state/veto-breakdown?days=1` is read after #683 and
   #684 are live. Those two fixes may be the whole answer, and a threshold
   change layered on top would make the measurement uninterpretable.
2. **Run Phase 7's replay** (`exit-counterfactual.mjs --days 14`, ~13-08). It has
   a "no profit keeper" arm and a "each component individually" arm — it will
   say whether trimming helps or hurts *on your own bars*.
3. **T2 then**, with numbers the replay supports rather than the ones above.
4. **T3 last**, and only after the add-on-vs-duplicate-detector question is
   settled.

**If you want T2 sooner than the replay**, say so and I will ship it log-only —
computing and recording every trim it *would* have made, changing nothing — so
a week from now you have both the replay and a live shadow record to compare.
That is the version I would be comfortable shipping today.

---

## Owner decisions needed

1. `trimAtR`, `trimFrac` — accept 1.0R / 0.5 or give me yours.
2. `addAtR`, `addFrac`, `maxAdds` — accept 1.5R / 0.5 / 1 or give me yours.
3. Trend definition — accept EMA20/EMA50 + 3 rising closes, or name another.
4. Ship T2 **log-only now**, or **wait for the replay**?
5. T3: is a second same-symbol leg acceptable at all, given the duplicate
   clusters that have already cost you twice (nine 0066.HK, six 0005.HK)?
