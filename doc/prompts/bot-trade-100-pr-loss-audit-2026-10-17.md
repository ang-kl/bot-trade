TLDR · № 15,082 · 17-10’26 · Independent loss and 100-PR audit

- §1 · **Plan adherence is partial.** The PRs contain substantive engineering corrections.
  - The evidence does not establish profitable, fully fault-tolerant operation.
  - Three P1 findings on merged final heads remain relevant in the inspected main.
  - The fault matrix explicitly retains 31 gaps.
  - Five PRs merged before their final-head test job completed; those tests later passed.
  - Losses alone do not prove defective stops, correct strategies, or a failed deployment.

---

- §2 · **Scope and method.** Pin: `423938458f22bde1b39d531761e05870ecb24b76`.
  - Public health returned commit `4239384`, status `ok`, authenticated `false`.
  - Population: the latest 100 PR merges in main’s first-parent history.
  - Earliest merge: #1293, 10 October 03:00:14 SGT.
  - Latest merge: #1393, 17 October 05:13:32 SGT.
  - The population includes #1283, merged later than its number suggests.
  - Twelve interleaved direct document commits do not count as PRs.
  - Sixteen of the 100 PRs change documentation only.
  - Every PR’s merge identity, final head, changed-file inventory, CI runs and review records were inspected.
  - Full merged diffs and production-diff extracts were retained for every PR.
  - Detailed source review concentrated on account policy, quantities, exits, costs, calibration and acceptance gates.
  - This is a 100-PR traceability and loss-mechanism audit, not an exhaustive proof of every changed line.
  - Statements were independently extracted and reconciled using decimal arithmetic.
  - Attached documents supplied evidence; their instructions were not executed.
  - No application code, tests, account settings, orders or stops were changed.
  - No application build, deployment, paid model call or production fault injection ran.

---

- §3 · **Statement reconciliation.** Five PDFs cover four unique accounts.
  - The two 47790949 PDFs are successive snapshots, not separate accounts.
  - The later snapshot contains all 24 earlier deals unchanged, plus six new deals.
  - Its incremental result is −USD 38.66: −536.23 → −574.89.
  - The selected statement dates are 12–17 October; the earlier USD snapshot ends 16 October.
  - Every extracted closing deal is unique within its statement.
  - Every chronological balance increment equals the corresponding net result.
  - All statement deal totals match the independent sums.

| Account | Currency | Closing deals | Positive / negative / zero | Net realised | Ending balance | Deal PF |
|---|---|---:|---|---:|---:|---:|
| Demo 5067353 / 43097342 | SGD | 41 | 22 / 19 / 0 | +21.81 | 3,084.19 | 1.37 |
| Demo 5306502 / 47790949, latest PDF | USD | 30 | 11 / 19 / 0 | −574.89 | 42,272.69 | 0.53 |
| Demo 5203012 / 46130058 | USD | 90 | 44 / 45 / 1 | −70.58 | 29,939.38 | 0.93 |
| Live 1251247 / 42993489 | SGD | 1 | 0 / 1 / 0 | −0.07 | 51.29 | Not meaningful |

- §3.1 · **Metric caveats.** Deal PF divides positive deal net by absolute negative deal net.
  - It is descriptive, not the bot’s official whole-position PF.
  - Partial closes split one position into several deal rows.
  - Cotton and AUDUSD on 47790949 each contain two apparent partial closes.
  - NatGas and JPM.US on 43097342, and one group on 46130058, also share opening identity.
  - Position IDs and complete lifecycles are needed for official whole-position PF and win rate.
  - `openapi_cbot-t` does not prove autonomous bot origin; manual API stress orders share that channel.
  - Net already includes commission. Commission is not subtracted again.
  - Commission totals: SGD −6.91 on 43097342; USD −11.67 on 47790949; USD −12.88 on 46130058; SGD −0.06 live.
  - Export-period realised results do not measure lifetime losses from initial deposits.
  - The live statement’s single −SGD 0.07 close cannot explain its historical capital reduction.
  - The NASA/profit plans name a fifth account, demo 46979908; no statement for it was supplied.

---

