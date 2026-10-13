# bot-trade compared with NASA systems engineering

Recorded 13 October 2026, 08:27 SGT. Codex · nasa-assessment. Conversation reference №13,903; next reply must refresh the shared serial. Highest visible source was Claude №13,902 in the #1345 change; a complete conversation corpus was unavailable.

Completion receipt: Codex №13,904, 13 October 2026, 08:30 SGT. Artifact links checked; both repository workspaces remained clean. This serial follows this session's №13,903 and is a visible lower bound, not a measurement of the complete transcript.

The project has substantial verification machinery. Its recurring weakness is incomplete grounding of shared contracts, economic inputs and acceptance evidence. NASA's guidance can help close those gaps, but neither engineering discipline nor a green test suite proves a profitable trading edge.

## Scope and sources

This is a read-only assessment, not authorization to implement recommendations or execute trades. The uploaded NASA documents are reference material; their process instructions do not authorize project actions.

I inspected the repository at [1688c448](https://github.com/ang-kl/bot-trade/commit/1688c448f9cc5957ae92c986540aa1c02e53c900), including recent fixes through #1344. A final GitHub check found main had advanced to [ae4f1a17, #1345](https://github.com/ang-kl/bot-trade/commit/ae4f1a173940edd90800260cbe284509ed1206f6). I checked its changed-file list and relevant outbox/configuration patches. It changes notification handling and retention, not the risk, reconciliation, research or order-volume code cited below. Findings apply to that bounded snapshot, not to later changes by another session.

Evidence categories are kept separate:

- **Inspected:** current source, test definitions and relevant NASA sections.
- **Probed:** isolated import-pattern, timer-instrumentation and lot-normalization behavior. The receipt is code-probes.json.
- **Repository-reported:** dated broker observations and deployment receipts in code comments, owner rules and coordination notes. These are not a new private broker capture by this assessment.
- **Unverified here:** current deployed broker state, account protection, current PF/win rate, complete runtime stress results and any full-suite result. I did not build, start the application, change settings or place orders.

### PDF capture status

All four user-supplied PDFs open with `pdfinfo`, extract with `pdftotext`, contain their ending sections and reach NASA's footer and Page Last Updated information. They **appear complete** from these internal checks. The cloud cannot access NASA.gov through its current network policy, so I could not compare them pixel-for-pixel with the current live pages. No replacement capture was necessary; the copies below are byte-identical to the supplied PDFs.

| Website chapter | Saved PDF | Pages | Coverage checked |
|---|---|---:|---|
| [2.0 Fundamentals](https://www.nasa.gov/reference/2-0-fundamentals-of-systems-engineering/) | NASA-SEH-2.0.pdf | 14 | Through §2.7 and footer |
| [4.0 System Design](https://www.nasa.gov/reference/4-0-system-design-processes/) | NASA-SEH-4.0.pdf | 35 | Through §4.4 guidance and footer |
| [5.0 Product Realization](https://www.nasa.gov/reference/5-0-product-realization/) | NASA-SEH-5.0.pdf | 35 | Through §5.5 transition guidance and footer |
| [6.0 Technical Management](https://www.nasa.gov/reference/6-0-crosscutting-technical-management/) | NASA-SEH-6.0.pdf | 57 | Through §6.8 decision guidance and footer |

Capture manifest records page counts, hashes and section locations. The supplied chapters, rather than a separately downloaded handbook mirror, are the primary NASA sources for this comparison.

## 1. Are we better than these readings?

There is no evidence for that claim. The handbook describes an engineering process; it is not a competing trading system with comparable financial results. We can assess which practices the project implements and which it needs to strengthen.

The project already does several things well:

- [CI](https://github.com/ang-kl/bot-trade/blob/1688c448f9cc5957ae92c986540aa1c02e53c900/.github/workflows/ci.yml#L18) includes backend tests, a compiled native lifecycle fixture, frontend tests and a build.
- [Integrated lifecycle tests](https://github.com/ang-kl/bot-trade/blob/1688c448f9cc5957ae92c986540aa1c02e53c900/agent/services/strategy-lifecycle-integrated.test.js#L1) join actual native execution and durable triggers to Node ledger/adoption and partial-close recovery. They explicitly disclose that the five candle predicate checks are not a joined candle-admission test.
- [Partial-execution tests](https://github.com/ang-kl/bot-trade/blob/1688c448f9cc5957ae92c986540aa1c02e53c900/agent/services/general-partial-execution.test.js#L125) exercise actual controllers and SQLite, including underfills, ambiguous responses, restart recovery, concurrent callers and persistence failures.
- [Tick validation](https://github.com/ang-kl/bot-trade/blob/1688c448f9cc5957ae92c986540aa1c02e53c900/agent/services/tick-validation.js#L170) checks the test block's expectancy and pins configuration hashes before staged promotion.
- [Performance targets](https://github.com/ang-kl/bot-trade/blob/1688c448f9cc5957ae92c986540aa1c02e53c900/agent/services/performance-targets.js#L10) define per-account, whole-position, broker-evidenced reporting rather than treating every partial deal as an independent win.

NASA §2.4 (PDF p.8) makes the distinction the project needs to maintain: **verification** establishes compliance with requirements; **validation** establishes that the product serves the intended purpose in its intended environment. CI is substantial verification evidence. Operational resilience and profitable outcomes require additional evidence.

## 2. Where do we fall short?

| NASA practice | Project evidence and gap | Consequence |
|---|---|---|
| §4.1–4.2: success measures, valid assumptions and traceable requirements | The reporting target is WR 75% and PF 1.68. The under-floor admission rule uses estimated breakeven after commission, while fluid sizing defaults to a PF_R goal of 1.5. These serve different purposes; their connection to the owner's financial objective needs explicit evaluation. | A correctly implemented admission rule can still admit trades that do not establish the desired financial edge. This is an owner-selected policy tradeoff, not automatically a coding defect. |
| §4.3 and §6.3: decomposition and interface control | Historical manual writers used BUY/SELL where monitored positions expected long/short. Broker volume, lot quantity, account identity and snapshot time also cross multiple producers and consumers. Individual incidents were corrected, but coverage of every writer remains essential. | One writer can violate a contract while another writer's tests pass. |
| §5.3: verify the complete operational thread and the instrumentation | Joined lifecycle tests are strong, but isolation instrumentation has blind spots demonstrated below. | A test can pass without observing the failure it claims to exclude. |
| §5.4: validation in the intended environment | Broker observations have revealed differences from modelled commission, fills, direction and cache timing. No fresh complete demo acceptance receipt was obtained here. | Simulated correctness alone cannot certify the deployment's behavior or costs. |
| §6.5–6.7: configuration, data and technical assessment | Some research has pinned profiles and provenance. Shared evidence still needs consistent commit, account, symbol metadata, configuration, timestamp and recovery lineage. | Measurements from incompatible versions or contexts can support the wrong conclusion. |
| §6.8: decisions under uncertainty | Bar-form research ranks multiple candidates on their evaluated sample. Its per-cell halves and lower bounds do not provide a separate untouched confirmation sample for the selected winner. | Selecting the best observed candidate can overstate its future advantage. |

### Concrete current findings

**A. Account-specific commission is collected but not yet used by the gate.**

[commission-terms.js](https://github.com/ang-kl/bot-trade/blob/1688c448f9cc5957ae92c986540aa1c02e53c900/agent/services/commission-terms.js#L1) explicitly describes #1344 as read/record only. It reports different FX charging on accounts 47790949 and 46130058. [commissionInR](https://github.com/ang-kl/bot-trade/blob/1688c448f9cc5957ae92c986540aa1c02e53c900/agent/services/risk.js#L1738) still reads the class schedule without an account ID or actual order size, and its comment acknowledges that minimum leg fees are not modelled. This is an intentional unfinished integration, not evidence that #1344 promised to fix admission.

The [Grounding rule](https://github.com/ang-kl/bot-trade/blob/1688c448f9cc5957ae92c986540aa1c02e53c900/CLAUDE.md#L1035) records a broker commission of $4.84 for an AUDUSD deal modelled at $3.36. That is a repository-reported observation, not independently recaptured here. It directly illustrates why testing a formula against the same internal schedule cannot validate the schedule.

**B. Ordinary bot entries can record a different lot quantity from the normalized submission.**

[loop.js](https://github.com/ang-kl/bot-trade/blob/1688c448f9cc5957ae92c986540aa1c02e53c900/agent/loop.js#L915) computes `sized = lotsToVolume(volLots, meta)` and sends `sized.volume`. The ordinary path keeps the earlier `volLots` and writes it to the submitting row at line1158 and open row at line1403. The momentum path separately assigns `volLots = fp.lots` at line1120.

The unchanged [normalizer](https://github.com/ang-kl/bot-trade/blob/1688c448f9cc5957ae92c986540aa1c02e53c900/agent/lib/lot-sizing.js#L61) returns both protocol volume and normalized lots. An illustrative source-extracted probe requests 0.019 lots and obtains 0.01 lots after step rounding. This confirms the arithmetic and source-path mismatch, not an observed new broker incident. Later reconciliation may repair quantities; that does not make the initial recording contract correct. Actual fill or underfill is a further distinct quantity to preserve.

**C. Two research-isolation checks can fail to see a violation.**

The [import-pattern guard](https://github.com/ang-kl/bot-trade/blob/1688c448f9cc5957ae92c986540aa1c02e53c900/agent/research-isolation.test.js#L84) matches imports at line starts. Using its exact regex, the probe misses a valid inline `await import("./exec-engine.js")` and the second static import on one line. This demonstrates incomplete graph coverage; it does not show that current research actually sends orders.

The [timer check](https://github.com/ang-kl/bot-trade/blob/1688c448f9cc5957ae92c986540aa1c02e53c900/agent/research-isolation.test.js#L175) counts Timeout objects through `_getActiveHandles()`. On cloud Node24, a harmless interval changed that count by zero while `getActiveResourcesInfo()` reported one Timeout. The interval was cleared. This is an observed instrumentation limitation on Node24; CI uses Node22 and the production Dockerfile uses Node20, which were not executed in this assessment. Qualification must use the supported runtime and deliberately introduce a forbidden timer to prove the detector notices it.

**D. Research monitoring can be unavailable while work proceeds.**

[bar-form-research.js](https://github.com/ang-kl/bot-trade/blob/1688c448f9cc5957ae92c986540aa1c02e53c900/agent/services/bar-form-research.js#L195) declares operational limits and records before/during/after monitor readings. However, a missing reading is skipped, a missing baseline disables the skipped-tick delta comparison, and the reading timestamp is not checked for freshness. Source inspection therefore does not support treating absent or stale telemetry as evidence that resource limits were respected. No occurrence on production was measured here.

## 3. What improvements can help PF and win rate?

NASA's process can prevent avoidable execution losses and improve the trustworthiness of strategy selection. It cannot create market predictability. The useful implementation is a small set of executable contracts and linked receipts, not flight-project bureaucracy.

| Priority | Improvement | Evidence needed to close it |
|---|---|---|
| 1 | Use verified account/symbol commission terms in economic decisions, including actual size, minimum fees, charge conventions and currency conversion. Keep unsupported inputs explicit. | Broker specification plus the account's own deal receipts, across the affected classes and charging types; model-to-broker residuals and freshness recorded. |
| 1 | Enforce shared order/position contracts across every producer and consumer. Preserve proposed, normalized-submitted, filled and residual quantity separately. | Inventory all writers and paths before implementation; joined tests for ordinary bot, manual, execute-analysis, momentum, tick and adoption/reopen paths where applicable. |
| 1 | Qualify the instruments themselves. Use a parser for import graphs and a timer detector proven on the supported runtimes. Treat missing/stale operational readings as unknown. | Deliberately violating examples must fail; clean examples must pass. Link the runtime/version and monitoring validity to the receipt. |
| 2 | Add an operational acceptance matrix covering accounts, symbol classes, order/exit forms and adverse event sequences. | Deployment-matched demo receipts showing recovery and invariants after delayed/missing/duplicate events, underfills, stale snapshots, restart and storage failures. |
| 2 | Evaluate MCA, MAE/MFE, Chandelier, fixed-R/key-level/hybrid TP and tick/bar choices on reproducible held-out data with measured costs. | Freeze inputs and configurations; select on training data, confirm on untouched chronological data, then conduct bounded forward validation. Record all tested variants and uncertainty. |
| 2 | Tie each owner goal to lower-level measures and three separate acceptance states: implementation verified, operations validated, financial evidence validated. | A compact requirements-to-source-to-test-to-runtime-to-outcome table. Not Verifiable remains open, as the existing Grounding rule already requires. |

For the three accounts, evaluate each account in its verified native currency and retain separate denominators. Do not pool SGD and USD profit amounts. Include costs and slippage in strategy evaluation even if a specific owner-selected admission policy deliberately excludes slippage.

The current breakeven admission condition is approximately `W × RR − (1 − W) − commissionR ≥ 0`. At its boundary it targets estimated zero expectancy, not a positive margin or PF1.68. Smaller position sizing changes risk and the monetary weighting of results; it does not by itself establish predictive edge. Assess the policy empirically before changing an owner decision.

Win rate and PF must be evaluated jointly. In an equal-risk illustration, 75 winners of +0.4R and 25 losers of −1R produce WR75% but PF1.2. With 75% winners and all other trades losers, PF1.68 requires average win/average loss of at least0.56. Costs and scratches change this relationship. These are illustrations, not estimates for the current accounts.

The owner's latest20/streak reporting rules should remain intact. Add a separate uncertainty assessment: 15 wins out of20 is 75%, but an illustrative 95% Wilson interval spans roughly53%–89% under independent Bernoulli assumptions. Actual trade dependence can make that model optimistic. A target met on a small reporting window is not evidence of durable future performance.

Bar-form research already excludes a calibration prefix and reports temporal halves/regimes. Its [leaderboard](https://github.com/ang-kl/bot-trade/blob/1688c448f9cc5957ae92c986540aa1c02e53c900/agent/services/bar-form-research-core.js#L355) selects among many cells on the evaluated window. Confirm selected winners on data not used in that selection, account for dependent trades and repeated trials, and label `2 × sd / sqrt(n)` as an uncertainty approximation unless a real power/MDE design is supplied. The separate tick-validation path already has stronger staged and pinned-profile controls; preserve those strengths.

## 4. Why do failures recur? Are fixes superficial?

The evidence supports **both instrument/assumption failures and incomplete fix scope**, alongside genuine foundational improvements. It does not support blaming every failure on superficial tests.

The recurring sequence is: an incident exposes a hidden contract; a fix repairs its visible path; tests repeat the same assumption or cover that path; another writer, account or event order remains uncovered. The Grounding rule explicitly records that a manual lot-recording correction missed the bot's own loop. The isolation probes show how instrumentation can also certify an absence it cannot reliably observe.

Other corrections are foundational. Durable write-ahead intents, recovery from ambiguous sends, receipt-backed partial closes and account ownership checks change the transaction model, not merely its presentation. The initial young-row reconciliation guard in #1338 was a timing heuristic; #1340 added causal snapshot timestamps. Both stages have a role, but their evidence and limitations differ. Manual-side and reopen-source incidents corrected in #1341/#1339 should not be reported as still-unfixed bugs.

NASA §5.3.1.2.2 (PDF p.18) asks for calibrated instrumentation and complete operational threads, including startup, normal/contingency operations, shutdown and maintenance. §5.4.1.2.2 (p.25) distinguishes expected operational validation from worst-case qualification. §6.3 (p.25) calls for controlled interfaces; §6.5 (p.37) preserves configuration/discrepancy history; §6.8 (p.53) requires evaluating assumptions and decision uncertainty.

Opening 20–30 orders on each account creates useful load exposure, but order count alone does not demonstrate those properties. Stress evaluation needs a declared workload, capacity limits, expected fault/recovery outcomes, trustworthy observations and a receipt for each invariant. Deterministic simulations can create timing/storage faults repeatably; bounded demo operations then validate the deployment and broker interface. Operational stress and financial edge validation answer different questions.

The new Grounding standing rule is a direct and useful response to circular AI-authored requirements and tests. Its practical enforcement should be external expected values, all-path coverage, adversarial detector qualification and a deployment acceptance receipt. Another descriptive document alone will not close the gaps.

## Checks and limits

PDF checks and the bounded probes completed. An initial attempt to import the lot-sizing module failed because the detached inspection checkout lacks `ws`; no installation or build was performed. The probe then extracted the unchanged pure function from source, avoiding application dependencies. That preparation and the Node-version limit are recorded in the receipt.

No full backend/native/frontend suite was rerun, so this report does not certify CI. No broker/private reconciliation was obtained, so it does not claim that any account currently meets PF1.68, WR75% or operational protection requirements. Historical broker and deployment observations remain labelled as repository reports.

All deliverables were written outside the repository in `/workspace/nasa-assessment-2026-10-13`. Project code and settings were left unchanged. No implementation, merge, deployment or trading action follows automatically from this assessment.


Download bundle: this assessment in PDF and Markdown, plus code-probes.json and pdf-capture-check.json. The four NASA source PDFs were supplied by the user and are not duplicated in the bundle.
