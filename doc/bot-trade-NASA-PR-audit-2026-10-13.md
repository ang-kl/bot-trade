# NASA programme PR audit — 13 October 2026

> **Archived audit — cutoff 13 October 2026, 20:20 SGT.** Conversation reference: Codex №14,292. Audited main: `8493556fa0b4b09c106763c04c14f653e0d0d56d`. Exported 14 October 2026, 05:20 SGT.
>
> All findings and PR states below refer to that audit cutoff. Newer changes, including PRs #1358–#1361, exist at export main `6f62434bc1bdc2713971975534605dba0270f4a7` and were not reassessed for this file delivery. This is the downloadable version of the previous audit, not a new assessment of today's code.

## Conclusion

The changes mostly serve concrete problems and documented owner requests. The implementation demonstrates substantial understanding of the NASA assessment, but acceptance evidence still falls short of the programme's objectives. The clearest drift is from demonstrated correctness toward passing selected fixtures, rerunning an unexplained failure, and describing incomplete instruments as qualified. Planned later steps being unfinished is not, by itself, scope drift.

This assessment audits changes and evidence; it cannot establish the author's internal understanding or independently authenticate every owner instruction quoted in PR bodies.

## Boundary and sources

The exact conversation instruction № 13,930 is unavailable in the repository, PR records and coordination notes. An optional clarification was requested. Until that text is available, the comparison uses the published assessment and committed NASA programme baseline:

