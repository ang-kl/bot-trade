# V3 verification follow-up - 28 September 2026

This is a dated evidence record, not a change to an approved specification.
Times below are UTC unless labelled SGT. The owner's reported Astra Ultra
setting is not independently verified and does not count as product evidence.

## Authority and release identity

The owner instructed V3 continuation, production/scanner verification,
final partial-fill completion, performance traces and market-session evidence.
The latest "proceed" continues local fixes and read-only verification.
The explicit named approvals for #1169, #1170 and the `ed142c3` release were
already completed. They do not publish the new changes described here.

- GitHub main at the 00:00 refresh: `41aa2cb2e9c6a4379b42a7d13482b72bfa110ace`,
  merged #1171. Approved release tree: `16549b110dd42d64345066766e8c20ec6b30d36b`.
- Node deployment: `e6106ccd-3c1f-4705-8d88-4cdb61a9fcc5`, successful. All six
  Railway services reported successful deployments; native deployments were
  unchanged by #1171.
- Local starting head: `f098b31`, an unpublished documentation checkpoint on
  top of main. The new runtime changes remain local pending scoped approval.
- No broker order, account selection, registry/configuration change, push,
  merge or deployment was performed in this follow-up.

## Local corrections and invariants

### Final partial fill after an earlier adoption

The earlier release proved a terminal partial fill when the local adopted
volume already equalled the final broker volume. It missed the realistic
sequence of 2,500 units adopted, another 2,500 units filled, then remainder
cancelled. The generic reconciler deliberately preserves an existing trade's
entry and volume. The later final proof therefore refused the 5,000-unit
position. A 2,500@97 plus 2,500@99 example also left the local entry at 97
while the final broker average was 98. Both were reproduced before repair.

The new proof requires an exact chronological prefix of opening deals from
the same order to explain the earlier local volume and entry. Equal-time
deals are grouped; array order cannot invent precedence. Only then may the
existing bind/enrol transaction refresh the exact owned trade, book and
paused-monitor anchors. The final plan and pending reservation settle in
that same transaction. The generic reconciler remains unchanged.

| Invariant | Evidence |
|---|---|
| Exact account/order/position identity and terminal broker proof remain mandatory | Existing lifecycle tests plus new prefix refusals |
| Manual changes, ambiguous prefixes and other owners are not reinterpreted | Twelve new refusal cases; each verifies validation was reached |
| Original proposal, risk event, initial risk and cost reserve remain fixed | Same-price and weighted-price regression assertions |
| First observed broker stop remains historical evidence | `broker_sl_initial` preservation assertion |
| No partially committed handover | Four injected write failures restore trade/book/monitor/intent/pending rows |
| Restart preserves the receipt and settled reservation | File-backed reopen regression |
| Off-grid averages stay refused | Existing conservative bracket contract retained |

The focused lifecycle file passed 23 tests, zero failures/skips. A separate
AI reviewer found no concrete proof bypass, ownership, rollback or unit
defect and ran the four added test groups. This is not external independent
verification. No natural production execution has been observed.

### Bounded legacy risk-event count

`countUnattributed(risk_events)` scanned retained history. The correction adds
only `idx_risk_events_unattributed ON risk_events(id) WHERE account_id IS NULL`.
An earlier account-keyed candidate was rejected because it changed the
actual route's tied-timestamp order and introduced a full account-history
sort. No scans or action-log index was added.

Three new regressions failed before the correction. After it, 25 focused
tests passed. Tests inspect the production helper's query plan and bytecode,
actual HTTP bodies, tied list order, retained rows, pre-account-schema
migration, attribution changes, retention, repeated reopen and WAL/FULL.

A file-backed synthetic 250,000-row database with 8,065 unattributed rows
measured NULL counts at 7.860-11.109 ms before and 0.166-0.234 ms after.
Index creation took 68.666 ms and allocated 102,400 additional bytes.
Deleting 46,800 rows then rolling back measured 176.555-200.581 ms before
and 177.712-204.468 ms after. Full row digests, scope outputs and list
results matched. These are local warm measurements, not production gains.
The companion JSON records the experiment.

## Production verification

