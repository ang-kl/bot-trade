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

## 2026-09-27T23:35:24Z - Approved draft publication, stage 6/6

The owner approved pushing ed142c3 to a draft PR for CI and review. The
approved commit is ed142c37e0c3f7ea04a889ac3618a9778fe95ab9, tree
16549b110dd42d64345066766e8c20ec6b30d36b, parent main
1a0d34429f80db95c4476defe615b05961fbfa12. Local source was clean at preflight;
GitHub main still matches the parent and no matching open draft existed.
Git CLI could not obtain a password. Publication uses the authorised GitHub
connector; its commit metadata may differ, but the complete remote tree must
equal the approved tree before the draft is opened. This checkpoint remains
local so that publishing the approved tree does not silently add new files or
edits. No merge, deployment, risk/account/profile change or broker action is
authorised by this publication approval. Next: publish, read back the exact
tree, open draft, inspect CI and actual review execution. Existing local gate
remains 7,184 passed/four skipped; remote CI is not yet verified.

## 2026-09-27T23:41:19Z - Conditional merge authorised, stage 6/6

Draft PR #1171 is open at e6688d58d26b61e624a0141ba698e55a71a7bda1. GitHub readback
and a fetched local diff confirm its complete tree is identical to approved
source ed142c3, with the same parent. The API publication changed only commit
metadata. The owner then instructed "merge if ready" at 07:38 SGT, extending
the task through the conditional merge and its automatic Node deployment.
This supersedes the draft's earlier publication-only scope for this PR.

Application CI run 36359325227 passed lint and is running backend tests.
Review job 108733209288 skipped the reviewer because its configured API key
is absent; a successful wrapper is not a review. No reviews or inline threads
are recorded. Native workflows do not match this PR's paths, as checked in
their existing filters. Repository merge policy requires the local quality
gates and passing PR CI/clean mergeability; it does not make the optional
review wrapper a substitute for evidence or require that skipped step.

Pre-merge production readback remains 1a0d344, with receipts at 23:40:05 UTC
for seven accounts and all 26 positions carrying SL/TP. All six Railway
deployments report success. Only Node is expected to redeploy from these
changed paths; no unrelated staged configuration will be applied. Next: await
final CI, recheck the head/base and review state, mark ready and squash-merge
with an expected-head guard, then verify fresh post-boot production evidence.
Reversal is a code revert followed by another scoped release, not a broker
transaction. Risk/account/profile settings and broker actions remain outside
this operation. No full V3 acceptance is implied.

## 2026-09-27T23:43:31Z - Final PR gate met, stage 6/6

Application CI 36359325227 completed successfully on published head
e6688d58d26b61e624a0141ba698e55a71a7bda1: backend/frontend suites, lint, build,
colour and syntax checks all passed. GitHub main remains 1a0d344; #1171 is
mergeable with clean status. No submitted reviews or inline threads exist.
The optional reviewer remains skipped, not independently verified. The source
tree is still exactly the approved ed142c3 tree. The owner's conditional merge
instruction now reaches its required local/CI/mergeability gate. Next action:
mark ready, squash-merge with expected head e6688d5, and verify the resulting
Node deployment plus fresh account/protection readback. No settings or broker
operation is added to this release.

## 2026-09-27T23:49:31Z - Merged and deployed handover, stage 6/6

#1171 merged at 23:44:06 UTC as 41aa2cb2e9c6a4379b42a7d13482b72bfa110ace using
the expected e6688d5 head. API readback and fetched origin/main both retain
the exact approved tree 16549b110dd42d64345066766e8c20ec6b30d36b. The local
ed142c3 versus origin/main content diff is empty. Full PR CI 36359325227 passed;
optional review job 108733209288 skipped the reviewer for its absent API key.
No review or inline findings were recorded. No independent review is claimed.

Railway Node deployment e6106ccd-3c1f-4705-8d88-4cdb61a9fcc5 succeeded, booting
at 23:44:42 UTC. The other five services correctly skipped redeployment and
retain their successful runtime deployments. Startup logs preserve all eight
risk overrides, seven account settings, 91 strategy pins and existing arming.
No unrelated staged Railway configuration was applied.

Startup was slow: 45,123-ms event-loop delay, browser-control timeouts,
temporary protection-band/cashflow warnings and a 144,370-ms first loop. At
07:47:48 SGT, web and agent agreed on 41aa2cb; 40 controllers were healthy,
one retired and one idle. Broker receipts at 23:47:00 UTC covered all seven
accounts and all 26 positions with SL/TP. These receipts follow the new boot.
The warnings recovered before that readback; startup delays remain evidence
and are not relabelled as a performance pass.

Scanner observation collection remains active, with 102,522 retained tick
contract rejections at 23:47:44 UTC and the existing timeframe account/profile
mismatch. The bounded retention counters are not a complete event history.
No scanner/account/profile setting, credential or broker mutation was sent by
the release verification. The later-session read-only schedules remain in
place; no PR-specific wakeup was created. The GitHub PR description now
records source identity, final CI, merge and production readback.

INVARIANTS REPORT: approved file tree, full local/PR quality gates, clean
guarded merge, successful scoped deployment, retained settings and fresh
seven-account broker protection Passed at the recorded checkpoints. Actual
scanner alignment Failed. Independent review, natural final-fill/TP1
execution, full browser traces, graded session/holdout evidence and empirical
V3 qualification remain Not Verifiable. The authorised publication, conditional
merge and deployment verification are complete; full V3 remains open.

Post-merge cleanup: unsubscribed from #1171 through the authenticated GitHub
UI; the control changed to Subscribe. No PR-specific wakeup existed to clear.
The broader V3 read-only session checks remain scheduled.

