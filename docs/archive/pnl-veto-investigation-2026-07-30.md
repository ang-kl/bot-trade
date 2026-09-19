# Investigation — `unknown daily pnl (account)` and autotrade dropping off accounts

Brief: `instr/indp_invest.md`. Owner, same message: *"also ensure the account
switches is ironclad, sometimes autotrade drops from the accounts and I don't
see any trades especially today."*

Confirmed facts are separated from hypotheses throughout, as the brief requires.
Nothing in production state was modified.

---

## 0 · The brief's central premise is wrong about this system, and it matters

The brief is written for C++ controllers: *"The system uses C++ controllers
operating concurrently across multiple threads"*, with Phase 3 devoted to data
races, atomics, lock ordering, use-after-free and thread starvation.

**The veto is not in C++.** It is in single-threaded JavaScript:

| | |
| :-- | :-- |
| **Emitting file** | `agent/services/unresolved-pnl.js` |
| **Function** | `unknownPnlBlocks()` — lines 95 and 99 |
| **Exact strings** | `unknown_daily_pnl (${scope}): the closed-trade P&L lookup failed …` and `unknown_daily_pnl (${scope}): N closed trade(s) today have no realised P&L after Nm …` |
| **Scope values** | `account` \| `portfolio` |
| **Callers** | `agent/services/risk.js` (per-account entry gate) and `agent/services/global-guards.js` (portfolio layer) |
| **Runtime** | Node, one thread, one event loop |

So **Phase 3 has no referent for this veto**. There are no data races, no atomics
and no lock ordering to examine on this path; there is exactly one writer and one
reader, and they are the same thread. The C++ sidecar (`cpp-exec/`) is real and is
multi-threaded, but it does not compute daily P&L and does not emit this string —
it executes orders and enforces `order_guard`. Investigating C++ concurrency here
would have burned the whole engagement on the wrong process.

The brief's Phase 4 (validity modelling) and Phase 6 (shared infrastructure) do
apply, and are where the findings below come from.

---

## 1 · What the veto actually means — CONFIRMED

`net_pnl` on a closed trade is `NULL` until the broker's deal history is read
back. Three of the seven closure paths leave it NULL, including the reconciler's
broker-side close (`reconciler.js:285`) — the **normal** exit for a stop-out.

SQLite's `SUM` skips NULLs and the surrounding `COALESCE(…, 0)` turns an all-NULL
sum into `0`. So a day made of stop-outs sums to **exactly zero** and presents as
flat. Both daily-loss caps read that as "no losses today".

The veto exists because of that: a closed trade with no realised P&L is not worth
zero, it is **unknown**, and a money ceiling must fail towards stopping. Past a
15-minute grace window (`DEFAULT_UNKNOWN_PNL_GRACE_MIN`) it blocks new entries.

**This is working as designed.** The veto firing is a symptom of unresolved
`net_pnl`, not a bug in the veto. Per the brief's own rule — *"Treat the veto as
a valid fail-closed risk response until proven otherwise"* — it stays.

### Why it hits every account at once — CONFIRMED

`unresolvedPnlSince()` scopes a per-account evaluation with:

```sql
AND (account_id = ? OR account_id IS NULL)
```

That is the correct predicate for **scoping a view** and the wrong one for
**attributing money**. One legacy closed trade with `account_id IS NULL` and
`net_pnl IS NULL` is counted against **every account simultaneously**, so a
single unattributable row blocks new entries on all seven accounts until the FX
day rolls.

**I changed this and then reverted it.** Scoping it to `account_id = ?` makes the
symptom disappear and is a *weakening*: an unattributed unknown might belong to
the account being evaluated, so excluding it lets that account trade against a
total known to be incomplete. The brief forbids exactly that — *"Do not bypass,
suppress, hard-code around, or weaken the PnL veto."* There is also a test,
`unresolved-pnl.test.js:92`, that deliberately pins the fail-safe.

**What changed instead: observability.** `unattributedCount` is now reported and
named in the reason string, so a blocked desk says

> *…3 closed trade(s) today have no realised P&L after 15m; 1 of them have NO
> account_id, which is why every account is affected — attribute or backfill that
> row to clear it*

The cure is fixing the **data**. Loosening the guard is not the cure.

---

## 2 · Why autotrade "drops from the accounts" — CONFIRMED, and this was the real defect

Separate mechanism, same complaint. `agent/services/account-phases.js` computes

```
effective = master AND (override ?? master)
```