At 00:02:33 the seven account rows refreshed after an intentional UI click.
Independent verifier receipts at 00:02:41-42 covered 26 positions across
the four demo accounts (3, 6, 5, 12); the three live accounts held zero.
All 26 had SL/TP. Forty controllers were healthy, one retired and one idle
after a transient cashflow warning cleared. Tick shadow was ready; tick
entry was blocked and accounts remained TIME_BASED with zero reserved,
in-flight or unknown submissions in the observed UI.

At 00:07:52.832 the all-account Performance view reported a running partial
manager, market/resting integration wired, and zero recorded plans.
This proves runtime wiring and an observation, not a natural final partial
fill, TP1 reduction or economic outcome.

The UI intentionally stops some polling after the configured inactivity
period, five minutes by default.
The observed rows were about eleven minutes old, within the server's
fifteen-minute freshness threshold, and refreshed on wake. A local harness
also reproduced a separate latent issue: a sleeping row can retain its
stored "fresh" label beyond that threshold. That production condition was
not observed; no UI change is included here.

## Scanner evidence and operational proposal

Read-only SQLite access used the authenticated Railway console with
`readonly:true,fileMustExist:true`, explicit non-secret keys and no database
initialisation. At 00:12:47.432 the registry remained 796 profiles with
revision `d1de0d9879cb83f66c321b1a8fbb7c5ea3ff08291495335c5a5e4afb812d1fe5`:
53 tick profiles each for old feed accounts ending 0058/9009 and 690
timeframe profiles for 0058. The bridge remained enabled.

Fresh health/tick caches at 00:16:20-21 showed actual tick feed accounts
ending 9908 (demo) and 3489 (live), both using profile hash
`967c1defd6e78d09`. The selected scan account was 9908. Source confirms that
an authorised existing gateway feed anchor survives account selection;
timeframe scanning instead follows the selected account. Strict comparison
identity checks are correctly refusing these mismatches.

The existing private proposal preserves all 796 profiles and adds 53 tick
profiles for each current feed account, producing 902. It passes the actual
registry validation, stale-revision refusal, bridge-on refusal and exact
rollback locally. Compact request size is 330,150 bytes, below 524,288;
`orderAuthority` remains false. Proposed registry revision:
`c3da37c4ff2c59864761e684d8b90a000b9bc4ca925491c6f1f9c7bbf63825e1`.

Coverage requires care. The stored universe has 56 unique names; direct
account maps resolve 53, matching the proposed symbol sets exactly. Direct
map misses are SPX500, USOIL and UKOIL. Source review confirms the tick
resolver has no alias conversion: these three names remain unresolved on
each fresh feed map. The effective 53-symbol set is not full coverage of
the declared 56-name universe. Demo had 58 subscriptions and a
quote-only count of five. The extra IDs were SHOP.US, JNJ.US, MRK.US, KO.US
and 0066.HK; none appeared in the recorder's per-symbol output at this
observation. Live had 53 subscriptions and no extras. Absence of events in
closed markets does not prove exclusion, and the quote-only count alone is
not set membership. Do not describe all 58 demo subscriptions as verified
scanner inputs. Acceptance requires exact registration for each actual
mirror identity, new timestamped valid observations, cursor/gap accounting
and no new contract rejects in the bounded observation window.

Applying the proposal requires a separately approved operation: disable the
Node bridge (restart), compare-and-set the exact 902-profile registry, then
restore the bridge (restart). Rollback disables it, restores the saved 796
profiles only if the revision still matches, then restores bridge state.
Stop on concurrent revision change. Gateway/scanner settings and trading
remain outside that operation. The 690 timeframe profiles remain mismatched
unless account selection is separately addressed. Selecting 0058 also
affects credentials, account activation and cleanup; it is not a view-only
switch and is not included in the tick-registration proposal.

## Performance and market-session limits

Persisted boot `1790552681751-13` began 27 September at 23:44:41.750.
The 00:14:56 readback preserves:

- First loop: 144,370 ms, complete at boot +159,596 ms; starting phase
  66,197 ms and scan phase 61,333 ms.
- First fast tick: 101,888 ms, complete at boot +114,713 ms, checked zero.
- First protection band: 19,357 ms, outcome false because pnl_watch and
  loss_cap exceeded their five-second budgets.
- First clean account audit: boot +100,694 ms, seven accounts.
- First slow monitor/equity stop/breakers: about boot +149 seconds.
- Completed fifteen-minute HTTP window: 2,343 successes, two 5xx and
  41 aborted responses. `/state/prices` returned 503; postmortems had one
  5xx. An aborted response is reported separately, not called an HTTP 5xx.
