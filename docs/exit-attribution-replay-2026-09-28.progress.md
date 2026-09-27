# Exit attribution and V3 continuation progress

Version 1 - 28 September 2026

## 28 September 2026, 04:40 SGT - reproduction and scope checkpoint

Stage 5/6, Execution; local implementation authorised by the owner's request to correct exit attribution, replay exits with costs and unchanged risk, and complete V3. Main remains cf121d4; draft PR 1170 remains aa59db0 and undeployed. Existing production approval boundaries remain in force. The approved V3 design and risk values are unchanged; this log does not amend its acceptance criteria.

Two deterministic SQLite regressions fail before the correction: an open momentum book row falsely supplies a trailing-stop cause, and a position-ID collision borrows another account's close event. The old book-ownership test explicitly encoded the first false assumption; its expected result is being corrected to unknown under the owner's requested attribution correction, not relaxed to obtain a pass.

Scope: broker attribution service and regressions; reconciler and existing close tests; additive evidence schema; existing bounded account history reader; offline costed replay and tests; implementation/evidence documentation. Original risk, sizes, money, broker protection, account identity, policy floors, scanner order authority and qualification thresholds are preserved. Checks: exact filled receipt identity, account collision, TP/SL/market ambiguity, deadlines/retry pacing, money immutability, original-risk and cost arithmetic, ambiguity/truncation handling, existing backend/frontend/native gates as affected.

Next: attribution regressions and wiring; costed candidate replay; remaining V3 gaps. The 05:00 readiness target is at risk. Production release, scanner-profile changes, calendar acceptance, live partial-fill proof and research qualification remain separate gates. No production change has occurred.

## 28 September 2026, 05:21 SGT - source freeze and replay checkpoint

Stage 5/6, Execution complete for the attribution/replay increment; Stage 6 Evidence gate open until the frozen-source backend run finishes. Source freeze covers 1,020 JavaScript/MJS files, SHA-256 f6fb6f7ed74440a9edee581e7d818c4b120d0b53407e29ecddb518ea3ffe649e. Original risk, size, protection, caps and authority remain unchanged. Main and remote draft #1170 remain cf121d4 and aa59db0.

The real history reader now queues receipts for already-priced trades as well as money gaps. Account collisions, late replies, unresolved transport locking, idempotency and money preservation are tested. A follow-up initially broke two legacy unscoped-journal assertions; the implementation was corrected while preserving those assertions. The resulting focused suite passes 103/103. The first complete backend run passed 7,137 remaining tests plus 30 latency and six hygiene checks; a later run passed 7,140 plus the same 36 checks, each with three skips. One intervening rerun was interrupted without a verdict. The final source freeze is being checked separately. Frontend: 1,311 passed; full lint, build and colour check passed. Build retains the existing large-chunk advisory; it is not a performance trace.

Frozen replay: 23 closes classify as 10 inferred native SL, 10 inferred native TP and three market fills with initiator unverified. Each cost scenario leaves 11 of 15 momentum 3R candidates and all three COIN trail candidates open at the cutoff; the other four momentum candidates exit at their original stop. No target hit, closed-only PF, forecast of improved profit or V3 qualification is claimed. The complete policy replay is Not Verifiable without historical management/cost/execution evidence.

Read-only gateway health at 05:06:39 SGT confirms connected gateways, seven accounts, bracket/target guards and tick placement false. Feed accounts remain 3489/9908. The exact 902-profile proposal, preserving the existing 796, passes the real registry's isolated apply/rollback and bridge/CAS refusals. Its first evidence extract omitted timeframe map entries and was refused; the complete 80-symbol map extract per relevant account corrected that extraction error. No validator was relaxed. The proposal and rollback remain private and unapplied.

Timeline: the 05:00 target is missed. Remaining V3 gates are deployment/CI/review, actual scanner comparison recovery, final partial-fill lifecycle, full production traces, dated acceptance windows and empirical target evidence. The implementation/evidence record is docs/exit-attribution-replay-2026-09-28.md. Next: record the final gate, commit the reviewable local increment, save the private report and request the specific next action under the uploaded instruction's explicit push/production approval rule. No broker or production mutation occurred.

## 28 September 2026, 05:24 SGT - final local gate and handover

Stage 6/6, Evidence complete for the local attribution/replay increment; V3 production acceptance remains open. The frozen-source run passed 30 latency, six hygiene and 7,140 remaining backend tests (7,176 total passed; three skipped; zero failed), and left its private TMPDIR empty. Frontend 1,311/1,311 across 136 files; full and final changed-source lint, build, colour and whitespace checks passed. The 1,020-file source hash remained f6fb6f7ed74440a9edee581e7d818c4b120d0b53407e29ecddb518ea3ffe649e before and after the run. No source was changed during that run. Existing build chunk-size advice remains; it is not a failed build or a completed browser trace.

Replay and scanner proposal outcomes are unchanged from the preceding checkpoint. The private HTML report includes all 23 closes, 36 scenario records, exact proposed registration and rollback payloads, limitations and the invariant report. Current release is local, unpushed, unmerged and undeployed; remote #1170 remains draft at aa59db0. Next authorised work after explicit push approval is publishing this increment to the draft PR and obtaining its CI/review evidence. Production release, scanner application and live acceptance remain separate actions. The user-visible serial at this checkpoint is 10,148; later visible replies take precedence. Timeline remains late for 05:00; full V3 is not accepted.
