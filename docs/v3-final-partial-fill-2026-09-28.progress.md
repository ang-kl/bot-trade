# V3 completion progress

Version 1.0 - 28 September 2026. Append-only.

## 2026-09-27T22:42:10Z - Execution, stage 5/6

Owner approval covers resolving and merging #1169/#1170 with passing CI and
their Railway deployments. #1169 merged as 4f8cbac5fd10729528320adb0dce891edf7c65ba;
Node deployment be08d6ed-a445-4885-a306-5214826e7905 succeeded. Authenticated web
and agent versions agree. Following startup recovery, 40 controllers were
healthy, one retired and one idle; all 26 positions across seven accounts were
broker-protected in the fresh audit. Transient cashflow/reporting deadlines and
the 129-second first loop are retained as performance evidence, not erased by
the later healthy reading.

#1170 conflict resolution 410604adcf46189033c48d8d387de7ccd0ccceeb has the exact
reviewed combined tree 363428d244e26e3579891cc9b5a1da14cac99ef7. Application and
scanner CI passed. Execution build/unit tests passed; ThreadSanitizer remains
in progress. The review wrapper succeeded but its review action was skipped.

Flow check: the requested remaining lifecycle defect is in the continuation
scope. New positive regression fails at `entry fill evidence mismatch`, proving
that final smaller fills cannot bind. A new negative fixture's absent plan
table assertion was corrected; no existing assertion was weakened. Next:
implement exact terminal-order plus subsequent-snapshot proof and rerun gates.
No further production release, broker action or scanner configuration is implied.
Timeline: release gates in progress; market-session acceptance is calendar-bound.

## 2026-09-27T22:58:57Z - Release gate, stage 6/6

#1169's squash created a second CLAUDE history conflict. Resolution aaf3d7b48e4fcf9c4d46455f8128b62ac5585921
records main 4f8cbac as a parent and keeps the exact same verified file tree
363428d244e26e3579891cc9b5a1da14cac99ef7. Application run 36356489638 and scanner
run 36356489618 passed. Execution run 36356489604 passed build, unit tests,
ThreadSanitizer and Node delegation. No open review threads were present; the
automated review action was skipped, so no independent review is claimed.
Next authorised action: merge #1170 with an expected-head guard, then verify
Node, cpp-exec and cpp-acct deployments and fresh account protection.

The separate local completion now has atomic TP1 enrollment/reservation
settlement, terminal order/deal identity and volume proof, and a subsequent
account-owned snapshot. Restart and forced-write rollback checks pass. Review
also reproduced and fixed a changing-volume race between the two reads.
The backend full run was interrupted when its process disappeared, with no
terminal summary; it is not a pass and will be rerun. Lint, 1,311 frontend
tests, build and colour gate passed before the final one-line race correction;
affected checks will be rerun. Original existing tests remain unchanged.

Production observations before the code release: seven active account engines,
26 positions protected, all services reachable in independent receipts.
Scanner comparison retained 28,678 contract rejections and 201 input gaps;
the timeframe service reported zero work items. Current process sample at
22:54Z recorded a 678-ms maximum scan-phase event-loop delay and 439-ms
decision-audit delay. These are Node samples, not browser LCP/CLS. Browser
capability discovery exposed no performance tracer. Two bounded read-only
automation schedules cover the later load/US-closed observation windows;
point samples will not be presented as continuous acceptance-harness evidence.

## 2026-09-27T23:15:26Z - Final review and evidence, stage 6/6

The named release is complete: #1170 merged as
1a0d34429f80db95c4476defe615b05961fbfa12 after final CI. Main's tree matches the
CI head exactly. Its Node, demo gateway and live gateway deployments succeeded.
Fresh post-boot UI receipts cover seven accounts and all 26 protected positions;
native health reads confirm four demo and three live connections, recording in
shadow mode and tick placement false. See v3-production-readback-2026-09-28.md
and its sanitised performance JSON for deployment IDs, observation times,
retained startup failures, current scanner mismatches and later-session plans.