- Startup lag tap maximum: 58,220 ms at 23:45:57.443, phase `starting`.
  The separate 45,123-ms log sample is not the maximum.

Railway's scan CPU summary measured 61,328 ms, including 39,461.4 ms idle;
native get samples included 7,166.7 ms attributed to `countUnattributed`
and 1,788.7 ms to `scopeCoverage`. Phase-audit reads contributed 4,517.2 ms.
These locate synchronous work without explaining the entire startup stall.
The new index addresses only the first count. Other work remains open.

The approved OD-4 window is 28 September 13:30-16:00 UTC (21:30 SGT to
midnight), plus approximately 20:00-21:00 UTC (29 September 04:00-05:00 SGT).
The later approval supersedes older "pending owner" wording. Both owner
Desk and Performance tabs must be visible; goal-table polling remains off.
No unrelated merges after 13:00 UTC and no traces during the graded window.
Only the intended restart belongs in that window, subject to its scope.

Runtime `goal_table_json` was absent at the fresh readback. Consequently
the confirmation stamp is absent and first-loop/protection/report-5xx bars
still fall back to null defaults, despite the documentary OD-4 approval.
No target values or confirmation stamp were written in this follow-up.

Existing enabled hourly automations cover 21:30/22:30/23:30/00:30 SGT and
04:00/05:00 SGT. They provide point observations, not a continuous harness.
The GET-only harness requires a securely provisioned read token and a
surviving host. Neither continuous recording nor both owner-visible tabs
has been established by these checks. Browser capabilities available in
this session do not expose DevTools tracing; no substitute timing API or
alternate browser was used. CPU summaries do not prove LCP or CLS.

## Stage and release gate

1. Intent understood: met, continue the named V3 verification work.
2. Interpretation: met for the two local defects; no trading expansion.
3. Assumptions: no new owner decision is inferred. Existing approved intent
   covers local defect repair; publication/deployment remains separately scoped.
4. Invariants: mapped above to named tests and readbacks.
5. Execution: local fixes frozen, maker checks and a second review complete.
6. Evidence: local gates met as recorded below. Remote CI and the release
   gate remain open. V3 production/session/outcome acceptance is open.

There is no runnable `/flow-check` command in this checkout. The six-stage
assessment is manual and is not represented as execution of that command.
The previous target was missed; V3 closure remains late. No green CI,
healthy later sample or stronger model setting closes missing evidence.

## Completion checkpoint - 00:22 UTC / 08:22 SGT

Runtime source was frozen before the full gate. Final results:

| Command / check | Result |
|---|---|
| `node scripts/run-agent-tests.mjs` | Exit 0; 7,191 passed, four skipped, zero failed |
| Isolated latency group | 30 passed |
| Isolated hygiene group | Six passed |
| Remaining backend group | 7,155 passed, four skipped; 413,659.978 ms |
| Private test TMPDIR | Canary reached the directory; directory empty after full gate |
| `npx eslint .` | Exit 0 |
| `npx vitest run` | 1,311 passed in 136 files |
| `npm run build` | Exit 0; existing large-chunk advisory remains |
| `npm run check:no-green` | Exit 0 |
| `git diff --check` | Passed |

The four skipped checks require native binaries: C++ backtest parity, two
actual timeframe HTTP comparison paths, and real tick-oracle comparison.
They are not counted as verified. No native code changed in this increment.
An npm proxy-configuration warning did not fail the commands.

INVARIANTS REPORT: exact broker proof and lineage, manual ownership refusal,
immutable proposal/risk/costs, atomic final-volume handover and rollback,
restart receipts, unchanged HTTP list/scope outputs, retained database rows
and WAL/FULL settings passed the named local checks. Production behaviour of
these unpublished fixes, native skipped paths, scanner registration, natural
partial execution, browser traces and continuous session acceptance remain
unverified. The old startup failures are retained without downgrading them.

Next action is publication of this exact local candidate to a draft PR for
CI and review, only after the owner's scoped approval required by the
uploaded CLAUDE.md. A branch push is reversible by closing the draft/removing
the branch; it neither authorises nor performs a main-branch deployment.
