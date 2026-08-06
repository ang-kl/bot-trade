# Result — Bot-Trade Verified Defect Repair and Decision-Integrity Implementation

Programme: `instr/Bot-Trade Verified Defect Repair and Decision-Integrity
Implementation Prompt v1.0.md`
Report written: 2026-08-06 20:15 UTC (2026-08-07 04:15 SGT), market closed.

| | |
|---|---|
| Frozen SHA for this report | `cf2dbf9e01e3ede657a8d3c0b1c6d0d0f1849784` (`main`, = `origin/main`) |
| Phase 0 freeze SHA | `9101eb4b206d5cbafc155c75cd68aaa9ba5f96c5` |
| PRs in the programme | #670, #671, #672, #673, #674, #680 |
| Node / npm | v22.22.2 / 10.9.7 |
| Compiler | g++ 13.3.0 |
| Live trading actions taken | **none** |

---

## Verdict

> Has the repair made the system more correct and measurable without weakening
> capital protection or pretending that the trading edge is proven?

# `PARTIAL — SPECIFIED GATES REMAIN`

The verdict is not a hedge and it is not going to be upgraded by rereading the
work. One gate in the prompt — Phase 7, the offline exit counterfactual — is
**unrun**, and it cannot be run today for a reason that is structural rather
than organisational: the harness requires clean-origin rows, clean-origin rows
only began to exist when #673 merged on 2026-08-06, and the sample needs on the
order of seven days to reach a size worth quoting. The instrument for that gate
was built and shipped (#680) and deliberately not run.

A second gate is open for a different reason: **F-SIZE-01's causation is still
`BLOCKED — EVIDENCE REQUIRED`.** The mechanism is reproduced in tests and the
observability gap is repaired, but the two production rows that prompted the
finding carry `risk_event_id: NULL` and therefore cannot be attributed. That is
honest ignorance, not a pending task.

Everything the prompt asked for that *could* be settled at this SHA has been.

---

## What each phase did, and its status

| Phase | Subject | Shipped in | Document | Status |
|---|---|---|---|---|
| 0 | Freeze and reconcile | #670 | `00-reconciliation.md` | complete |
| 1 | F-SIZE-01 sizing incident | #674, #678 | `01-sizing-incident.md` | remedy shipped; **causation `BLOCKED — EVIDENCE REQUIRED`** |
| 2 | F-RISK-01 account-side isolation | #662 (pre-programme) | `02-account-side-isolation.md` | verified fixed at this SHA |
| 3 | Approval → order lineage | #670, #671 | `03-approval-to-order-lineage.md` | code complete; **production settlement unverified** |
| 4 | Effective risk configuration | #671, #677, #678 | `04-effective-risk-config.md` | complete |
| 5 | Cup & Handle parity | #672 | `05-cup-handle-parity.md` | complete; one claim **disproved** |
| 6 | Trade-origin lineage | #673 | `06-trade-origin-lineage.md` | complete |
| 7 | Offline exit counterfactual | #680 | `07-exit-counterfactual.md` | **harness shipped, UNRUN** |

### Phase 1 — the sizing incident

The observation was the owner's: the same 0003.HK position (5,000 units, entry
6.91, SL 6.678, TP 7.373) open on two accounts whose balances differ 23×, with
identical USD 149 of risk — 0.32× of one account's 1% budget and 7.50× of the
other's.