The complete backend rerun passed: 30 latency + six hygiene + 7,147 main-group
tests = 7,183 passed, four skipped, zero failed; private TMPDIR empty. This was
before the last fairness correction. The additional local skip is native/JS
backtest parity because this isolated worktree has no compiled native binary;
the named release's execution CI passed separately. No skip is counted as a
pass. Changed-source ESLint passed.

Self-review then found that the one-order read budget could always return to
the first unresolved partial. A real two-order database regression reproduced
starvation (only order 900 was read across two passes). The new fixture's wrong
pending-order column was corrected before that reproduction; no existing test
was altered. Per-database least-recently-read turns now rotate the bounded
order-details investigation. It still allows only one extra investigation per
pass, with the existing per-intent interval and bounded transports.

All 19 focused lifecycle tests and changed-source ESLint passed after that fix.
The final full backend gate is running on the final implementation. Frontend
tests (1,311), build and colour check already passed; the subsequent changes
affect only the backend reader and its regression, so those unrelated gates
were not rerun. Whitespace checks passed. No independent review is claimed.

Flow check: source paths remain within the stated local completion scope.
Risk/size/caps, immutable proposals, account routing, broker protection and
single-owner TP1 handover are preserved by the focused checks. Natural final
fills, unsupported off-grid averages and tiny fills needing another broker
target remain separate production evidence/boundaries. No production write,
new push or scanner/account mutation was performed for this follow-up.
Next: finish the final backend gate, append the handover and commit locally.
The historical 05:00 readiness target remains missed; full V3 acceptance is
open and later-session evidence is calendar-bound.

## 2026-09-27T23:20:37Z - Local handover, stage 6/6

Final backend gate completed with exit 0 on the final implementation:
30 isolated latency + six hygiene + 7,148 main-group tests = 7,184 passed,
four skipped, zero failed; private TMPDIR empty. Main-group duration was
379,325.784 ms. The four skips are native/JS backtest parity and three native
scanner integration cases requiring binaries absent from this worktree.
No threshold or existing assertion was relaxed. Full-run output is retained
locally as /tmp/v3-final-partial-release-gate.log. Commands for reproduction:
`node scripts/run-agent-tests.mjs`, `npx vitest run`, `npm run build`,
`npm run check:no-green`, and ESLint on the six changed JavaScript files.
The unchanged frontend/build/colour results and final changed-source lint
remain as recorded above. Whitespace checks pass.

The follow-up is ready as a local commit on main 1a0d344. It proves exact
terminal-order/deal identity and executed volume, requires a subsequent fresh
account-owned snapshot, recalculates the final-volume plan without changing
original risk or costs, and atomically enrolls TP1 before settling the exact
reservation. Failure, ambiguity, a newer remainder, ownership conflict and
forced write failure retain the conservative reservation. Read turns are fair
and bounded. Natural broker final-fill/partial-close acceptance remains
Not Verifiable; no order was manufactured for evidence. Unsupported tiny or
off-grid cases remain refused rather than silently adopting a wrong target.

Both merged PR descriptions now carry dated release checkpoints, while
preserving their historical descriptions. This is metadata for the already
approved release, not publication of the additional code. This worktree has
not been pushed, merged or deployed. Publishing it as a new draft PR for CI
and review needs fresh scoped approval under the uploaded CLAUDE.md.

INVARIANTS REPORT: exact identity/finality/freshness, integer volume,
unchanged original proposal/risk/costs, atomic ownership/TP1/reservation
handover, rollback/restart safety and bounded fair reads Passed in the stated
local checks. Named release CI/deployment/fresh protection Passed at the
recorded production checkpoints. Scanner feed/profile alignment Failed.
Full browser traces, future graded sessions, natural new-lifecycle execution
and empirical V3 qualification remain Not Verifiable. No new risk setting,
account/profile selection, credential access or broker mutation occurred in
the follow-up. Local evidence gate met; additional publication and full V3
acceptance remain open. The missed 05:00 target is not relabelled as met.