- [Published NASA assessment](https://github.com/ang-kl/bot-trade/blob/8493556fa0b4b09c106763c04c14f653e0d0d56d/doc/bot-trade-NASA-assessment-2026-10-13.md), published by PR1349, conversation ref №13,927.
- [Committed NASA programme baseline](https://github.com/ang-kl/bot-trade/blob/8493556fa0b4b09c106763c04c14f653e0d0d56d/docs/nasa-baseline-2026-10-13.md), committed in PR1355, programme ref after №14,077 / №14,078+.
- Main inspected at the audit cutoff: `8493556fa0b4b09c106763c04c14f653e0d0d56d` (PR1357).
- Adjacent delivery cohort: PR1348–1358 inclusive, all eleven PR bodies, actual diffs/file inventories, reviews, inline findings, comments and check metadata. PR1348 started before publication but merged afterwards; it is context, not a proven NASA programme execution step.
- Ten merged PRs: nine application/research changes and one document-publication PR. PR1358 was open at the audit cutoff at head `8766ff539ef1be4866452587e0137d9862e00732` on the 13 October audit refresh. The explicit post-baseline cohort consists of four merged PRs (1354–1357) and one open PR (1358); only 1355 and 1358 explicitly identify themselves as NASA implementation steps.

There are 66 changed-file records, counting the same file again when another PR changes it. Review metadata contains 35 labelled priority findings across all review rounds, including the open PR: 5 P1 and 30 P2. Four findings arrived after merging (1352: one P2; 1353: one P1; 1355: two P2). These are review findings, not a count of independently observed production incidents.

## PR-by-PR assessment

| PR | Alignment and legitimacy | Acceptance limit |
|---|---|---|
| [1348](https://github.com/ang-kl/bot-trade/pull/1348) / [1350](https://github.com/ang-kl/bot-trade/pull/1350) | Actual submitted lots and account-owned current holdings are directly aligned with the shared quantity contract. Follow-ups corrected foreign/unnamed snapshots and the reading preference. | `opened_lots` still reads mutable `trades.volume`. This is an explicitly inventoried NASA-3 gap, not an immutable opening quantity. |
| [1349](https://github.com/ang-kl/bot-trade/pull/1349) | Legitimate owner-requested delivery of the assessment. | Documentation publication supplies no operational qualification or profitability evidence. |
| [1351](https://github.com/ang-kl/bot-trade/pull/1351) | Filling missing exits from broker closing deals improves economic measurement while preserving retained money and quantity. Owner-approved widening includes rows whose money lands in the same pass. | A correct exit price alone does not prove the initial-risk denominator or a financial improvement. |
| [1352](https://github.com/ang-kl/bot-trade/pull/1352) | Rejecting moved stops as opening stops and journalling book/re-strategy movements are legitimate record-integrity corrections. | A late P2 identifies a valid transmitted bracket being rejected after a fill re-anchor. The guard still infers price precision from numerical prices. Original broker facts remain incomplete. |
| [1353](https://github.com/ang-kl/bot-trade/pull/1353) | Raising the RSS threshold is a documented owner choice responding to an observed abort. | A threshold change is mitigation. The bar-form worker still has no `resourceLimits`; worker heap, whole-process RSS and container headroom have not been jointly qualified. A post-merge P1 flags this. No OOM was forced or observed in this audit. |
| [1354](https://github.com/ang-kl/bot-trade/pull/1354) | Owner-requested manual partial-close feature with useful step validation, preview, single-flight and dismissal safeguards. Related to order-form coverage, but not a replacement for NASA-3/5. | Operational partial-close verification remains unlinked in the inspected PR records. Three early P1 findings were corrected before merge. The user-facing lock alone is not durable retry/restart qualification. |
| [1355](https://github.com/ang-kl/bot-trade/pull/1355) | Strong direct alignment: baseline inventory, parser-based import graph, timer instrumentation, and fresh/complete health evidence at research start, during polling and at completion. | Two late final-head instrument defects are reproduced below. Tick research is explicitly left out. Instrument qualification remains partial. |
| [1356](https://github.com/ang-kl/bot-trade/pull/1356) | Correct exit-side measurements in separate columns preserve existing trailing decisions. Paused-row coverage and compare-and-set lifecycle guards were corrected during review. | Report/postmortem readers have not adopted the new fields. The first design missed a writer and a downstream stop input. An unexplained CI failure was called a flake after a passing rerun. |
| [1357](https://github.com/ang-kl/bot-trade/pull/1357) | Legitimate planned-entry versus actual-fill correction: the hybrid trigger uses the broker-proven fill and retains existing initial-risk and SL/TP policies. | This changes eligibility/timing correctly; its financial effect remains unproven. An explicit clean final-head Codex review exists before merge. |
| [1358](https://github.com/ang-kl/bot-trade/pull/1358) | Open NASA-4 PR capturing broker conversion rates for account-specific commission comparison; preserving unknown rates and avoiding pooled currencies are aligned. | Gate integration intentionally remains an owner decision. Non-USD quote/minimum-fee cases and runtime receipts remain incomplete. The current review flags selecting a non-executed deal as an opener; this is an open-PR finding, not a merged defect. |

## Independently reproduced instrument gaps

The audit runs the unchanged helpers from main on Node 22.23.3, with no application startup or broker access. Normalized observations from the retained `instrument-probes.json` receipt appear in the appendix below. The original probe script and full logs remain in the audit workspace.

1. **Hidden dependency:** `import { createRequire as makeRequire } from 'node:module'; const load = makeRequire(import.meta.url); load('./exec-engine.js')` produces neither the target dependency nor an unresolved-site warning. Inline imports and the unaliased factory controls are detected. This reproduces [the late alias finding](https://github.com/ang-kl/bot-trade/pull/1355#discussion_r4257360651).
2. **False timer failure:** an unused `node:timers/promises.setInterval()` iterator reports one created timer although it has not armed one. An aborted iterator also remains counted. Independent Node resource reads show zero timer resources for these clean cases; the armed interval control is detected. This reproduces [the late promise-interval finding](https://github.com/ang-kl/bot-trade/pull/1355#discussion_r4257360641). The existing fixture itself expects the unused iterator to count as a violation, so internal consistency passes despite the semantic error.

The existing qualification test covers only runtime binaries present at its fixed paths. Missing Node 20 is filtered out rather than establishing that production-runtime qualification ran. Claude's PR body reports prior Node 20.20.2 and Node 22.22.2 runs; this audit independently executes only Node 22.23.3.

## Review and failure-evidence concerns

Every inspected final-head GitHub `review` job is green, but every actual `anthropics/claude-code-action` step is skipped. They cannot be counted as eleven completed Claude reviews. The separate GitHub Codex bot did conduct reviews and found real omissions; the two tools' evidence must remain distinct.

PR1356's [author comment](https://github.com/ang-kl/bot-trade/pull/1356#issuecomment-6144763507) records an agent-suite failure at final head `6eb028f5`, no readable failing-test log, a local pass and one passing rerun. Actions job metadata confirms the first agent-suite failure. Available annotations say only exit code 1. A rerun establishes a later pass, not the cause of the earlier failure. Calling this a proven flake exceeds the evidence.

Repeated review rounds also corrected errors created by the earlier implementation: snapshot freshness/account attribution, manual-close concurrency, import-door identity, and MAE/MFE downstream use. Review is useful, but requirements/population analysis still relies too heavily on discovering omissions after coding.

## Programme completion and drift

- **NASA-2 instruments:** substantially implemented, partially qualified, with specific reproducible remaining defects. Research refusal/abort operational claims remain without linked deployed-run closure in the inspected records.
- **NASA-3 quantity contract:** still open in this cohort. Keeper/general partial/re-strategy overwrite `trades.volume`; `/state/positions` labels it `opened_lots`. The baseline records owner naming of protected files as a prerequisite. This dependency should be tracked, not treated as an ignored instruction or silently satisfied by current-lots UI work.
- **NASA-4 costs:** progressing through a read-only, open PR. Deliberately leaving admission unchanged follows the documented plan; it is not unauthorized avoidance of integration.
- **NASA-5 fault matrix:** no full deployment-matched matrix and closure receipt found in this cohort. Existing focused failure tests are useful but do not prove the whole operational envelope.
- **NASA-6 financial validation:** no new account-specific, after-cost, held-out/forward PF or win-rate improvement demonstrated by these PRs. Measurement changes and corrected triggers support evaluation; they do not establish the existing PF1.68/WR75 goals.

Authorized feature work alongside these steps is a priority diversion, not automatically scope drift. The demonstrated drift is in acceptance claims and failure diagnosis. Whether sequencing violates №13,930 specifically requires that original instruction.

## Recommended next work

1. Correct and requalify both instrument falsifiers, retaining controls on supported runtimes.
2. Diagnose or explicitly retain the unexplained CI failure; keep actual reviewer completion separate from a skipped green job.
3. Close the distinct proposed/sent/filled/residual quantity contract and transmit-bracket provenance across the inventoried population, within owner-authorized scope.
4. Finish account-cost comparisons with real broker receipts before requesting any concrete admission-policy integration.
5. Complete the declared fault/recovery matrix and the financial validation as separate evidence packages.

Each requirement needs implementation, operational and financial states where applicable, exact commit/configuration/population, and a named unresolved dependency. Do not infer completion from a PR count, suite size, or descriptive document.

## Validation and limits

Nine selected existing test files ran against isolated current-main source: **110 passed, 0 failed, 0 skipped**, Node 22.23.3. They cover research isolation/configuration/monitoring, exit-side excursions and paused lifecycle races, manual partial-close sizing/routes and capped/manual hybrid paths. Log: `focused-tests.log`.

Installed agent dependency lock hashes match the audited snapshot; installed acorn 8.16.0 matches its declared version. Temporary fixtures and local dependency links reside outside the application checkout. No code change, application build, production fault injection, order, account-setting change, or fresh private broker/PF/WR recapture occurred. Full CI totals are repository-reported and job-status inspected, not independently rerun by this audit. Absence of a linked runtime receipt means unverified in the reviewed evidence, not proof that nobody performed the check privately.


## Appendix — retained probe observations

Unchanged instrument helpers were executed on Node 22.23.3 against audit commit `8493556f`. These are isolated controls, not observed production incidents.

| Probe | Expected | Observed |
|---|---|---|
| Inline dynamic import | Dependency discovered | Discovered |
| Unaliased `createRequire` | Dependency discovered | Discovered |
| Aliased `createRequire` factory | Dependency discovered or explicitly unresolved | Target absent; unresolved list empty |
| Clean module | Zero created timers | Zero |
| Armed unref'd interval | One created timer | One |
| Unused promise-interval iterator | Zero pending timers | One reported; independent timer-resource reading zero |
| Aborted promise-interval iterator | Zero pending timers | One reported; independent timer-resource reading zero |

The focused existing-suite receipt completed with:

```text
tests       110
pass        110
fail          0
cancelled     0
skipped       0
todo          0
runtime     Node 22.23.3
```

The nine selected files covered research isolation/configuration/monitoring, exit-side and paused excursions, partial-close sizing/routes, and capped/manual hybrid behavior. Full application/native/frontend gates were not independently rerun for that audit.
