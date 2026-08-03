# Account Scope — one switcher, a declared contract, and a register of liars

**Owner, 2026-08-03:** *"should account switch be baked back to side bar and you have
iron-clad wired to every page (every table, etc.) And there is a colour-code small circle
that tied to side-bar to each page and each components in the page, if the component
doesn't tied to the account, it must be flagged or fail to get the data/computed table
must also flagged with reason as a logged register to be build"*

**Status:** proposal. No code moves until this is approved.

---

## 1. Why this is not a UI request

Today produced two failures of exactly this kind, hours apart:

- **The Go-Live Gate card** showed six panels headed "All accounts", four "Pepperstone",
  one "Pepperstone LIVE", one "Pepperstone disabled" — every one displaying the same
  245 closed trades. Not per-account numbers. The same pooled history six times, under
  per-account headings, including the row labelled LIVE. Fixed in #574 by stamping
  `account_id` onto trades.
- **The per-position loss cap** ran with `scope: 'all'` and swept exactly one account.
  `scope:'all'` meant "every position ON THAT ACCOUNT". Every other account had no
  per-position loss cap at all while a USDZAR position ran to −$2,186 against an $800
  cap. Fixed in #574.

Both were components that were **not tied to the account and did not say so**. Neither
was detected by a person reading the screen, because a wrong number and a right number
look identical. That is the problem this plan solves — not the number of clicks it takes
to switch accounts.

The switcher placement is the easy half. The invariant is the point.

---

## 2. Phase 0 — what actually exists (measured, 2026-08-03)

### 2.1 Front end

| | Count |
|---|---:|
| `.jsx` files under `src/` | **91** |
| …that reference account scope in any form | **34** |
| …that do not | **57** |

Not all 57 are wrong — `Card`, `Button`, `Skeleton` and friends legitimately have no
opinion about accounts. The plan must be able to tell "correctly account-blind" apart
from "should be scoped and isn't", and today nothing can.

**Primitives that already exist and will be reused, not reinvented:**

- `src/lib/use-account-switch.js` — the switch hook
- `src/components/AccountSwitcher.jsx`
- `src/components/ActiveAccountHeader.jsx`
- `src/components/PageAccountLine.jsx`
- `src/components/common/AccountScopePills.jsx`
- `src/components/common/AccountTag.jsx`
- `src/components/common/ScopeMismatchNote.jsx`
- `src/components/common/SwitchingNote.jsx`

Seven pages already import the switcher (Accounts, AccountsAudit, Desk, Performance,
Risk, Trade, Tune). **The plumbing is not missing. What is missing is that nothing is
obliged to use it, and nothing notices when it doesn't.**

### 2.2 Back end — measured twice, wrong twice, now stated properly

| | Count (2026-08-03, after S1) |
|---|---:|
| `GET /state/*` routes | **95** |
| …that are account-aware | **45** |
| …that are account-blind | **50** |

> **Corrected TWICE. Both corrections are kept, because the pattern is the lesson.**
>
> **First**, before S1: the document said **11** account-aware, from grepping
> `req.query.account`. That missed every route using the `requestedAccount(db, req)`
> helper — the actual convention. Restated as **23**.
>
> **Second**, after S1 batch 9: it said **73 blind**, and I kept quoting that figure
> while converting routes. Re-measuring across BOTH mechanisms — `requestedAccount`
> *and* a raw `req.query.account` — gives **45 aware / 50 blind**. The 73 was never
> right; the first correction fixed one direction of the same mistake and left the
> other.
>
> The route count also dropped 96 → 95: `GET /state/veto-breakdown` was **declared
> twice**, and Express serves the first registration while silently ignoring the
> second. The dead handler had never run, and an audit that counts routes counted it.
>
> **The lesson is not the arithmetic.** Three times now, a number in this document
> came from grepping one pattern and believing the result. That is the same defect
> class the plan itself is about: a measurement that looks authoritative and is
> answering a narrower question than the one asked. Any future count here should be
> produced by a script that is shown, not by a grep that is trusted.

**The 50 remaining blind routes, classified.** This is the part that matters more than
the count, because "blind" and "wrong" are not the same thing:

| Class | N | Routes | Verdict |
|---|---:|---|---|
| **Correctly global** — market and instrument facts | 6 | `/prices` `/regime` `/depth` `/market-hours` `/symbol-map` `/cluster-conviction` | Leave. A price is a fact about an instrument. `mode: 'global'` in S4. |
| **Correctly global** — process and session health | 6 | `/heartbeats` `/storage` `/llm-spend` `/llm-monitor-health` `/client-ping` `/sessions` | Leave. These describe the agent, not an account. |
| **Correctly global** — jobs and files | 4 | `/backtest-job` `/job/:kind` `/backtest-reports` `/backtest-reports/:name` | Leave. |
| **Correctly global** — global config and filters | 11 | `/stage-matrix` `/fib-rsi-filter` `/fib-vwap-filter` `/fib-fvg-filter` `/autotrade-timeframes` `/arm-benchmarks` `/profit-keeper` `/loss-guardian` `/closed-market-limits` `/bot-changes` `/risk-reassess` | Leave. The Stage Matrix already prints *"Scope: GLOBAL"*; S2 makes that a machine-readable claim instead of a sentence. |
| **Global by construction** | 3 | `/fx-coverage` `/broker-cache` `/watchlist-removed` | Leave. Currency rates, a snapshot blob, a shared list. |
| **Already per-account INSIDE, no `?account=` outside** | 14 | `/profit-ratchet` `/loss-cap` `/goal-tracker` `/account-phases` `/account-engineering` `/account-settings` `/account-traffic-lights` `/account-capabilities` `/workspace-log` `/workspace-backtests` `/workspace-coverage` `/unresolvable-plan` `/protection-audit` `/sizing-preview` | These already answer per account by looping the registry or reading the selected one. They do not need converting; they need **declaring** in S4 so a dot can say which mode they are in. |
| **Worth a look in S4** | 6 | `/phase-audit` `/phase-trace` `/watchlist-summary` `/strategy-liveness` `/weekend-loss-flags` `/risk-exposure` | Not obviously wrong, not obviously right. Deferred deliberately rather than converted on a guess. |

**S1 is done.** Not "50 routes remain" — the account-*meaningful* reads are scoped and
report coverage. What is left is either correctly global or already per-account, and
both of those are S4 declarations, not S1 conversions.

### 2.3 The convention exists; coverage was the missing half

`agent/lib/account-scope.js` is the real convention: `requestedAccount(db, req)` resolves
`?account=` / `?account=all` / the selected account, `accountWhere()` builds the
predicate, `countUnattributed()` counts NULL rows. Nine routes use it directly.

`agent/services/viewed-account.js` implements the same idea a second time and has **zero
callers in `state.js`**. S1 builds on `lib/account-scope.js` and does not extend the
unused one — a second source of truth is the defect behind three separate bugs fixed on
2026-08-03 alone, and the first attempt at S1 added coverage to the wrong file before
this was noticed.

What was missing is not the scoping. It is that `countUnattributed` counts NULLs across
the **whole table**, so a route returning 20 open positions reports a figure drawn from
thousands of closed ones. That is a footnote, not a per-panel signal — and it is why the
Go-Live card could show six pooled panels with nothing contradicting it.

---

## 3. The contract

One hook. Every component that renders account-dependent data declares its scope through
it, and declaring is what makes everything else possible.

```js
const scope = useAccountScope({
  id: 'perf.strategy-matrix',   // stable, unique — the register key
  mode: 'account',              // 'account' | 'global' | 'portfolio'
  covers: (rows) => …           // optional: does the DATA match the claim?
})
```

- **`mode: 'account'`** — must be filtered to the selected account. The default.
- **`mode: 'global'`** — deliberately account-independent, and says so out loud. The
  Strategy × Stage Matrix already prints *"Scope: GLOBAL — these stage settings apply to
  every trading account"*; this makes that a machine-readable claim rather than a
  sentence.
- **`mode: 'portfolio'`** — deliberately spans all accounts (the "All accounts" roll-up).
  Distinct from `global`: portfolio aggregates account data, global has none.

`covers()` is the part that catches the Go-Live card. A component may pass the right
`account` parameter and still receive rows that are not attributable — 245 trades with
`account_id: NULL` satisfy a scoped query and mean nothing. `covers()` inspects what came
back and reports the attributable fraction.

**A component that renders account data without calling the hook is a defect**, caught by
lint (§6).

---

## 4. The dot

The sidebar sets the account's colour. Every page header and every card/table carries the
same dot, so the eye can follow one colour down the screen.

| Dot | Meaning | Action |
|---|---|---|
| **Blue** (account colour) | Scoped, and the data matches the claim | none |
| **Grey** | `global` or `portfolio` — account-independent **by declaration** | none |
| **Amber** | Renders account data with **no scope declared**, or scoped but coverage < 100% | the Go-Live-card class |
| **Red** | Declared scope, and the fetch **failed** or returned nothing attributable | reason on hover |

Amber and red both carry a **reason string**, always. `"245 rows, 0 attributable"`,
`"/state/perf-ledger does not accept ?account"`, `"fetch failed: 500"`. A dot without a
reason is a mood.

Partial coverage shows the number: **`87% of 253 rows attributable`** beats a colour,
because that is the sentence that would have caught this morning's card.

---

## 5. The register

Dots vanish when you close the tab. The register is what makes "which panels are lying to
me" a query.

