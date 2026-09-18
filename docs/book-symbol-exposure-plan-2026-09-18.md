# The book-wide symbol cap — plan and evidence (18-09-2026)

Owner order, 18-09-2026 ~10:20 SGT: *"give me a proper plan that starts with a
synopsis based on good trading analysis, explain — build the per-symbol
exposure cap"*.

Risk limits are ask-first under CLAUDE.md's P7. This document is the reasoning
behind the change; the owner's instruction above is the authority for building
it. The one number that is genuinely a judgement call is flagged in §5.

---

## 1. Synopsis

**The strategies are not losing money. One uncontrolled exposure is.**

Measured across the 60 complete closed-position records (`/state/position-history`,
18-09-2026 01:58 UTC):

| | n | win % | net |
|---|---|---|---|
| All records | 60 | 41.7 % | **−824.33** |
| **NATGAS** | 23 | 21.7 % | **−980.84** |
| Everything else | 37 | 54.1 % | **+156.51** |

Excluding one symbol, the book has a 54 % win rate, a 1.23 payoff ratio and a
**profit factor of 1.45**. Including it, profit factor is 0.40. NATGAS is not
the largest loss — it is larger than the entire loss.

Read the aggregate alone and the conclusion is "the strategies are broken".
Acting on that reading would degrade the 37 trades that work in order to fix a
problem that is not in them. This is the arithmetic of concentration, not of
edge.

---

## 2. The mechanism — measured, not inferred

The first reading of this was **wrong** and is corrected here, because the
correction is the whole finding.

The initial diagnosis was "one account stacked seven NATGAS longs; the position
cap counts positions but risk is carried by correlated exposure". Grouping the
same records by account refutes it:

```
16-09 02:02  acct=46130058  long va_breakout    −70.50
16-09 02:02  acct=43097342  long va_breakout     −3.82
16-09 02:02  acct=46979908  long va_breakout     −1.50
16-09 02:02  acct=47790949  long va_breakout    −77.00
```

Four simultaneous longs, **four distinct accounts, one position each**. The
same shape at 06:5x (three accounts) and 15:3x (three accounts).

`DEFAULT_MAX_PER_SYMBOL = 3` in `agent/services/symbol-position-cap.js` was
**never breached on any account**. Every account was individually compliant.
The book carried 4× the intended exposure to one contract and every guard
reported healthy, because every guard measures **per account** while the risk
is borne **per owner**.

This is CLAUDE.md failure mode #3 exactly: a guard that is on, configured, and
out of reach of what it guards. It is also why the fix is *not* a per-symbol
cap — that already exists and works as designed. The gap is one level up.

### Why the same signal reaches every account

The cluster rule (owner, 09-09-2026) turns every strategy on for every account.
That is deliberate and is not being revisited here. Its unintended consequence
is that a single signal now produces one legal position per account, so the
book's exposure to any one symbol scales with the number of enabled accounts
rather than with conviction.

### The sizing asymmetry that makes it expensive

Same signals, same direction, same minute — wildly different money:

| account | NATGAS n | net |
|---|---|---|
| 47790949 | 7 | **−678.90** |
| 46130058 | 6 | −284.70 |
| 43097342 | 3 | −10.44 |
| 46979908 | 7 | −6.80 |

Position size is risk-based off each account's balance, so the large accounts
take the large losses. A book-wide count cap therefore does **not** cap book
risk evenly — it caps the number of accounts exposed, and which accounts win
the race decides the money. §5 returns to this as the honest limitation.

---

## 3. What the exits say

| Exit | n | win % | net |
|---|---|---|---|
| Stop loss | 26 | **0 %** | **−1,128.98** |
| Time cap | 15 | 60 % | −66.35 |
| Broker-side close | 15 | 86.7 % | +206.62 |
| Already closed | 2 | 100 % | +165.77 |
| Bank at 1R | 1 | 100 % | +0.40 |

Two things follow.

**The stops are not the defect.** Realised R on the stopped NATGAS legs sits at
−0.96 to −1.16. The stops did precisely their job at precisely their distance.
What was wrong was how many of them fired on the same bet at the same time.

**PR-J's premise is confirmed by measurement.** The time cap cut **9 winners
worth +176.19** against 6 losers worth −242.54 — it closes winning trades at a
3:2 rate by count. PR-J was built on reasoning; this is the evidence for it.

---

## 4. Sizing the cap from the data

A "simultaneous multi-account cluster" is the same symbol and direction closing
within the same 30-minute bucket across more than one account. There are
**11** in the 60 records, holding **−587.08** between them.

Expected P&L change if the book had capped the number of accounts per symbol,
under random ordering of which accounts get in first:

| book cap | expected change | net would have been |
|---|---|---|
| 1 account | **+404.03** | −420.30 |
| 2 accounts | **+220.98** | −603.35 |
| 3 accounts | +42.48 | −781.85 |

**The cap cuts winners too, and the table already accounts for it** — the
clusters include `0016.HK` short (+162.76 across 2 accounts) and `ABBV.US`
short (+50.44 across 4). A tighter cap forfeits part of those. The figures
above are net of that forfeit, which is why cap 1 gains +404 rather than the
+587 a losses-only reading would claim.

---

## 5. The design, and the one judgement call

**Build:** a book-wide ceiling on how many *distinct accounts* may hold a
simultaneous position in the same symbol **in the same direction**.

- Direction-scoped, because additive risk is the hazard. Opposite directions
  across accounts are net-flat at the book level (they pay double spread, which
  is a different and smaller problem, and is not addressed here).
- Counted from live state only — open positions, in-flight orders, resting
  limits — mirroring `countForSymbol`. A closed trade never counts, so this is
  a concurrency limit and never rations opportunity over time.
- Placed beside the existing per-symbol ceiling in `risk.js`, not in place of
  it. Both must pass.
- First-come. No account is privileged, which keeps owner principle 9 ("no
  restricted trading for certain accounts") intact: the restriction is on the
  *symbol*, and any account may be the one that gets it.

**The judgement call, stated plainly:** the number. The data argues for 1; 1 is
also the most aggressive reduction in book breadth and forfeits the most
upside. **This ships defaulting to 2** — it recovers an expected +220.98 of the
measured −824.33 while still permitting genuine cross-account diversification,
and it is a setting, not a constant, so it can be moved to 1 without a code
change if the owner prefers the data's answer to the conservative one.

**What this change does not claim.** 60 records out of 1,287 closed trades —
1,227 are incomplete, so this describes **4.7 %** of the history, skewed to the
last week. And all 60 are `verification_state = 'unverified'`: the money
figures come from the broker's own ledger and are trustworthy, but the R
figures depend on `entry_price`, the field this project has already had to
withdraw a conclusion over (184 differences in 276 matched pairs, against 0 for
`net_pnl`). The concentration finding rests on **money and account identity**,
neither of which is in doubt. Any R-based refinement of the cap should wait for
cpp-verify's verdicts (PR-AP).

---

## 6. Not in this change

- **Per-symbol exposure expressed in R** rather than account count. Better in
  principle, and it would handle the sizing asymmetry in §2 that a count cap
  does not. It needs `risk_dist` and `planned_entry`, which are missing on
  1,107 of the incomplete records, and it needs verified entry prices. Revisit
  after the backlog has verdicts.
- **The 1,227 incomplete records.** A backfill is a larger question than this.
- **Revisiting the cluster rule.** All strategies on all accounts is an owner
  decision and stays.
