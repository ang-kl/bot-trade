# Forward performance targets and morning execution checkpoint

Prepared 4 October 2026, 09:22 SGT. Repository: ang-kl/bot-trade.

## Owner goal and agreed definitions

Effective 4 October 2026, 07:35 SGT (2026-10-03T23:35:00Z), assess each account separately:

| Metric | Latest sample route | Consecutive-day route |
|---|---|---|
| Win rate | At least 75% over the latest 20 whole closed positions | Each of 3 consecutive SGT days reaches 75% |
| Profit factor | At least 1.68 over the latest 20 whole closed positions | Each of 8 consecutive SGT days reaches 1.68 |

The owner confirmed latest 20, per account; each qualifying day independently meets its threshold with at least one eligible close; empty days break the streak; assessment is reporting only. The implementation counts completed SGT days. Today remains provisional. Both routes use positions closed after the effective instant, even if opened earlier. Partial closing deals count once after the whole lifecycle closes. These targets do not change order admission, activation or risk limits.

Use balanced, validated broker whole-position lifecycle evidence under the current reader rules. Its broker-native net is gross plus signed commission plus signed swap, following the existing repository money convention. Conversion fee is reported separately and is not newly deducted. Host and deposit currency provenance must match. Missing evidence remains pending rather than being discarded to improve the rate. Undated closes or unattributed forward closes prevent qualification until reconciliation. The reader performs no broker fetch or money repair.

Win means net > 0; scratches count as non-wins. PF is positive net divided by the absolute sum of negative net. No gross losses means PF undefined, not a passing value. Thresholds use unrounded arithmetic. No sample is not assessed. Daily evidence and latest-20 evidence are separate OR routes for each metric. No pooled money or cross-account qualification is computed. Coverage concerns observed identities; the report does not certify unrecorded broker history.

## Work completed and observed outcomes

| Work | Outcome | Evidence / limitation |
|---|---|---|
| #1224 GTD plan | Merged; reference register for all retrieved outstanding work | [Original GTD register](gtd-2026-10-04-to-noon.md), including October 4 handover and MAE/Chandelier addendum |
| Security #1222 follow-up | Dependabot now shows 0 open, 42 closed; #40-#42 fixed | Fresh GitHub security UI check about 09:00 SGT; no alert dismissed |
| Reporting #1225 | Merged bf90e3d; deployed successfully; web and agent match and health is OK | Live card withholds pooled PF and missing-P&L qualification; shows USD/SGD balances explicitly |
| #1225 validation | 7,474 backend passes with 4 pre-existing skips; 1,313 frontend passes; lint, build and colour gate pass; exact-head CI success | UTC matched CI. Independent Claude action skipped; manual review performed. These checks cover #1225, not the new target candidate |
| Runtime after #1225 | Scan and BTCUSD analysis complete; protection covers all 11 open positions, zero missing SL/TP1 | Railway 09:15-09:17 SGT; protected does not establish dynamic-stop or natural-entry acceptance |
| Target definition W1 | Resolved by owner during execution | Implemented in this candidate; release and fresh runtime acceptance still pending at preparation |
| Target candidate validation | 52 focused backend and 6 component tests pass | Exact thresholds, SGT streaks, partial identity, stale receipts, missing money, account scope and unavailable reader; full release gate pending |

## Current blockers and next evidence actions

| Action | Disposition at this checkpoint | Next observable evidence |
|---|---|---|
| A1 fresh readiness/security | Security closed; bot-trade deployment and protection refreshed | Refresh serving C++ services and account-specific settings/freshness |
| A2 performance data quality | Historical per-account reporting corrected; 19 missing P&L and 4 unattributed rows surfaced in the old all-history population | Forward target cohort reader and actual broker lifecycle completeness; strategy/direction outcome baseline not completed |
| A3 SGD FX path | Two funded SGD accounts still refuse new dispatch with fx_rate_unavailable; two other live accounts are unfunded | Direct USD/SGD quote and intentional freshness refusal; confirm existing-position management receipts separately. No stale-rate substitution |
| A4 MAE/MFE and exit benefit | Source retention and replay limits inspected; measured benefit not established | Final closed-position MAE/MFE receipt, completed cost-aware outcome sample; no inferred Chandelier improvement |
| A5 BTC proposal | Actual analysis is conviction 5/10, R:R 1.5. Fibonacci-level undefined is a shared diagnostic label | Exact effective auto-trade threshold and downstream decision receipt before attributing the final refusal |
| A6 scanner/Chandelier | Carry forward coverage, bars/ATR/spec eligibility and host identity checks | Spec receipt to engine/broker agreement; preserve observer removal and momentum exclusions |
| A7 target candidate | Implemented and focused tests pass | Full gate, exact-head CI and final review; merge under owner auto-approval until 10:00 SGT only |
| A8 release acceptance | #1225 release verified; target candidate pending | Matching deployed commit, live target cohort/read status and repeated scan/analysis/management receipts |

The original GTD section 8 remains the complete retrievable carry-forward register. P0/P3 natural partial lifecycle; P1/P4 timing/load/UI acceptance; P2 calendars; P5 watchdog/accounting/scanner/history; P6/P7 tick research; P8 storage/soak/recovery; REC/WEB; broker stop semantics; registry alignment; and October 1 preserved unpublished work remain open wherever their required receipts are absent. No old outstanding item is cancelled by this checkpoint. Existing replay results are reused rather than rerun on unchanged inputs.