so writing the **master** `autotrade_enabled` flag is an absolute veto that
silently overrides every per-account Autotrade switch at once. Three mechanisms
wrote the master automatically:

| mechanism | site | scope of its trigger | verdict |
| :-- | :-- | :-- | :-- |
| **Equity stop** | `loop.js:2963-3009` (old) | **three mismatched scopes** — see below | **the defect. Fixed.** |
| Performance breaker | `performance-breaker.js:92` | portfolio-wide rolling stats | correct scope for a portfolio finding; left alone |
| Profit ratchet | `profit-ratchet.js:128` | portfolio equity high-water | correct scope; left alone |

### The equity stop compared three different scopes in one `if`

```js
const balance  = getAccountBalance(db)                       // the SELECTED account
const cap      = balance * stopPct
const todayPnl = SUM(net_pnl) … WHERE status='closed'        // ALL ACCOUNTS, no filter
if (todayPnl <= -cap) setState(db, 'autotrade_enabled', 'false')   // ALL ACCOUNTS
```

A cap sized from **one** account's balance, a loss summed across **every**
account, and a disarm applied to **every** account. On this desk the live account
holds 33.45 SGD while a demo holds ~51k USD, so the cap can be a few dollars
while the sum is portfolio-wide. Consequences, all of them things the owner
reported:

1. It trips far earlier than any account's own risk settings imply.
2. It disarms **all** accounts, defeating the per-account switches.
3. It closed every account's bot positions, not just the offender's.
4. It wrote to **stdout only** — nothing in `action_log`, nothing in the decision
   log, and the Telegram alert did not name an account. Hence *"I don't see any
   trades"* with no visible reason.

### The fix (owner decision, asked and answered 2026-07-30)

New module `agent/services/equity-stop.js`, loop rewired to it:

- **cap** from `getAccountBalance(db, accountId)` — that account's balance
- **loss** from `accountPnlToday()` — `account_id = ?`, no NULL fold-in, because
  this is attribution, not scoping
- **disarm** writes `acct:<id>:autotrade_enabled`, the per-account override.
  **The master is never touched**, so the panic button stays the owner's and the
  other accounts keep their own switches
- **trip marker** per account (`acct:<id>:equity_stop_tripped_at`), so one
  account tripping cannot silence the check on another
- **positions** closed only for the breaching account
- **visibility**: `action_log` (`EQUITY_STOP`), `decision_log` (stage
  `equity_stop`, decision `halt`), and a Telegram alert that names the account and
  states that only that account was disarmed
- **unknown P&L surfaced**: a breach reason says how many closed trades still
  have NULL `net_pnl`, i.e. that the real loss is *at least* the figure shown
- **no usable cap is not a breach** — closing positions against a threshold we do
  not have would be acting on a number we never computed

Portfolio-wide protection is **not lost**. It already lives in
`services/global-guards.js` (5A: portfolio halt, portfolio daily-loss cap, total
position cap), separately configurable. The equity stop had been duplicating that
badly and at the wrong scope.

---

## 3 · A second, opposite bug found next to it — CONFIRMED

`loadPerformanceBreakerConfig()` read `autoDisarm: parsed.autoDisarm === true`.
So any stored `performance_breaker_json` whose payload **omitted** the key — or
sent it as the string `"true"` from a form — silently resolved to **false**,
standing down a protection the owner deliberately armed on 2026-07-20 after a
0.15 profit factor and −$2019 net. An absent key now inherits the documented
default; a present key is honoured in the forms a JSON form actually produces.

**A correction I owe the owner.** I initially reported the `autoDisarm: true`
constant as a stray bug contradicting the file's own comment, and asked whether
to flip it to `false`. That was wrong: the constant carries their explicit
2026-07-20 decision, recorded in the code, and the **comment** is what was stale.
They answered "default OFF" on my incorrect framing, so I have **not** applied
that flip — reversing a money decision on a premise I mis-stated is not something
to do quietly. The stale comment is corrected; the default is unchanged and
awaits their word with the right facts in hand.

---

## 4 · Phase-by-phase against the brief