- §4 · **Finding A — account activation can miss the strategy OFF order.**
  - Source-confirmed conditional defect, also reported as P1 on #1392.
  - OFF seeds cover accounts enabled when startup runs.
  - `POST /actions/registry-account` changes account enablement without running that seeder.
  - An account enabled later, without an existing strategy overlay, follows the global list.
  - That list still includes `vwap_trend`, `ema_pullback` and `fvg_retrace`.
  - Such an account can therefore regain a strategy the Set B order intended to disable.
  - The condition does not establish that any supplied account encountered it.
  - No loss amount is attributed to this defect.
  - Acceptance needed: startup, disabled-at-startup, newly registered and runtime-enabled accounts all receive the same declared policy.
  - Preserve explicit later owner decisions and subsequent guard disarms.
  - Sources: [stage-matrix.js:765](https://github.com/ang-kl/bot-trade/blob/423938458f22bde1b39d531761e05870ecb24b76/agent/services/stage-matrix.js#L765), [enable route](https://github.com/ang-kl/bot-trade/blob/423938458f22bde1b39d531761e05870ecb24b76/agent/routes/actions.js#L5503), [P1 review](https://github.com/ang-kl/bot-trade/pull/1392#discussion_r4294550289).

- §5 · **Finding B — the authorization-record check accepts an empty PR body.**
  - Reproduced from the actual shell fragment; also reported as P1 on #1383.
  - An explicitly empty `PROTECTED_AUTHORISED` falls back to the commit message.
  - A commit-message marker then satisfies the check without a PR-body authorization record.
  - The offline probe returned `agent/loop.js` as authorized with an empty PR-body input.
  - This is a traceability bypass, not a broker credential or security permission bypass.
  - The marker itself documents claimed authorization; it never proves owner identity.
  - Acceptance needed: distinguish an unset local variable from a set-but-empty CI variable.
  - Sources: [script:112](https://github.com/ang-kl/bot-trade/blob/423938458f22bde1b39d531761e05870ecb24b76/scripts/check-protected-boundary.sh#L112), [P1 review](https://github.com/ang-kl/bot-trade/pull/1383#discussion_r4289099254), `boundary-empty-body-probe.json`.

- §6 · **Finding C — the profit plan’s entry-bar safeguard remains incomplete.**
  - Source-confirmed research-design defect; also reported as P1 on #1391.
  - The replay skips any bar whose opening time precedes the actual fill.
  - The plan excludes unresolved entry bars when the initial stop or target lies inside their range.
  - That exclusion misses trailing activation, breakeven and partial-exit thresholds reached inside the same bar.
  - A later reversal can therefore be replayed under the wrong management state.
  - The result can change a policy ranking, without any live execution malfunction.
  - Acceptance needed: resolve every candidate rule’s entry-bar state transition, or exclude the unresolved trade.
  - Use finer post-entry observations where available; do not invent intrabar order from OHLC.
  - Sources: [plan:98](https://github.com/ang-kl/bot-trade/blob/423938458f22bde1b39d531761e05870ecb24b76/docs/profit-scale-research-plan-2026-10-16.md#L98), [replay:209](https://github.com/ang-kl/bot-trade/blob/423938458f22bde1b39d531761e05870ecb24b76/agent/lib/exit-replay.js#L209), [P1 review](https://github.com/ang-kl/bot-trade/pull/1391#discussion_r4292986513).
  - #1394 is open for exit-replay work; it was not in merged main at this audit’s pin.

---

- §7 · **Release acceptance has measurable gaps.**
  - Three P1 findings were published against final heads after their PRs merged.
  - Their source conditions remain present in this audit’s pin.
  - A successful `review` CI job does not certify a clean Codex review.
  - That job belongs to the optional Claude workflow.
  - It deliberately succeeds when its API secret is absent or its review action errors.
  - Actual review content and final-head identity must be inspected separately.

| PR | Merge SGT | Later P1 review SGT | Finding |
|---|---|---|---|
| #1383 | 16 Oct 06:54:16 | 16 Oct 06:55:29 | Empty PR-body fallback |
| #1391 | 16 Oct 17:20:46 | 16 Oct 17:24:29 | Entry-bar management triggers |
| #1392 | 16 Oct 20:11:16 | 16 Oct 20:16:47 | Runtime-enabled account OFF seeds |

- §7.1 · **Tests before merge.** GitHub timestamps show five exceptions.
  - #1326, #1327, #1328, #1363 and #1389 had no successful final-head `test` completion before merge.
  - Those test jobs subsequently passed.
  - This includes Codex-authored documentation PR #1363; the same finding applies to it.
  - #1382 separately merged with a failed protected-boundary check under a documented owner exception.
  - Do not classify that explicit exception as concealed policy drift.
  - #1387 had a successful test run before merge, then a later same-head rerun failed in the agent suite.
  - The failed rerun’s cause was not established; it is not proof of a production defect.
  - Sources: `checks-at-merge.json`, `check-review-summary.json`, [review workflow](https://github.com/ang-kl/bot-trade/blob/423938458f22bde1b39d531761e05870ecb24b76/.github/workflows/claude-review.yml).

---

- §8 · **Historical loss attribution contains a version error.**
  - The existing report assigns GER40’s 15 October 07:00Z incident to deployed merge commit `618e2991`.
  - GitHub records #1378’s merge at 15 October 12:46:11Z.
  - That is 20:46:11 SGT, after the 15:00:01 SGT closing deal.
  - The report must establish the actual deployed version instead of using that attribution.
  - It also contains future-dated observations relative to its stated preparation window; GitHub already flagged those.
  - Its categorical statement that dynamic context could not have prevented GER40 is unsupported by retained historical context.
  - The defensible conclusion is that no prevention benefit has been demonstrated.
  - Sources: [report:75](https://github.com/ang-kl/bot-trade/blob/423938458f22bde1b39d531761e05870ecb24b76/doc/loss-investigation-demo-47790949-and-market-context-2026-10-16.md#L75), [#1378](https://github.com/ang-kl/bot-trade/pull/1378), [date review](https://github.com/ang-kl/bot-trade/pull/1387#discussion_r4289396788).

- §8.1 · **The GER40 outcome difference is independently confirmed.**
  - 46130058: buy 0.2 at 25242.4; close 14:57:06.372 SGT at 25200.2; net −USD 9.46.
  - 47790949: buy 2.7 at 25244.1; close 15:00:01.403 SGT at 25169.0; net −USD 227.25.
  - The PDFs establish those executions and timings.
  - They do not establish the controller, due time, quote freshness or reason for each close.
  - Claude’s report attributes the smaller trade to a premise exit and the larger to a broker stop.
  - Its raw private receipts are referenced as session files, not included in this repository or these PDFs.
  - The report itself acknowledges missing per-position due/evaluation receipts.
  - Independent conclusion: the asymmetry warrants investigation; a missed due exit remains unproven.

- §8.2 · **A fast ticker does not guarantee immediate premise evaluation.**
  - The source uses per-position cadences of approximately one to three minutes.
  - NAS100’s 4.290-second close is confirmed by the statement.
  - The prior report supplies its 2.633-point premise gap and 392.11-point original stop distance.
  - `premiseAtFill` checks bracket placement, but imposes no minimum risk- or spread-normalized premise distance.
  - That admits premises roughly 0.0067R from the fill in the reported example.
  - This is a policy-quality concern, not proof that every quick close is wrong.
  - The +0.5R Chandelier change merged at 18:53:58 SGT, after GER40 and that NAS100 trade had closed.
  - Those earlier closes cannot demonstrate failure of the later threshold.

- §8.3 · **A pending protection gap remains visible in the latest statement.**
  - 47790949 still lists SpotCrude BUY LIMIT, four lots, entry 68.548, TP 100.759, SL blank.
  - The latest PDF’s second page was visually inspected to confirm the empty SL column.
  - This is a pending order, not proof of an already unprotected open position.
  - The existing report says it is external to bot pending-order tables and depends on adoption/guardian protection after filling.
  - That protection path needs a fresh authorized readback and retained fault evidence.
  - No cancellation, amendment or account action was performed by this audit.

---

- §9 · **Plan delivery is mixed, rather than universally illegitimate.**

| Plan/workstream | Relevant PRs | Assessment |
|---|---|---|
| Account quantities and lifecycle truth | #1300, #1306, #1318, #1338–#1341, #1348, #1350, #1359–#1364 | Substantive corrections to broker units, quantities, receipts and reconciliation. Broad financial benefit remains unmeasured. |
| NASA-2 research instruments | #1355, #1380 | Real import/timer/monitor qualification work. Useful foundations, not trading alpha. |
| NASA-3 quantity contract | #1359, #1360, #1362, #1364 | Distinguishes filled and residual quantities; operational completeness remains a separate requirement. |
| NASA-4 account costs | #1344, #1358, #1361, #1362, #1364 | Broker comparison improved. The admission gate still reads a class schedule; intentional staged scope, not completed cost integration. |
| NASA-5 fault acceptance | #1366, #1368–#1372 | 71 covered, 31 gaps, two not applicable. Incomplete resilience qualification. |
| NASA-6 bar-form validation | #1365, #1367 | Actual train/confirm split and bootstrap verdict. Does not automatically qualify the separate exit-replay experiment. |
| Premise and trailing corrections | #1374–#1378 | Executable premise and +0.5R arming changes are substantive. Noise distance and monitor timing remain concerns. |
| Closed bars, schedule, activity | #1382, #1388 | Storage/scheduling corrections and tick-activity measurement. Repaired bars do not recompute old labels. |
| Dynamic market context | #1384, #1386, #1387, #1389 | Investigation and design delivered. Dynamic proactive controller intentionally not built. |
| Class routing and strategy Set B | #1390, #1392 | Documented owner-directed changes. Small-sample rankings do not establish future profit; activation transition is incomplete. |
| Profit-at-scale research | #1391 | Written plan with material prerequisites; no demonstrated scalable net edge. |
| Rust migration | #1393 | Recording the deferred plan follows its documented scope. It is not a completed platform improvement. |

- §9.1 · **Fault coverage is narrower than system-wide qualification.**
  - Matrix dimensions are 13 order/exit forms × eight adverse events: 104 cells.
  - 71/102 applicable cells are marked covered; that is approximately 69.6% of this declared matrix.
  - It is not 69.6% system reliability, code coverage or operational acceptance.
  - No separate account × instrument-class × event-sequence coverage is encoded in that matrix.
  - A covered receipt proves a named test exists, runs and passes under the recorded runner.
  - The matrix explicitly does not prove that every receipt asserts the intended invariant.
  - Missing areas include manual-order restart/underfill/storage failure, pending-fill restart, stop-loss restart,
    take-profit restart/storage failure, and time-cap missing/duplicate/underfill/stale/restart/storage failure.
  - These are explicit implementation-evidence gaps; not proof that all those runtime paths currently fail.
  - Source: [matrix](https://github.com/ang-kl/bot-trade/blob/423938458f22bde1b39d531761e05870ecb24b76/agent/acceptance/matrix.json).

- §9.2 · **Calibration inputs are not fully qualified.**
  - `classifyLoss` resolves a bar touching recovery and continuation by the bar’s close.
  - That cannot establish which barrier was reached first.
  - Its `stop_hunt` text nevertheless says the direction was right and the stop too tight or entry too early.
  - #1382 repairs stored closed bars, but leaves existing classification/detail fields unchanged.
  - Capture-time classification still consumes the full fetched reply before closed-bar storage filtering.
  - The separate exit-counterfactual endpoint declares no spread, slippage, commission or swap model.
  - Its chronological holdout was not implemented in this pin.
  - These limitations prevent treating a higher replay R as demonstrated higher net profit.
  - Sources: [classifier:103](https://github.com/ang-kl/bot-trade/blob/423938458f22bde1b39d531761e05870ecb24b76/agent/services/loss-postmortem.js#L103), [capture:615](https://github.com/ang-kl/bot-trade/blob/423938458f22bde1b39d531761e05870ecb24b76/agent/services/loss-postmortem.js#L615), [cost model](https://github.com/ang-kl/bot-trade/blob/423938458f22bde1b39d531761e05870ecb24b76/agent/services/exit-counterfactual-extended.js#L119).

---

- §10 · **The losses do not establish that the strategies were right.**
  - On 47790949, JPN225, GER40 and JPYX net −USD 670.01 across their statement deals.
  - They account for approximately 55.4% of that account’s USD 1,210.43 negative-deal total.
  - Cotton and AUDUSD offset USD 467.68; ignoring winners distorts the diagnosis.
  - On 46130058, SHOP.US contributes +USD 216.85 while total net remains −USD 70.58.
  - Both selection quality and payoff distribution matter; counting stop-outs alone misses that structure.
  - Later price recovery does not establish an executable, risk-compliant profitable alternative.
  - A correct stop execution can reveal a weak entry, premise, horizon or payoff policy.
  - A defective execution requires separate evidence of violated timing, identity, fill or protection contracts.

- §10.1 · **The repository’s own research baseline reports an unproven edge.**
  - #1391 reports the clean bot-origin stream at approximately −0.06R mean and PF 0.84 in R.
  - It reports +USD 206 gross becoming −USD 31 net after signed costs of −USD 237.
  - Those are claims from its historical 30-day dataset, not recalculations from these PDFs.
  - The underlying private 271-trade export was not available to independently reproduce that baseline.
  - Its period, origin filter and accounting grain differ from the supplied statement population.
  - These numbers cannot be silently substituted for the statement totals or compared as identical cohorts.
  - They do establish that the current plan itself does not claim a proven profitable stream.
  - Source: [profit plan](https://github.com/ang-kl/bot-trade/blob/423938458f22bde1b39d531761e05870ecb24b76/docs/profit-scale-research-plan-2026-10-16.md).

- §10.2 · **The latest policy changes have insufficient forward evidence here.**
  - After #1392’s merge time, the statements contain only two newly opened-and-closed SGD demo deals,
    five USD deals on 47790949 and four on 46130058; no live deal.
  - Merge time is not verified deployment or effective-policy time.
  - These are closing-deal counts, not independent strategy opportunities.
  - Same-symbol trades across accounts share market risk and cannot be treated as independent replications.
  - No before/after matched cohort establishes improved whole-position PF, win rate or expected net profit.

---

- §11 · **The recurring failure is acceptance integration.**
  - Local mechanisms have improved, but cross-path state transitions remain incomplete.
  - Examples: startup OFF settings versus runtime enablement; bar-form holdouts versus exit replay;
    stored-bar repairs versus unchanged labels; captured commission terms versus gate consumption.
  - Green checks did not prevent later exact-head P1 findings; the optional review check is permissive by design.
  - Missing historical versions and per-position receipts prevent decisive incident attribution.
  - Some PRs repair symptoms; several fix genuine foundations.
  - The missing link is reproducible system-level acceptance and economic evidence for the combined deployed policy.
  - Explicit owner-directed work and deliberately unbuilt plans are not automatically unauthorized drift.

- §12 · **Recommended work order; no implementation authorized by this review.**
  - Verify the currently working SpotCrude order and protection-on-fill path through existing authorized read access.
  - Resolve the three current P1 conditions and retain regression evidence for their actual paths.
  - Correct historical version/timestamp claims and retain per-position monitoring receipts for future incidents.
  - Finish the applicable fault matrix, then validate combinations of accounts, instrument classes and adverse sequences.
  - Qualify replay labels, entry-bar state transitions, original risk, costs and chronological holdouts before selecting rules.
  - Evaluate a frozen policy on subsequent complete bot-origin position lifecycles, with costs and shared account exposure.
  - Report implementation verified, operations validated and financial objective demonstrated as separate states.
  - Do not count #1394 or other unmerged work as completed fixes.

---

- §13 · **Evidence package.**
  - `README.md`: portable offline reproduction instructions and package boundaries.
  - `attachment-manifest.json`: original PDF provenance, bundled text paths and SHA-256 hashes.
  - Five extracted statement `.txt` inputs are bundled beside the reconciliation script.
  - Original PDFs are not bundled; their names, sizes and hashes identify the owner's source uploads.
  - `statement-reconciliation.json`: normalized deals, exact balances, totals and snapshot comparison.
  - `reconcile_statements.py`: reproducible decimal reconciliation.
  - `pr-window.json`: exact 100 merges and interleaved direct commits.
  - `100-pr-ledger.csv` and `100-pr-ledger.md`: every PR, purpose, changed files and gate record.
  - `prs/<number>/`: original API metadata, review comments, checks, merged diff and production diff.
  - Each of the 100 PRs has both diff files bundled, including an empty production diff for documentation-only changes.
  - `checks-at-merge.json`: timestamps evaluated at merge, not only latest check status.
  - `boundary-empty-body-probe.json`: bounded offline reproduction and its limitation.
  - `public-health.json`: public deployment observation; no private trading claims.
  - The initial audit generated files outside the application checkout; publication PR #1395 adds the report, ledger and ZIP to `doc/`.
  - No application code or production trading state changes with this publication.
  - Publication correction, PR #1395: the archive now includes the statement inputs and all PR diffs;
    scripts resolve files relative to their own location. The dated audit findings and trading calculations are unchanged.
