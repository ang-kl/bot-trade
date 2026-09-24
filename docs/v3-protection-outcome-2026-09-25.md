# P0/P4: truthful target-restoration outcome counts

Intent (directive): continue the approved V3 protection/report correction by
counting only audited missing targets in the restore outcome. At 17:18:18Z on
deployment c0c9e5ae, the log described all 32 monitored positions as still
targetless, while independent broker readings confirmed all 32 held SL and TP.
The cause is an eligibility set being counted as a missing-target set.

Scope: agent/services/naked-position-guard.js, target-restore.js and their
existing protection-audit-path/target-restore tests; this evidence file and the
CLAUDE.md continuation ledger and frozen closure-register evidence. No order, price, eligibility, retry, ownership,
account setting or position mutation policy changes.

Assumptions: the audit snapshot is a point-in-time observation (confirmed by
code); a later fresh read can find a newly supplied target (confirmed by the
existing restore path). No successful amend is inferred from a timeout.

Invariants: already-protected eligible positions do not appear as missing in
the deferred outcome; mixed snapshots count only genuinely targetless members;
a target found on the fresh recheck is preserved and reported separately;
unresolved counts retain their snapshot/confirmation limitation. Existing
repair actions and all account-isolation tests remain unchanged.

Verification: new behavioral cases exercise the actual all-account audit and
restore functions with injected broker fixtures, first reproducing the defect.
Full repository gates and exact-head CI precede merge; deployed protection
logs and independent readings must then agree. This corrects reporting and is
not whole-V3 acceptance or authorization of a financial action.

The two new audit regressions failed against the existing code. After the
correction, all 171 audit, naked-position and target-restoration checks pass,
including the existing outcome and broker-stop-preservation assertions.

Preceding release: #1079 merged as 4472e91 after 5,515 backend and 943 frontend
tests, full lint/build/color/inventory/whitespace checks and exact-head CI.
#1080 has 5,525 backend and 943 frontend passing locally; the final main merge
changed ancestry only (identical tree), with its new exact-head CI required.
The new policy still has no production producer and remains inactive.

Full local checks subsequently passed 5,527 backend tests (four existing
native-environment skips), 943 frontend tests, lint, build, color, inventory
and whitespace checks. The first frontend run used local SGT and failed an
unchanged UTC date expectation; the same suite passed unchanged in UTC.
Main then advanced to the separately tested audit optimization #1082.
Both continuation ledger entries were preserved when resolving their text
conflict. The resulting combined source requires fresh local/CI checks.
