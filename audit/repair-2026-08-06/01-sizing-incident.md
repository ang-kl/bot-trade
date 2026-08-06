# 01 — F-SIZE-01: whose balance was this position sized against?

Phase 1 of the Verified Defect Repair prompt. **No risk limit was raised and no
threshold changed.** One new veto is added — refusing to size a position
against a balance that belongs to a different account — on the owner's explicit
decision of 2026-08-06 ("D-1 proceed to risk gate veto").

---

## The observation, from the owner's own screens (2026-08-06)

The **same** `0003.HK` position — 5,000 units, entry 6.91, stop 6.678, target
7.373 — is open on two accounts at once:

| Account | Login | Balance | Risk to stop | Own 1% budget | Multiple |
|---|---|---|---|---|---|
| 46130058 | 5203012 | USD 46,072.92 | USD 149 | USD 460.73 | 0.32× |
| **43097342** | **5067353** | **USD 1,983.52** | **USD 149** | **USD 19.84** | **7.50×** |

Notional on the small account: 5,000 × 6.91 HKD ≈ **USD 4,429 against USD 1,984
of equity** — 2.2× the account.

Beside it, `0005.HK` on the same small account: six positions (9, 9, 9, 9, 13,
13 = 62 units), every one at entry 168.39 / SL 156.974 / TP 191.221, combined
risk **USD 91 = 4.6×** that account's per-trade budget. Together the two names
put **USD 240 at risk on a USD 1,984 account — 12% of equity** against a
configured 1% per trade, in two correlated Hong Kong listings.

## The mechanism this PR addresses

`getAccountBalance(db, accountId)` reads `acct:<id>:account_balance_usd` and,
when that key is absent, **falls back to the legacy global
`account_balance_usd`** — which its own comment describes as "whatever account
refreshed it last".

For a display that is merely wrong; the owner already caught it printing one
account's balance under another's name (04-08). For **sizing** it is a live
hazard, because `computeRiskBasedVolume` is

```
volume = (balance × riskPct) ÷ usdLossPerLot
```

so a wrong balance multiplies every configured risk percentage by the ratio
between two accounts — 23× here — and does it invisibly, since every downstream
figure is computed from the same wrong balance and therefore agrees with
itself.

### What is NOT yet proved

This is a mechanism that would produce the observation. It is **not** yet proof
that it did, and the difference matters:

- Our `trades` rows for these two positions carry **`volume 83.14`** (0003.HK)
  and **`3.45`** (0005.HK), while `monitored_positions` and the broker show
  5,000 and 62. Ratios 60.1 and 18.0.

  **CORRECTED 2026-08-06.** This was written as "two of our own tables disagree
  about the size of the same position". They do not. `trades.volume` is LOTS and
  the broker reports UNITS, so a ratio is *expected* — and 60.1 and 18.0 are the
  broker's own units-per-lot for those two Hong Kong names, which differ from
  each other because HK CFD lot sizes are per-instrument. The reason the ratios
  looked like nonsense is that `contractSize()` has no entry for either symbol
  and returns 1, so nothing in the codebase could name the expected ratio. That
  is a real defect — on the READ path, for ADOPTED positions — and it is fixed
  in `agent/lib/lot-size-registry.js`. It does not weaken the finding below: the
  identical 5,000-unit position on two accounts of very different size is
  unaffected by any units question.
- Both rows have **`risk_event_id: NULL`**. There is no gate verdict attached,
  so nothing recorded which balance was used, what budget was computed, or why
  this volume. Under the Phase 6 rules shipped in #673 they are
  `legacy_unattributed` — explicitly not clean evidence.
- `source` is `autopilot`, `strategy` is `burnin`, opened 2026-08-03 01:35 —
  the same window that produced the 0066.HK cluster.

So the honest status is `BLOCKED — EVIDENCE REQUIRED` on causation, with a
named, testable mechanism and a fix for the *observability* gap that made it
unprovable.

---

### R1-1 — A position could be sized against another account's balance, silently

**Classification:** `CORRECTNESS FIX` (the veto, owner-approved) +
`OBSERVABILITY FIX` (the provenance on every verdict)
**Status:** mechanism reproduced in tests; production causation blocked on the
missing decision records
**Scope:** `agent/lib/sizing-balance.js` (new), `agent/services/risk.js`

