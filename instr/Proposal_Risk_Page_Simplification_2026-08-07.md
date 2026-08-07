# Proposal — make the Risk page less complicated

Owner, 2026-08-07: *"propose to make risk page less complicated"*.

Written 2026-08-07 01:00 UTC against `src/pages/Risk.jsx` at `3adc017`.
**Proposal only — no code changed.**

---

## What the page actually is today

| | |
|---|---|
| Lines | 1,270 |
| Editable fields | **54** |
| Save buttons | 3 (account risk · trade risk · per-trade risk) |

Fifty-four numbers, nearly all rendered at the same visual weight, each with a
hint and a recommendation. Nothing is *wrong* with any individual field — the
hints are good and the recommendations are honest. The difficulty is structural,
and it is worth naming precisely before proposing anything.

## Why it is hard to use — three distinct causes

**1. Every knob has equal billing.** `perTradeRiskPct` decides how much money
each trade risks. `minTradesForKelly` decides when one veto starts applying.
They sit in the same kind of box at the same size. There is no way to tell,
from the page, which three fields matter and which forty are refinements you
will set once and never touch.

**2. The interactions are invisible.** Several fields only make sense together,
and the rule is in the source rather than the screen:

- `dailyLossPct` and `dailyLossLimit` combine by **MIN** — the tighter wins.
- `dailyLossFloorUsd` (new today) is applied **after** that min — a floor, the
  opposite direction — and while the tier rule is on, `dailyLossLimit` stops
  applying altogether.
- `perTradeRiskPct` and `perTradeRiskUsd`; `maxRiskCapPct` and `maxRiskUsd` —
  same pattern, two units for one idea.
- `dailyLossPctMax` silently does nothing unless it exceeds `dailyLossPct`.

A reader cannot answer *"what is my daily cap right now, and which field set
it?"* without knowing all four rules. **This is the real complexity**, and it is
not solved by hiding fields.

**3. Effective ≠ configured, and the page mostly shows configured.** The audit
found `minRR` running at 4.5–6.16 against a configured 1.5. A page that shows
1.5 while the gate uses 6.16 is not a settings page; it is a wish list.

---

## The proposal — four changes, in order of payoff

### A. Lead with the answer, not the inputs

At the top of each group, one line stating **the number in force and which
field produced it**:

```
Daily loss cap        $200 today          ← floor (3% of 1,983 = 59.49 was lower)
Per-trade risk        $19.84              ← 1% of 1,983
Min R:R               6.16                ← effective, NOT the configured 1.5
Max open positions    3 of 8 used
```

Everything needed for this already exists: the gate writes `daily_cap_binding`,
`daily_cap_floor_usd`, `daily_cap_pct_usd`, `daily_cap_flat_usd` onto every
verdict, and the page already receives `data.dailyPacing`. **This is assembly of
served facts, not new computation** — and it answers the question the page is
actually opened to answer.

### B. Three tiers of exposure, not one flat list

| Tier | Contents | Default state |
|---|---|---|
| **Everyday** (~6 fields) | per-trade risk %, daily loss cap, max open positions, min R:R, equity stop, blocked symbols | open |
| **Shaping** (~15) | position/symbol caps, cooldowns, cluster and currency exposure, SL distance, spread cap | collapsed |
| **Machinery** (~33) | Kelly sample size, derisk ladder, pacing ceiling, tier boundaries, margin floors, news/carry/commission/slippage gates | collapsed, behind "Advanced" |

Same 54 fields, same anchors, same save buttons — nothing is removed, because
removing a knob someone relies on is worse than showing too many. What changes
is that opening the page shows **six** decisions instead of fifty-four.

### C. Collapse the paired units into one control

`perTradeRiskPct` + `perTradeRiskUsd` become one field with a **% / $ toggle**,
writing whichever key the toggle selects and clearing the other. Same for
`maxRiskCapPct` / `maxRiskUsd`, and `dailyLossPct` / `dailyLossLimit`.

That is **six fields down to three**, and — more importantly — it makes the
"which one wins" question impossible to ask, because only one can be set.

*Caveat, and it is a real one:* today both can be set simultaneously and the
tighter binds. Collapsing them is a **behaviour change** for any account
currently relying on both. Needs a migration read of what is actually set per
account before it ships, and it is the one item here I would not do blind.

### D. Show the blast radius before saving

Each group's Save already exists. Add a one-line diff on click:

```
Daily loss cap: $200 → $400.  At today's balance that is
2 more losing trades before the desk stops. Save?
```

The Risk page is the highest-consequence surface in the app and currently the
only one where a mistyped digit applies silently.

---

## What I would NOT do

- **Delete fields.** Every one of the 54 is read by the gate. A settings page
  that hides a knob that still governs money is worse than a crowded one.
- **Auto-tune anything from this page.** The knobs are the owner's; a page that
  quietly proposes values would blur where policy comes from.
- **Merge the three save buttons.** They map to three different config objects
  with different blast radii. One button would make an account-wide change as
  easy as a per-trade one.

---

## Suggested order

1. **A** — pure addition, no behaviour change, biggest immediate relief.
2. **B** — layout only; anchors and the `risk-anchors` test keep it honest.
3. **D** — confirmation copy, no arithmetic.
4. **C** — last, and only after reading what is actually set per account.

A and B together would take the page from *fifty-four inputs* to *six decisions
and four answers*, without changing a single value the bot uses.