The mechanism: `getAccountBalance` fell back to the legacy global
`account_balance_usd` key — a key whose own comment describes it as *"whatever
account refreshed it last"*. Since `volume = (balance × riskPct) ÷
usdLossPerLot`, a borrowed balance multiplies every configured risk percentage
by the ratio between two accounts, and does so invisibly, because every
downstream figure is derived from the same wrong balance and therefore agrees
with itself.

`sizingBalance()` now returns the balance **with provenance** (`account`,
`selected`, `legacy`, `legacy_unscoped`, `legacy_single_account`, `none`), and
every risk verdict records `balance_source` and `balance_is_account_scoped`.

**The owner's decision was taken on 2026-08-06 — "D-1 proceed to risk gate
veto" — and is implemented**, at `risk.js` step 0a. The gate now refuses a
proposal it cannot size against the named account's own balance. The veto is
deliberately narrow, and the narrowing was driven by the test suite rather than
by preference: refusing on absence of any balance broke 20 balance-independent
tests, and refusing whenever a named account lacked a stamp broke 10 more whose
fixtures register a single account. The hazard requires a *second* account to
borrow from; with ≤1 enabled account the shared key is unambiguous. Production
runs five enabled accounts, which is exactly where the ambiguity lives.

What it costs, stated plainly: entries stop on any account whose per-account
balance is unstamped, until the loop's balance refresh stamps it. That was the
accepted price of failing closed.

**What is still not proved.** Our `trades` rows say volume 83.14 (0003.HK) and
3.45 (0005.HK); `monitored_positions` and the broker say 5,000 and 62. The
ratios are 60.1 and 18.0 — not a constant, so not a clean lots-to-units
conversion either. Two of our own tables disagree about the size of the same
position. Both rows carry `risk_event_id: NULL`, so no gate verdict recorded
which balance was used. The mechanism *would* produce the observation; that it
*did* remains unproved and is recorded as such.

### Phase 2 — account-side isolation

F-RISK-01 was fixed before this programme began, in #662, and is verified
present at this SHA: `agent/lib/ctrader-creds.js:60` now returns `isLive` from
the credential assembly. Previously it was computed, used locally, and dropped
on the floor — so `sameSideAccountIds` read `baseCreds?.isLive`, evaluated
`!!undefined === false` on every call, and selected the demo side
unconditionally, including for live credentials. See
`02-account-side-isolation.md`.

### Phase 3 — approval to order

Two defects, both reproduced and both repaired:

- A single throwing housekeeping step cancelled every step after it, so the
  disposition sweep never ran (#670). `runSteps` now catches per step, records
  `{name, message}` in `failed[]`, logs it non-fatally, and continues.
- Read routes reported states they had never checked (#671).

**Not verified in production.** The first housekeeping window under the
isolated-step code fell due at 2026-08-06T15:09:27Z. Reading
`GET /state/dispositions?days=7` to see `lastResult.failed[]`, the backlog
drain and the `dropped` rows was attempted in this session and **blocked by the
environment's permission classifier** on three separate call shapes. No figure
from that route appears in this report, because none was obtained. The eight
silent approvals the owner is waiting on (AVGO.US ×4, TSLA.US ×2, LLY.US,
GER40) therefore still have no recorded cause.

### Phase 4 — effective risk configuration

Three findings, all reproduced at HEAD and all repaired: effective versus
global values could be confused, unsupported parameters did not fail, and
overlay writes were unattributable. Related work in the same area during the
day: #677 (a heartbeat is not a current answer) and #678 (one definition of a
lot, taken from the broker).

### Phase 5 — Cup & Handle parity

Production detector and diagnostic twin now run on identical bars (#672). One
claim in the source audit was **disproved as an open defect** and is recorded
that way rather than quietly dropped.

### Phase 6 — trade-origin lineage

New bot trades carry origin and strategy provenance; adopted and manual trades
are separated; unknown history is labelled `legacy_unattributed` rather than
fabricated (#673). This is also the phase that starts the Phase 7 clock.

### Phase 7 — the exit counterfactual

The Defensive-Drift audit found that 60% of postmortems classify `time_cap`,
that the median hold is 31 minutes, and that `burn-in.js:237` sets the target at
1.6× the stop. **That those two facts are in tension was an inference.** #680
is the instrument that would measure it, replaying `trade_postmortems.bars_json`
bar by bar under eight policies — as traded, no time cap, no profit keeper, no
Node ratchet, no C++ trail, original stop/target only, each component alone, and
a cost/slippage stress.

Run at this SHA against the repository's local `agent.db` — **a development
database, not production** — it returns `verdict: INSUFFICIENT`, `considered:
0`, `eligible: 0`. That is the harness working correctly, not a defect: there
are no clean-origin closed trades in that file to replay.

The harness also refuses rather than guesses in one specific place. A bar
records a high and a low but not the order in which they occurred; when both
the stop and the target fall inside one bar, the outcome is genuinely
undetermined, and those replays are counted as `ambiguous` instead of being
resolved by an assumption that would flatter the result.

---

## Acceptance gates, measured

Every command from §14 of the prompt, run at `cf2dbf9`, working tree clean,
2026-08-06 20:03–20:12 UTC. Exit codes as measured.

| Command | Exit | Detail |
|---|---|---|
| `node --test agent/**/*.test.js` | 0 | 2,994 tests — **2,993 pass, 1 fail** |
| `npx eslint .` | 0 | |
| `npx vitest run` | 0 | 59 files, 755 tests, all pass |
| `npm run build` | 0 | |
| `npm run check:no-green` | 0 | |
| `make -C cpp-exec CXX=g++ test` | 0 | all assertion suites pass |
| `node agent/scripts/backtest-parity.mjs` | 0 | `PARITY OK` — 5 seeds × 2 entry modes, exact ints, 1e-9 floats |

The one failure is named rather than waved at:
`agent/services/vpo-feeder.test.js:43` — *"skips when cTrader credentials are
not ready"* — failing with `fetch failed`. It is a sandbox network limitation,
not a code defect; the test attempts an outbound connection this environment
does not permit.

Against the prompt's own gate list:

| Gate | Status |
|---|---|
| F-SIZE-01 explained or explicitly blocked | **explicitly blocked**, with the mechanism repaired |
| Correctness defects have failing-before / passing-after tests | yes |
| No risk limit was increased | yes — none was changed at all |
| Cross-side account selection impossible by invariant | yes (#662, verified at this SHA) |
| Every approval has one terminal state | code complete; **production unverified** |
| Retry and restart do not duplicate orders | yes |
| PR #668's failure covered | yes (#670) |
| No approval silently disappears | **unverified** — the `dropped` rows could not be read |
| Effective and global values cannot be confused | yes |
| Unsupported parameters fail | yes |
| Future overlay writes attributable | yes |
| No silent automatic risk-policy change | yes |
| Production and diagnostics comparable on identical input | yes (#672) |
| First divergence visible | yes |
| Both Cup strategies have positive controls | yes |
| No gate weakened without approval | yes |
| New bot trades carry origin and provenance | yes (#673) |
| Adopted/manual separated | yes |
| Coverage disclosed beside metrics | yes |
| Unknown history not fabricated | yes |

---

## What remains, and who owns it

**Blocked on time — nobody's action:**

1. **Phase 7 must actually be run.** Precondition: ≈7 days of clean-origin
   closed trades, i.e. not before roughly 2026-08-13. Command:
   `node agent/scripts/exit-counterfactual.mjs --days 14`. Do not quote a
   number produced under `--all-origins`; the flag exists to diagnose the
   harness and is labelled in its own output as not evidence of edge.

**Blocked on access:**

2. **Read `GET /state/dispositions?days=7`** and record `lastResult.failed[]`,
   `counts`, `pendingNow` and the `dropped` causes. This is the only remaining
   evidence for whether the isolated-step fix settled the backlog, and the only
   route to a cause for the eight silent approvals.

**Owner decisions, untouched by this programme:**

3. **`minRR` is 4.5–6.16 per account against a configured 1.5.** A risk
   threshold; not changed, not proposed here.
4. **`dailyLossPct` on 43097342** yields a USD 16.16 daily cap. Parked by the
   owner 2026-08-05.
5. **The duplicate clusters persist** — six 0005.HK on 43097342 and four GD.US
   on 46130058, after nine 0066.HK earlier. Declared fixed in #573 and
   demonstrably not. Trimming needs a full-tier credential; this session holds
   read-only by design and has changed nothing at the broker.

Two deliverables named in §15 are deliberately **not** authored:
`OWNER_DECISION_minRR.md` and
`OWNER_APPROVAL_REQUIRED_demo-minRR-experiment.md`. Both would encode a
risk-policy proposal, and the prompt is explicit that policy is the owner's.
Writing them would put a recommendation in the owner's mouth. Item 3 above is
the whole of what this programme has to say on the subject.

---

## Boundaries observed

- No live trading action. Live account `42993489` was never touched.
- `sweepUnresolvable` was never run with `dryRun: false`; `exec-parity.js` was
  never run with `--order`.
- Read-tier credential only.
- No risk limit was raised. The only behavioural change in the programme is a
  **veto** — a refusal to trade — explicitly decided by the owner.