`sizingBalance(db, accountId)` answers one question — *is this balance actually
this account's* — and returns the answer with provenance:

| source | meaning | usable for sizing |
|---|---|---|
| `account` | `acct:<id>:account_balance_usd` | **yes** |
| `selected` | no account named; the selected account's own stamp | yes |
| `legacy` | the global key, owner unknown | **no** |
| `none` | nothing readable | **no** |

Every risk verdict now carries `balance_source`, `balance_is_account_scoped`
and, when borrowed, `balance_scope_warning` naming the account it could not
find a balance for. From the next verdict onward, "which account's money was
this sized against" is a field rather than an inference.

`riskBudgetMultiple` / `overBudget` compute the 7.5× figure in one tested
place, with a 10% tolerance so a broker minimum lot landing slightly over
budget does not bury a genuine multiple in noise.

#### Regression proof

`agent/lib/sizing-balance.test.js` — 12 tests, including the owner's two
readings reproduced exactly (`0.32` and `7.5`), a zero/malformed stamp treated
as absent rather than as a balance of zero, and a gate-level test asserting
that a verdict on an unstamped account reports `legacy` / `false` and the same
verdict after stamping reports `account` / `true`.

---

## The decision — TAKEN, by the owner, 2026-08-06

> **"D-1 proceed to risk gate veto."**

The gate now **refuses** a proposal it cannot size against the named account's
own balance. Scope, precisely:

| condition | `source` | verdict |
|---|---|---|
| the account has its own stamp | `account` | trades as before |
| no account named, selected account has a stamp | `selected` | trades as before |
| no account named, none selected, only the global key | `legacy_unscoped` | **allowed** — nothing has been named, so nothing can be confused |
| ≤1 enabled account in the registry, only the global key | `legacy_single_account` | **allowed** — the hazard requires a second account to borrow from |
| a named or selected account with NO stamp, falling back to the shared key | `legacy` | **VETOED** `balance_not_account_scoped`, naming the account |
| no balance recorded anywhere | `none` | unchanged — already produces volume 0 downstream |

The veto is deliberately narrow, and the narrowing was **driven by the test
suite rather than by preference**. Two rounds of over-reach, both caught before
they could ship:

1. Refusing on `!ok` — which included *no balance at all* — broke twenty tests
   that exercise balance-independent rules (R:R floors, SL distance, cooldowns).
   Absence is a different condition, already handled downstream by volume 0.
2. Refusing whenever a named account lacked its own stamp broke ten more, in
   files whose fixtures register one account and set one balance. The hazard
   requires a **second** account to borrow from; with ≤1 enabled account the
   shared key is unambiguous, and refusing there would block a correct
   single-account install to guard against a confusion it cannot have.

Both narrowings are invariants, not accommodations: production runs five
enabled accounts, which is exactly where the ambiguity lives and where the veto
now fires.

It is also loud by construction. If an account's balance has never been
stamped, every proposal on it is now vetoed **with the account named** —
surfacing the unstamped account immediately instead of trading it against a
stranger's equity until somebody notices.

### What this costs

Entries stop on any account whose per-account balance is unstamped, until the
loop's balance refresh stamps it. That is the accepted price of failing closed,
and it was the owner's call to accept it.

### The former framing, kept for the record



**Should a proposal be VETOED when no account-scoped balance exists?** —
ANSWERED YES on 2026-08-06. The arguments as they stood:

- **For:** it is the only answer that fails closed. Sizing against a balance
  that belongs to nobody is exactly the class of error the prompt says must
  refuse rather than guess.
- **Against:** it would stop entries on any account whose per-account balance
  has not been stamped — potentially all of them, immediately, with no warning.
  That is a trading-behaviour change of the first order.

Answered: yes, scoped to borrowed balances. Implemented at `risk.js` step 0a,
tested in `sizing-balance.test.js`.

## Also outstanding, and not silent

- The **six-way `0005.HK` cluster** is the duplicate mechanism recurring — nine
  0066.HK (#179), six 0005.HK (#184), four GD.US on 46130058 today. It was
  declared fixed in #573 and demonstrably is not.
- Trimming or closing any of these needs a full-tier credential. This session
  holds read-only by design and has changed nothing at the broker.

**No live trading action was taken.**