## 2026-09-28T00:10:00Z - Later opening-fill correction, stage 5/6

The resumed adversarial review found a concrete completion defect in merged
41aa2cb: when a 2,500-unit partial was adopted before another 2,500 units of
the same order filled, the final 5,000-unit terminal order/deal/snapshot proof
was refused against the stale 2,500-unit local trade. Generic reconciliation
intentionally preserves an existing fill record. A weighted later fill also
leaves the trade/book/monitor entry anchors at the earlier price; a volume-only
repair still fails ownership. Both behaviours reproduced in isolated tests.
The existing 19 lifecycle tests passed unchanged. These are deterministic
fixtures, not natural broker execution or independent review.

The owner continuation authorises local correction within the existing final
partial-fill intent. New behavioural regressions cover coherent earlier
adoption, weighted later fills, unproven/manual and ambiguous growth, ownership
changes, and rollback of every changed anchor. The positive later-fill and
forced-write regressions are red before source changes. Scope remains the
final-fill evidence module, entry contract and corresponding lifecycle tests;
the generic reconciler, original proposal/risk/costs and broker operations stay
untouched. The repair will prove an unambiguous same-order opening-deal prefix,
then atomically refresh only its owned local fill anchors before normal TP1
handover and exact reservation settlement. Next: implement, run the focused
suite and changed-source lint, then return the diff for root review/full gates.
No commit, push, merge, deployment or production mutation is authorised here.

Timestamp correction, measured 2026-09-28T00:07:51Z: the immediately preceding
checkpoint's 00:10:00Z heading was entered incorrectly. The entry was written
before this measured time, not at 00:10. Its reported test results and scope
are unchanged; the erroneous future timestamp is not completion evidence.

## 2026-09-28T00:12:09Z - Later opening-fill correction review, stage 6/6

The local correction now proves the earlier trade volume and entry from an
unambiguous chronological prefix of the same terminal order's opening deals.
Deals sharing a broker timestamp are grouped; their array order and IDs do not
invent chronology. The original complete terminal-order and subsequent fresh
account snapshot checks remain. A smaller local volume alone never authorises
a refresh, and the existing manual/unexplained volume regression is unchanged.

Within the deferred bind/enroll transaction, prior book/paused-monitor ownership,
initial risk and coherent bracket anchors must agree before exact-account
compare-and-set updates refresh the trade volume/entry and book/monitor fill
anchors. TP1 registration and reservation settlement remain in that same
transaction. Failure at the trade, book, monitor or reservation write restores
all earlier rows. The receipt records the earlier volume, entry and opening
deal IDs once; restart and repeat passes retain it. The immutable proposal,
risk event, numerical initial risk, costs and first observed broker stop remain
unchanged. No generic reconcile or broker-operation implementation changed.

All 23 focused lifecycle tests passed, zero skipped or failed, in 7,099.132 ms;
log /tmp/v3-later-fill-focused.log. Changed-source ESLint and whitespace checks
passed. The existing fairness test's future simulated clock initially skipped
new fixtures sharing synthetic IDs; only the new fixtures received a monotonic
clock, and refusal cases now assert that validation was actually reached. No
existing test assertion was changed. Full-suite/CI and natural broker execution
remain unverified for this local correction. Next: root source review and full
release gates. No commit, push, merge, deployment or settings change was made.

INVARIANTS REPORT: same-order prefix identity, terminal finality/fresh snapshot,
manual/ambiguous growth refusal, unchanged risk/cost/proposal, atomic ownership/
anchor/TP1/reservation writes, forced rollback, restart receipt immutability and
bounded-read existing regressions Passed in the stated focused tests. Natural
broker execution and full release gates are Not Verifiable at this checkpoint.

## 28-09-2026 00:22 UTC / 08:22 SGT - root verification handover

Stage 6/6 Evidence: local gate met; remote release and V3 acceptance open.
The reviewed later-opening-deal repair is frozen with the narrow NULL-risk-row
index correction. Full backend gate exited 0: 7,191 passed, four native-binary
dependent skips, zero failures; 30 isolated latency checks and six hygiene
checks are included. The test canary reached its private TMPDIR and the full
gate left that directory empty. Frontend 1,311/136 files, full ESLint, build,
colour and whitespace checks passed. Existing large-bundle advisory and npm
proxy warning remain. Separate AI review found no concrete lifecycle defect;
it is not external independent verification. No existing assertion was weakened.

Production remains on #1171 / 41aa2cb. Fresh all-account partial-manager
evidence recorded zero plans at 00:07:52.832Z. No natural final fill or TP1
execution is claimed. Scanner registry remains 796 at its known revision;
current anchors differ, 53 of 56 configured names resolve per feed, and the
902-profile proposal remains unapplied. Fresh persisted boot evidence retains
the 144,370-ms first loop, 58,220-ms worst startup lag, two HTTP 5xx and initial
protection-budget overruns. The new count index has local synthetic evidence
only. Detailed evidence and remaining session/trace limits are recorded in
docs/v3-verification-followup-2026-09-28.md with its benchmark JSON.

INVARIANTS REPORT: proof/lineage, manual ownership, original risk/cost/proposal,
atomic anchors/TP1/reservation and rollback, restart receipts and read-output
preservation Passed in the named local gates. Skipped native paths, production
behaviour of the unpublished changes and natural/session/trace acceptance
remain Not Verifiable. The six-stage check is manual; no runnable flow-check
command exists here. Timeline: V3 closure late. Next: save an exact local
candidate, then seek scoped draft publication approval under the uploaded
CLAUDE.md. No new push, merge, deployment, production setting or broker action
was performed. Original checkout edits remain preserved.
