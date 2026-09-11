# Prior cohort watch (owner order, 02-09-2026)

The earned floor admits sub-3R proposals on two paths. The **measured** path
needs `minSample` live closes under 3R on the account (`earnedFloorVerdict`,
`agent/services/earned-floor.js`). The **prior** path (#826) takes the verdict
on the shrunk win rate W′ = (n·W_live + 20·W_backtest)/(n + 20) when the live
sample is thin — demo accounts only, at `priorRiskScale` (0.5) of the per-trade
budget, stamped `via: 'prior'` in `checks.earned_floor`. Both populations join
the same pre-registered cohort.

## What is watched, daily

`GET /state/earned-floor`:

- `closedCohort` — the pooled cohort, the pre-registered verdict.
- `viaPrior` — the prior population alone: approvals, closes, wins, win rate,
  profit factor, net.
- `byAccount` — the same split per account; legacy rows with no account land in
  `unscoped`, never dropped.
- `verdict` — `pending n/30`, then `pass` or `fail`.

Every admit prints `[risk] earned_floor admit: … via=<measured|prior> acct=<id>`
and log-watch pushes it to Telegram (rule `earned_floor_admit`).

## The widening criterion — written down, not enforced in code

Pre-registered before the first admitted trade (`EARNED_FLOOR_VERDICT_TARGET`):

- **≥ 30 closes** in the pooled cohort and **PF ≥ 1.5** keeps the gate and
  earns the live-scope conversation; under 1.5 the owner turns
  `earned_floor_json.on` off and the blanket 3R floor resumes.

Added 02-09-2026, when the prior became an actuator (NOT pre-registered —
recorded here so it cannot drift later):

- Before any widening is discussed, the **prior population alone** must show
  **≥ 15 closes and PF ≥ 1.5**. A measured cohort that passes on the back of a
  prior population that fails is not a pass for the prior.

Since PR-B (11-09-2026, owner principle 1) both the **measured** and the
**prior** path admit on every account by code — there is no `demoOnly` dial
and no demo-only prior any more (`agent/services/earned-floor.js`,
`earned-floor.test.js`: a live row admits by both paths). Turning the prior
off without touching the measured path: `POST /actions/earned-floor
{ priorAdmit: false }`.

## What would change my mind

- The prior population's PF under 1.0 at 15 closes: turn `priorAdmit` off,
  keep measuring the measured path.
- A single strategy carrying the whole prior population: read `byAccount` and
  the target review (`GET /state/target-review`) before widening anything.