```sql
CREATE TABLE IF NOT EXISTS scope_audit (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL DEFAULT (datetime('now')),
  component_id TEXT NOT NULL,      -- 'perf.strategy-matrix'
  page         TEXT,               -- '/performance'
  account_id   TEXT,               -- the account SELECTED at render time
  mode         TEXT NOT NULL,      -- account | global | portfolio
  state        TEXT NOT NULL,      -- ok | unscoped | partial | failed
  reason       TEXT,               -- required unless state='ok'
  rows_total   INTEGER,
  rows_scoped  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_scope_audit_state ON scope_audit(state, at);
```

Written through a new `POST /actions/scope-audit`, **batched once per page render**, not
per component — a dashboard with forty cards must not produce forty requests.

Read back through `GET /state/scope-audit`, which answers the question the owner actually
has: *which components have ever rendered unscoped, on which account, and why.*

**Write discipline:** `ok` rows are **not** stored individually — they are counted. Only
`unscoped`, `partial` and `failed` are recorded as rows. A register that logs every
healthy render is a log, not a register, and it will be ignored inside a week.
Retention: 30 days, on the existing retention sweep.

---

## 6. The lint — what makes it iron-clad rather than aspirational

Dots and registers are runtime. They only report on code paths somebody happened to open.
The invariant needs a build-time half, in the same spirit as the two guards added today
(`textTransform: 'capitalize'`, and the duplicate strategy-name map):

**A component that reads a known account-bearing field — `account_id`, `accountId`,
`acct` — or calls `agentGet` on one of the 11 account-aware routes, and does not call
`useAccountScope`, fails the build.**

Deliberate exemptions are declared in the file, visibly:

```js
// scope-exempt: renders broker-truth for every account by design
```

That is the difference between "we intend every table to be account-aware" and "every
table is account-aware". Today's session is three separate proofs that intent does not
survive contact with the next feature.

---

## 7. Milestones

Each is independently shippable and independently useful. Nothing here is a big-bang
rewrite.

| # | Milestone | What lands | Rough size |
|---|---|---|---|
| **S1** ✅ | `?account=` + coverage on every account-meaningful route | **DONE 2026-08-03.** `scopeCoverage()` / `scopeReport()` in `lib/account-scope.js`, then 22 routes converted across nine batches. Also fixed three defects found on the way: the closed-trade duplicate detector was blind to the account (copied legs merged into false duplicates that subtracted real P&L from Performance); `/state/scans` was scoped by default when it is a global market observation, which would have shrunk the price map the UI converts currencies through; and `/state/veto-breakdown` was declared twice, the second declaration dead. A guard test now fails the build on duplicate routes. | Large, mechanical, high value |
| **S2** | `useAccountScope` + `ScopeDot` | The hook, the four states, the reason strings. No behaviour change — dots appear, nothing else moves. | Small |
| **S3** | Sidebar switcher becomes the single source | One switcher in the sidebar; per-page switchers removed. Account colour defined once and consumed by every dot. | Small |
| **S4** | Adopt across pages | Nine pages, ~34 account-touching components declare their mode. Expect a run of amber on first paint — **that is the deliverable**, not a regression. | Medium |
| **S5** | `scope_audit` table + routes + the register view | The durable record and the query behind it. | Medium |
| **S6** | The lint | Turn the invariant on. Only after S4, or the build is red on day one. | Small |

**Recommended order: S1 → S2 → S3 → S4 → S5 → S6.** S1 first because until the routes can
be scoped, S4 can only paint amber it has no way to clear.

---

## 8. Open decisions

**Decided by the owner, 2026-08-03:** blue for OK · grey for declared global ·
LIVE included in the portfolio roll-up but always labelled · amber below 100% ·
30-day register retention. The four questions below are recorded as answered;
the reasoning is kept because it is why the answers are what they are.

1. **Where per-account settings sit.** Some things are global by design (the Stage
   Matrix), some per-account (S.A.T. switches, risk limits). Should `global` components be
   *hidden* when a specific account is selected, or shown with a grey dot? **Recommend
   shown-with-grey** — hiding teaches you the page changes shape, which is its own
   confusion.
2. **What "portfolio" means for LIVE.** Does an "All accounts" roll-up include the LIVE
   account? Today it does, which is how a card claiming 244 closed trades appeared against
   an account holding SGD 34.30. **Recommend LIVE is included but always separately
   labelled**, never silently pooled.
3. **Amber tolerance.** Is 87% coverage amber or green? **Recommend anything below 100% is
   amber with the number shown.** A 13% gap is exactly the size of gap that hides a real
   problem.
4. **Register retention.** 30 days proposed. Longer if you want to prove a component has
   been clean since a given date.

---

## 9. What this explicitly does not do

- It does not change any trading behaviour, risk limit, or gate.
- It does not change what data exists — S1 exposes scoping that the tables already
  support; where `account_id` is genuinely NULL it reports the gap rather than inventing
  an attribution. A wrong account id is worse than an honest one.
- It does not make every component account-scoped. It makes every component **declare**,
  and makes the ones that cannot **visible**.
