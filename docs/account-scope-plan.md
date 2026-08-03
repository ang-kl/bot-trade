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

### 2.2 Back end — this is the larger half

| | Count |
|---|---:|
| `GET /state/*` routes | **96** |
| …that are account-aware | **23** |

> **Corrected 2026-08-03, after starting S1.** The first version of this document said
> **11**, from grepping `req.query.account`. That missed every route using the
> `requestedAccount(db, req)` helper — which is the actual convention. The real figure is
> **23**. It is corrected in place rather than quietly edited because the wrong number was
> used to justify the sequencing below.

The 23: `/account-analytics`, `/account-settings`, `/config`, `/decision-feed`,
`/decisions-daily`, `/orders`, `/pause-plan`, `/pending-orders`, `/perf-ledger`,
`/phase-audit`, `/positions`, `/postmortems`, `/risk-config`, `/risk-events`,
`/risk-full`, `/strategy-insights`, `/strategy-liveness`, `/strategy-tf-performance`,
`/trades`, `/veto-breakdown`, `/watchlist-summary`, `/workspace-backtests`,
`/workspace-log`.

**73 of 96 routes are account-blind.** So a component cannot be scoped today even when
it wants to be — there is no parameter to pass. Any plan that only paints dots on the
front end would produce a wall of amber it cannot fix, which is how a warning becomes
wallpaper.

**Consequence for sequencing: the server work leads, the dots follow.** The correction
does not change that — it changes how much of S1 was already done.

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
| **S1** | `?account=` + coverage on the remaining routes | `scopeCoverage()` / `scopeReport()` land in `lib/account-scope.js` (**done**), then the 73 account-blind `/state` routes gain the parameter, using the existing scoped-read convention. **The scoped-read trap is the risk here** — `WHERE (account_id = ? OR account_id IS NULL)` is correct when unstamped rows are a residue and ruinous when they are all of them, which is exactly how the Go-Live card broke. Every route converted gets a coverage figure, not a silent OR-NULL. | Large, mechanical, high value |
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
