# P1/P4: isolate the measured postmortem report

Intent (continuing owner directive): dashboard loss-lesson reads must not block
position protection. #1076's production scan profile attributes 3,905.7 ms of
synchronous reads to postmortemStats; concurrent dashboard requests waited
6.3–6.6 seconds. The /postmortems handler executes history aggregates and its
pending-lesson report directly on the management connection.

Interpretation: preserve the successful response and current account/null-row
semantics, but run rows, stats and pending as one read-only snapshot in the
existing bounded report worker pool. Report failure becomes explicit HTTP 503,
never a fabricated empty result or a synchronous fallback. Existing worker
capacity, watchdog reservation, response-size and timeout bounds remain.

Scope: agent/routes/state.js, a new postmortem-report service, the report worker
dispatch, an opt-in strict read in loss-postmortem.js, behavioural route/worker tests, this contract and closure/serial notes.
No historical data correction, broker call, trading configuration or native
service change. This source fix does not close broader V3 load acceptance.

Invariants: exact successful row/stat/pending values and ordering, account
scope preserved, broker/trade timestamps retained, no report-history reads on
the management connection, unavailable evidence returns 503, worker reads make
no writes and do not take the watchdog's reserved slot. Test real disk workers
and HTTP, foreign/null/orphan/rejected rows and an unreadable worker database.

## Focused evidence

The original HTTP path fails the new regression: it reads report history on
management and returns success on an unavailable worker file. After correction,
all three disk-backed HTTP cases pass: account/null/orphan/rejected populations
and bars, explicit worker-file failure, and timers advancing during a locked
history read. The existing loss-postmortem suite is unchanged: 36 combined
focused tests pass. `pendingLessons(strict:true)` propagates database failure
for this reporting path; its existing callers retain their previous default.

#1076 subsequent runtime readback at 16:55:14.835Z: a NEW protection band
completed at 16:55:05.384Z in 3,178 ms, no overrun or skipped band. Seven broker
receipts at 16:54:43.664–45.073Z covered 32 positions, no missing SL/TP. Entry
configuration matched preflight exactly. Account report browser elapsed 323 ms.
This is a passing routine sample, not production percentile/load acceptance.

## Release gate and foundation readback — 17:07 UTC

The final combined source (`c36430e`, including #1077) passed 5,502 backend
tests (28 isolated plus 5,474 remaining; four existing native-environment
skips), 943 frontend tests with two workers, full ESLint, production build,
no-green, control inventory and whitespace checks. Exact-head CI run
36031261376 passed at 17:04:42Z; review also passed and merge state was CLEAN.
This documentation update still requires its own exact-head CI before merge.

#1077 merge `8bcb708` deployed successfully as
`1d0fafae-df75-4281-80cf-1b261e3abddb`. DB initialization was 654.04 ms and
the service listened at 17:03:01.252Z. The account report took 81 ms in the
application / 454 ms in the browser. Its first full loop was 125,069 ms;
startup/load acceptance remains open. At 17:07:49Z, all seven fresh broker
readings covered 32 positions with no missing SL/TP; the new protection band
completed in 1,830 ms without overruns or skipped bands. Account phases and
entry mode/revision/epoch/policy matched preflight exactly. No producer invokes
the new target policy or partial manager yet; this release did not activate it.