## Deadline and release boundary

The owner granted auto-approval until **10:00 SGT**. Within the GTD scope, checked code/document fixes, merge and resulting deployments may proceed without routine reconfirmation before that boundary. Do not merge a failing or unchecked candidate to meet the clock. No new risk policy, account activation, credential change, registry policy or direct broker transaction is part of this reporting change.

At 10:00 provide completed/pending/blocked evidence and exact continuation actions. Achieving the implementation deadline does not mean achieving realised WR/PF. Three or eight future days cannot elapse this morning, and no trades will be manufactured to reach 20. Natural fills, final partial lifecycle, all-market opening proof, 24-hour soak and empirical Chandelier benefit still require real events and elapsed time. Any noon continuation beyond the bounded merge approval must retain the user's explicit authority boundaries.

## Review and rollback

The new assessor is consumed only by the existing goal-reporting route and UI. It adds no entry gate and performs no database mutation. The older reporting fields remain for compatibility. The UI prefers the new forward targets when supplied and falls back to the legacy view with an older agent. A reader failure displays unavailable evidence rather than success.

Before release verify full backend/frontend suites, lint/build/no-green, syntax, exact-head CI and final diff. Rollback for this reporting candidate is prior serving bot-trade commit bf90e3d; it does not undo broker events. Actual model/effort/session metadata is unavailable; none is invented.

Sources: [October 4 handover](handover-2026-10-04.md), [MAE/Chandelier addendum](handover-2026-10-04-addendum-mae-chandelier.md), [GTD plan and outstanding register](gtd-2026-10-04-to-noon.md), current code and dated GitHub/Railway/browser receipts in this session.

## Execution update: 09:37 SGT

#1226 merged as **434271811b4e728ce3758a19e1051fd2ac13af6c**, exact-head CI **37167815850** succeeded, and Railway deployment **584ab133-7f6b-445f-bdf1-61761272f12b** succeeded. Local backend: 7,485 passes / four existing skips / zero failures; frontend: 1,315 passes; lint/build/no-green and syntax passed. All eight published file hashes matched the tested local files. The Claude review action was skipped, so only manual review is claimed.

Browser read-back: web and agent both 4342718, health OK; all seven accounts display the forward target definitions, their own currency and zero observed forward whole closes. WR/PF therefore remain **Not yet assessed**, not achieved. The UI inspection found the new expand control omitted its report body. This follow-up supplies that body and an explicit assessment-read timestamp; its release is pending at this write.

Current ordinary-entry switches: all seven accounts active, enabled, effective S/A/T ON, zero reserved/in-flight/unknown entry intents. Tick shadow is READY, but tick entries remain blocked by profile pinning/matching, replay evidence and validation stage; zero tick entry accounts on both sides. Those tick blocks do not disable ordinary timeframe entries. Demo/live sidecars report connected and their correct authorised account rosters. Independent protection receipts around 09:36 SGT cover 11 positions, no missing SL/TP1. The post-deploy scanner and BTC FVG analysis ran; subsequent full-cycle verification remains in progress.

Read-only management review: keeper is ON with all-positions scope. MAE/MFE are updated on monitored positions; the normal reconcile-close path changes status to closed without deleting those values. That proves structural retention of the last sampled value, not complete final-tick excursions. Postmortem bar windows can clip earlier holding periods. Recent management heartbeats are healthy, but the observed latest fast-monitor pass evaluated zero positions and keeper amendment outcomes are unobserved. The Chandelier trail line query returned no matching post-deploy line, and the UI reports tick trailing not reported/disabled. Do not call Chandelier acceptance Passed or change the policy to manufacture an amendment.

Eligibility for keeper specs is narrower than all broker-open positions: current scope, active monitored linkage, no guard_json, no keeper opt-out, no momentum-book ownership, correct account/broker identity, bars with at least 23 usable candles for ATR(22), digits and entry. The addendum's spec-count expectation must use eligible non-book rows, not all 11 open positions. No verified current per-position eligible denominator is available.

Railway confirms prior SUCCESS serving deployment identities for all five C++ services; recent deploy-log queries returned no rows, so fresh runtime health is taken only from the UI receipts where available. Scanner comparison/profile/cell parity, raw latest C++ logs and engine-to-broker trail agreement remain unverified. The Tune per-account summary still mislabels SGD balances as USD; the Performance/Desk money and new target card have correct units. This remaining label defect is carried forward.

The seven-day all-account veto read reports 74 approvals, 2,538 risk veto records (977 distinct) and 75,333 upstream skips. The displayed guards include 18,142 R:R prefilter shortfalls, 15,702 position-cap skips, 10,147 dated margin-pool skips, 7,076 unfunded-account skips and 7,435 minimum-lot funding exclusions. These are event counts across the seven-day population, not this morning's BTC final cause or independent trades. BTC's current analysis remains 5/10 at 1.5R; its exact effective threshold and final decision receipt are still unverified. No gate was lowered.

GTD disposition: A1 refreshed with the limits above; A2 reporting corrected and forward assessment released, strategy/direction/MAE outcome baseline incomplete; A3 FX entry refusal diagnosed in code/logs, dynamic management acceptance incomplete; A4/A6 outcome and Chandelier/scanner acceptance remain open; A5 has recorded guard evidence but no complete current BTC causal trace; A7/A8 completed for #1225/#1226, UI follow-up pending. The original section-8 outstanding register remains in force. Business targets have not yet been demonstrated.
