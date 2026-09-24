# V3 active-pipeline checkpoint - 24 September 2026

## Scope and authority

Continuation of revision 3, not a strategy redesign. Starting main:
`4dd6625c0b78e1012e3465781636ee33e28da580` (#1066). Read alongside
`performance-cards-reassessment-2026-09-22-revision-3.md`, the acceptance
sequence and CLAUDE.md. Historical-money repair is outside this change.

The owner supplied a Tune screenshot showing global Scan, Analyze and
Autotrade ON, Armed combos only and Strategy Autopilot auto. Do not repeat the
superseded claim that the master switches are OFF. The screenshot is UI
evidence; current per-account stored overrides still require authenticated
readback. No switch or broker action is authorised by this checkpoint.

## Demonstrated finding

The current `agent/config/strategy-pins.json` records the 20 September
intraday retirement: `_all` empty, 12 ordinary strategies in `_off`, and the
`tsmom_long` trial on account ending 0058. Seed-once declarations are not a
fresh copy of current overrides. `agent/lib/entry-producers.js` separately
retires scan_dispatch, closed_market_limits and pending_fib_orders. The
unchanged `admitEntry` fence refuses a retired producer regardless of the UI
switches. Manual entry paths and tick-entry validation are separate.

Production Node deployment `ce192cba-0169-48b2-9874-5412c001ce3b` reports the
#1066 commit. In the 08:49-08:52 UTC window, sampled Stage gate logs name
fib_confluence, donchian_breakout, vwap_trend, ema_pullback, vp_value and
rsi2_reversion as OFF. At 08:51:59.931Z the decision audit reports 4,720 FX-day
upstream decision records, dominant category stage_matrix:strategy, none
reaching the risk gate. This is not 4,720 independent opportunities, and a
dominant category does not prove all records have that reason.

The separate momentum-book log at 08:51:58.933Z says six accounts considered,
one ran, five not armed, zero entries/exits/trails. That proves work was
attempted on one account, not why the active account had no new entry. The
full daily cursor, holdings, scope and current gate response were unavailable.
Do not infer a broken momentum strategy or require a forced trade.

## Read-model defect and bounded correction

`/state/trade-gates` reused nine configuration checks but omitted structural
producer retirement. With all switches ON it could count a retired ordinary
path as tradable and suggest more toggling. This disagreed with the unchanged
entry fence.

Add producer availability to this existing read-model, ahead of the switch
checks. Retirement and reasons are read from the canonical ENTRY_PRODUCERS
inventory. Ordinary registry families describe scan_dispatch; the momentum
family describes the daily/account and cross-sectional book paths. Missing
or ambiguous inventory and unmapped families report unknown, not available.
This is explicitly scoped to automatic bar configuration. It does not claim
manual/tick readiness, current account risk approval, or a positive strategy
record. All original switches remain visible and configurationOpen is reported
separately. No permission or admission function reads this report.

No changes to order producers, strategy pins, risk, account modes, filters,
thresholds, broker calls, historical amounts or schema. No new polling loop,
DB scan, endpoint or UI layout is introduced. The existing Tune consumer reads
the corrected tradable count and first-blocker reason.

## Verification and release

Local focused tests run the pure helper with controlled inventory fixtures.
The original resolver and original test bytes were checked against GitHub
blob SHAs before modification. The container cannot resolve github.com for a
checkout, so full integration checks must run in GitHub Actions, not be claimed
from local simulations. The revised nine-switch regressions use the surviving
momentum path; additional tests reproduce the real retired-path false-positive,
compare against admitEntry, and assert the read-model does not write state.
No C++ code changes; unchanged native results need not be rerun arbitrarily.

Merge only after the full repository gate and review. Current Node source
tracks main; a merge can deploy/restart Node even though this is reporting-only.
Do not mistake a draft PR for a runtime release. Confirm current production
protection and applicable release approval first. Do not restart a gateway,
change master flags or run a live order to test a report.

Runtime readback after an authorised release needs only one authenticated
`/state/trade-gates` response and the existing Tune view: retired ordinary paths
must identify producer retirement; surviving momentum remains subject to its
actual account/configuration and runtime risk checks. Stop this readback after
those outputs or a specific access failure. Rollback restores the previous
Node code/read-model; no DB migration or monetary rollback is required, and
rollback must not alter strategy permissions.

## Remaining acceptance, not hidden behind historical P&L

- Protection: latest inspected receipts at 08:51:26-28 UTC cover seven
  accounts/32 positions, all with SL and two lacking TP1. Position-specific
  decisions remain required. The earlier verification gap and load latency
  need attributable evidence; profile samples are not broker-confirmed p99.
- Watchdog: calendar/completed-work and delivery/backlog state need current
  authenticated readback. Independent Telegram/outage trials require their
  exact approval and external observer; local tests are not production drills.
- Scanners: both new feeds remain unchanged. Exact profile parity, a scoped
  observation-only load trial and protection isolation remain acceptance work.
- Tick: existing gateway shadow is not new-scanner activation or trading
  readiness. Preserve the 48-hour/sample/quality thresholds and reuse eligible
  retained evidence rather than resetting it.
- Roster/storage: current policy intent and durable cpp-acct recorder storage
  remain separate decisions. Do not create a volume or change accounts here.
- History: AVY and GEV each have two local lifecycle claims. No selection,
  merge, deletion, historical import or P&L adjustment was performed.

Access limitation: Railway read tools exposed deployment/configuration/logs,
not SQLite SQL or authenticated application response bodies. HTTP 200 log
lines do not establish the response values. The delegated Railway summary was
cross-checked against its tool records; unsupported claims of complete state
or exact blocker distribution were not adopted. Do not repeatedly invoke the
same unavailable access, extract secrets, or create new reports merely to
replace an existing authenticated endpoint.
