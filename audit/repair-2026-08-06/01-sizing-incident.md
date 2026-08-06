# 01 — F-SIZE-01: whose balance was this position sized against?

Phase 1 of the Verified Defect Repair prompt. **No risk limit was raised, no
threshold changed, and nothing here gates a trade yet.** What ships is the
evidence; the gating decision is the owner's and is stated at the bottom.

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
  5,000 and 62. Ratios 60.1 and 18.0 — not a constant, so not a clean
  lots-to-units conversion either. Two of our own tables disagree about the
  size of the same position.
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

**Classification:** `OBSERVABILITY FIX` now; the gating change is
`OWNER POLICY DECISION` (below)
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

`agent/lib/sizing-balance.test.js` — 9 tests, including the owner's two
readings reproduced exactly (`0.32` and `7.5`), a zero/malformed stamp treated
as absent rather than as a balance of zero, and a gate-level test asserting
that a verdict on an unstamped account reports `legacy` / `false` and the same
verdict after stamping reports `account` / `true`.

---

## The decision this PR deliberately does NOT take

**Should a proposal be VETOED when no account-scoped balance exists?**

- **For:** it is the only answer that fails closed. Sizing against a balance
  that belongs to nobody is exactly the class of error the prompt says must
  refuse rather than guess.
- **Against:** it would stop entries on any account whose per-account balance
  has not been stamped — potentially all of them, immediately, with no warning.
  That is a trading-behaviour change of the first order.

Turning it on is one line once you decide. Until then the gate records the
condition and trades exactly as it did before. **This is the item to answer
before the sizing repair can be called complete.**

## Also outstanding, and not silent

- The **six-way `0005.HK` cluster** is the duplicate mechanism recurring — nine
  0066.HK (#179), six 0005.HK (#184), four GD.US on 46130058 today. It was
  declared fixed in #573 and demonstrably is not.
- Trimming or closing any of these needs a full-tier credential. This session
  holds read-only by design and has changed nothing at the broker.

**No live trading action was taken.**