| phase | status |
| :-- | :-- |
| 1 · Locate the veto origin | **done** — file, function, lines, callers, both scopes, and the distinction the check does *not* make (it does not separate missing / stale / invalid / not-yet-initialised; all four present as "unknown"). |
| 2 · Trace the PnL lifecycle | **partly** — the first stage where P&L goes missing is identified (the closure write leaves `net_pnl` NULL; `pnl-backfill.js` is the only repair and it is per-account and gated). A full stage-by-stage record with sequence numbers and receive timestamps is **not possible from here**: I have no production credential in this environment, only the staging one. |
| 3 · C++ concurrency | **not applicable to this veto** — see §0. Node, single-threaded. |
| 4 · PnL state representation | **done, and it is a real gap.** Unavailable P&L is represented as SQL `NULL` and nothing else. The brief asks for `PnLState = NotInitialised \| Valid \| Stale \| Invalid \| SourceDisconnected \| ReconciliationRequired`; the system has one bit. That is why every cause reduces to "unknown" in the log. **Not built** — it is a schema change and I did not want to make one inside an incident fix. |
| 5 · Trading day / clock | **checked, no finding.** One anchor, `fxDayStartSql()` / `fxDayOpenMs()` (17:00 NY), used by the risk gate, the equity stop and the veto alike. The `REPLACE(closed_at,'T',' ')` normalisation is present at every comparison — a real bug found 2026-07-24 where the two timestamp formats silently excluded every production-closed trade. No independent trading-date derivation was found. |
| 6 · Shared infrastructure | **done** — the shared dependency is not a service, a bus or a cache. It is a **column**: `trades.net_pnl`, plus the one predicate that folds unattributed rows into every account. |

---

## 5 · What I could NOT verify, stated plainly

- **No production evidence.** This environment holds `AGENT_SECRET` for staging
  only. Every live figure below is staging. To confirm the incident *as it
  happened today* I need either a read-tier production token or these three
  outputs pasted in:
  - `GET /state/risk-events?limit=50`
  - `GET /state/decisions?limit=200`
  - `SELECT id, symbol, account_id, net_pnl, closed_at FROM trades WHERE status='closed' AND net_pnl IS NULL AND closed_at >= <fx day start>;`
- **Staging shows neither symptom**, so it does not corroborate: autotrade is
  FALSE there by standing instruction, and its 200 most recent decisions are all
  `stage_matrix` skips (`strategy … is OFF in Auto Trade & Open`) with **zero**
  `unknown_daily_pnl` rows.
- Whether the equity stop is what fired **today** on production is therefore a
  **hypothesis**, not a confirmed fact — a well-supported one, because it is the
  only mechanism that disarms accounts *plural* with no on-screen trace. The two
  other automatic disarms both announce themselves via Telegram.

---

## 6 · Verification of the fix

19 new tests in `agent/services/equity-stop.test.js`, the first two named
`IRONCLAD` because they are the owner's requirement:

- disarming one account leaves `autotrade_enabled` untouched and account B armed
- a breach on A leaves B's effective autotrade `true`
- a master OFF still vetoes a per-account ON — the panic button is intact
- an unattributed loss is charged to **no** account rather than all of them
- NULL `net_pnl` is counted, not read as zero, and surfaced in the reason
- both `closed_at` formats are seen
- no usable cap ⇒ no breach; nothing open ⇒ nothing to do; exact-cap trips,
  a cent short does not; a profitable day never trips; a mis-signed `stopPct`
  cannot invert the comparison
- the trip marker is per account and per FX day, and junk in it reads as
  not-tripped so the check still runs
- the disarm is journalled, and a failed journal write never blocks the stop

Plus 5 new tests on the veto's observability. Full gate: **1618** node tests,
303 vitest, eslint, build, `check:no-green`, `audit:ui`.

---

## 7 · Recommended next, in order

1. **Get the production evidence in §5** so the "what fired today" hypothesis
   becomes a fact or gets discarded.
2. **Fix the unattributed rows.** Any closed trade with `account_id IS NULL`
   blocks every account for the rest of the day, by design. A one-off
   attribution pass plus a `NOT NULL` constraint going forward removes the whole
   class. This is the highest-value follow-up and it needs no guard weakened.
3. **Make `pnl-backfill` cover every enabled account per cycle**, not just the
   selected one. It is already account-scoped (fixed 2026-07-29) but runs for one
   account at a time, so a NULL row on a non-selected account can sit unresolved
   indefinitely — and that is precisely what trips the veto.
4. **Build the `PnLState` enum from Phase 4.** One `NULL` cannot distinguish
   "the backfill has not run yet" from "the broker rejected the deal-history
   request", and the risk log should say which.
5. **Decide the `autoDisarm` default** with §3's correction in front of you.
