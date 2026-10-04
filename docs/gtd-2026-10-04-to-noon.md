# bot-trade: GTD work plan for 4 October 2026

Version 1.0 | Prepared 4 October 2026, 07:55 SGT | Review draft

Repository: `ang-kl/bot-trade`. Source baseline: main `94682929ff6fe1ec4d8f697d347d4f7ff3472e5e`, including #1222 and #1223. Execution starts after owner approval. Primary checkpoint: **10:00 SGT**. Contingency and final hand-back: **12:00 SGT**. Publishing this draft is authorised; executing its changes, merging this PR and deploying are not granted by publishing it.

## 1. Purpose, outcomes and an honest deadline

The business goal is **better win rate and profit factor after costs**. Working Scan -> Analyse -> Trade and position management are prerequisites. More orders, fewer refusals, successful CI or a healthy deployment are not evidence of better trading performance.

Owner targets effective **4 October 2026, 07:35 SGT**:

| Metric | Target | Owner's qualification |
|---|---:|---|
| Profit factor | >= 1.68 | 20 trades OR 8 consecutive days |
| Win rate | >= 75% | 20 trades OR 3 consecutive days |

The numerical targets are settled. Their precise windows, population and operational effect are not settled; W1 below records the choices. At 20 qualifying closes, 75% means at least 15 winners. PF is winning net P&L divided by the absolute losing net P&L. No losing closes makes PF undefined, not proof of success; no closes makes the target unassessed. Partial exits must not be counted as separate completed trades to inflate the sample.

**By 10:00:** aim to finish a trustworthy baseline, the MAE/MFE record check, an account-specific diagnosis of the largest evidenced obstacle, and a reviewable correction or explicit no-change finding. If W1 is answered, prepare the new target assessment with a regression proving its definitions. If release approval arrives and gates finish, merge the authorised exact candidate, verify deployment and inspect runtime logs. These are execution objectives, not work already done.

**By 12:00 at the latest:** stop new scope, provide the completed/pending/blocked register and all available evidence, and hand back any unfinished work with its exact next action. A deadline does not permit bypassing a test failure, an approval boundary or missing broker evidence. If access, owner definitions or CI prevent release, report the blocker rather than call it complete.

**Cannot be promised by either deadline:** realised PF >= 1.68 and win rate >= 75%; 3 or 8 new elapsed days; 20 genuine qualifying closes; a natural final partial fill; a 24-hour tick soak; all-market-open acceptance; or profitability from Chandelier. Do not create trades to manufacture sample size. Existing historical results may be evaluated as a separately labelled baseline, but must not be presented as achievement of the new forward target.

## 2. GTD capture, clarify, organise, reflect and engage

This is a project-specific application of David Allen's GTD workflow, not an official GTD template. Capture the open loops in section 8; clarify each into an outcome and physical next action; organise into Projects, Next Actions, Waiting For and Later; review at the checkpoints; engage on the highest-value action whose prerequisites are available. Reference: [David Allen Company: What is GTD?](https://gettingthingsdone.com/what-is-gtd/).

| GTD list | This morning's use |
|---|---|
| Projects | G1 trusted performance evidence; G2 target assessment; G3 reliable intended execution; G4 MAE/Chandelier evaluation; G5 controlled release and V3 closure |
| Next Actions | A1-A8 below, each with one observable output |
| Waiting For | W1-W9 below: owner policy, access, approval, time or market evidence |
| Calendar | 10:00 primary review, 12:00 final hand-back; market/session checks at actual instrument openings |
| Later / Someday | Cosmetic log labels and broad UI work; expansion and research without an evidenced performance question |
| Reference | Source documents and PRs in section 11; historical findings remain dated |

## 3. What is already done and what it achieved

Reuse these results. Do not rebuild completed implementation merely because an older handover still calls it open. Main contains the implementations; runtime acceptance is a separate column.

| Done | Outcome already obtained | Limit / source |
|---|---|---|
| #1176/#1177 | Zero-balance refusal and human-authorised Scan OFF handling; a refused scan change cannot prevent a stop | Reconcile the preserved October 1 dirty patch against these merges before touching it |
| #1178/#1179 | Account-owned pending-order reads and bounded nightly momentum work | Not continuous load acceptance |
| #1181/#1188 | Duplicate/reconciliation identity corrections | Historical money and fresh exposure disagreements still require receipts |
| #1183-#1187 | Stop policy, Opposite trigger, never-loosen rail, broker trailing after profit lock, integrated checks | Broker trailing semantics and live read-back unknowns remain |
| #1189 | Startup query remedy reduced measured first-loop latency | Later samples improved; full P1/P4 acceptance remains open |
| #1190/#1191 | Owner-confirmed measured slippage in momentum TP1 cost reserve | Do not generalise to every strategy or erase costs |
| #1192-#1195 | Scanner snapshot/alignment evidence, since-entry bar sourcing, currency labels | Registry/account alignment and native-currency runtime behaviour still need current proof |
| #1196-#1205 | Named replay segments, feed-level liveness, scanner ingress/transport diagnostics | Research found no passing candidate; remaining HTTP 400/code-56 causes are open |
| #1206 | Stored entry horizon, exit selection, native-currency sizing/loss-cap path, momentum-scope gate and follow-ups | Native-currency dispatch now has an observed FX-availability blocker |
| #1207/#1208 | Auto-disarm, separate MAE/Chandelier observer and verifier Telegram channel removed | Preserve those removals; MAE/MFE and keeper's Chandelier spec survive |
| #1209/#1210 | Gateway recovery on broker disconnect/refusal | Recovered October 4 auth/TLS incidents warrant freshness and recurrence checks |
| #1211-#1216 | Architecture/readme corrections and login gate | Logged-in UI acceptance is not newly certified |
| #1217/#1218 | Refusal units, evidence explanations, currency provenance and entry trend stamps | Legacy refusal samples and market-open paths remain unverified |
| #1219/#1220 | Smaller verifier status, bounded incidents and active-incident heartbeat | Incident ageing requires elapsed time |
| #1221 | October 4 main handover published | Corrected by #1223, not superseded in full |
| #1222 | brace-expansion 1.1.18 -> 1.1.21; local checks and exact-head CI passed; deployed commit c3afacc; HTTP 200 health with matching commit | Security improvement only. Dependabot closure remained unverified at 07:02; recheck once |
| #1223 | MAE/Chandelier addendum merged as 94682929 | Code/logic findings are inherited; no demonstrated PF or win-rate improvement |
| October 4 log review | Node scanning/analysis continued; seven protection receipts covered 11 demo positions, no missing SL/TP1 reported; three live accounts had no open positions | Dated evidence through about 07:10; protection completeness does not prove dynamic stop management |

Latest observed blockers: SGD accounts ...3489 and ...7342 skipped dispatch with `fx_rate_unavailable`; ...2148 and ...9009 unfunded. Repeated BTCUSD analysis printed R:R 1.5 and `61.8% level=undefined`. Demo/live auth and TLS interruptions later recovered. Tick `/comparisons` returned 200 around 367 ms, predominantly writing; other services recorded blank-path `status 0` slow requests. These are diagnoses to resolve, not reasons to disable protections.

## 4. Next Actions: useful work and explicit stopping rules

The durations are budgets, not guaranteed completion times. A1 and A2 provide the facts for A3-A6. A7 runs only for a settled candidate; A8 follows authorised merge/deployment. Do not start multiple speculative patches.

| ID / context | Next physical action | Budget / intended result | Done when / stop rule |
|---|---|---|---|
| A1 / @GitHub @Railway | Refresh main/open PRs, six deployment states, seven account settings/funds/currencies, protection receipts and feed/reconcile timestamps; read Dependabot once | 15 min: one timestamped readiness table with a blocker chain per account | Account identities and evidence ages explicit. Missing protection pre-empts the rest. A successful service or SKIPPED deploy alone does not prove failure or success |
| A2 / @Evidence | Read closed-trade MAE/MFE retention and cost/exit completeness; compute reproducible net WR/PF by account, strategy and direction, plus average win/loss, n and drawdown | 25 min: baseline, exclusions and reconciliation totals | One close population, costs and currency explicit. Report broker-account outcomes and bot-strategy outcomes separately; do not pool unlike currencies or average PF ratios |
| A3 / @Code @Railway | Trace ...3489/...7342 FX lookup, quote age, rate-table source, sizing and dispatch; inspect whether existing-position management shares that dependency | 25 min: exact failure condition and affected paths | Reproduce a software defect before patching. If it is intentional closed-market freshness refusal, record that and investigate an approved source policy; never invent a rate |
| A4 / @Evidence @Code | Compare MAE of winners/losers, initial-stop losses, banked R against MFE and exit attribution; reuse D1-D4 rather than run the same replays | 20 min: ranked performance hypotheses with sample sizes | Distinguish structural rationale from measured benefit. If final MAE/MFE is missing, prioritise retention; do not infer an exit improvement from incomplete bars |
| A5 / @Code @Railway | Trace one actual BTCUSD proposal through analysis, R:R/target synthesis, stage/risk decision and final dispatch/refusal; resolve `undefined` meaning | 15 min: one complete causal trace | State the exact reason the proposal does or does not progress. No lowering thresholds merely to cause an order |
| A6 / @Railway @Code | Read scanner account/registry revision/cell identity, missing spec reasons, gateway recovery freshness and recorder progress/gaps | 20 min: scanner and Chandelier coverage table | Eligible position -> valid spec or explicit exclusion; correct host/account attribution; live/demo routing isolated. Alignment mutation waits on W3 |
| A7 / @Code @GitHub | Implement only a proven correction and/or W1-confirmed target assessor; run focused regressions, final diff review and repository-required exact-head CI; prepare PR and rollback | 30-45 min per bounded candidate: concrete approved-scope change | Each check maps to a behaviour or invariant. Do not rerun unchanged checks without a reason. If cause or policy is unresolved, deliver diagnosis instead |
| A8 / @GitHub @Railway | After scoped approval, auto-merge exact checked head, verify deployed commit, then inspect repeated complete scan/analysis/decision/management cycles | 15-25 min plus CI/deploy latency: runtime receipt | Release and behaviour verified separately. If no eligible natural signal occurs, report entry execution Not Verifiable; do not force a trade |

### Morning calendar

| SGT | Work selection | Checkpoint output |
|---|---|---|
| 08:00-08:15, or first 15 min after approval | A1; collect W1 decisions together | Baseline, access limits and owner choices |
| 08:15-08:40 | A2 | Cost-aware WR/PF and MAE/MFE data-quality baseline |
| 08:40-09:05 | A3 | FX cause and management impact |
| 09:05-09:25 | A4 | Largest evidenced performance problem and next intervention |
| 09:25-09:45 | A7 if a bounded fix is proven and authorised; otherwise A5/A6 | Candidate or precise diagnosis; avoid speculative coding |
| 09:45-10:00 | Reflect; exact-head gates/release if ready | Primary report: done, outcome, evidence, blocked, next action |
| 10:00-10:40 contingency | Complete A5/A6 or the one selected correction | Close specific evidence gaps; no unrelated expansion |
| 10:40-11:30 contingency | A7/A8 for approved candidate | CI, merge/deploy and runtime receipt if feasible |
| 11:30-12:00 | Finish verification, invariant report and handover | Final disposition of every task. No new patch scope after 11:30 |

If approval arrives later, move the starting sequence and drop optional work; retain the 10:00 checkpoint and noon hand-back. More time is not permission to force unfinished evidence into Passed. Send a concise status at 15-minute checkpoints during authorised work and immediately on a material failure or decision; the interaction ends if user/access is required. No unattended task or automation is created by this plan.

## 5. Model and effort: proposed routing, not invented runtime metadata

The actual serving model, hidden reasoning setting, routing, token balance and remaining allocation are unavailable here. No claim is made that a model was switched. Recommendations below are a request to the operator where selection is available; they are not an automatic promise to create agents or incur more spend.

| Work | Suggested selection | Why / escalation limit |
|---|---|---|
| Inventory, source reconciliation, document edits and deterministic result summaries | GPT-6.1 Sol, medium | Bounded extraction and ordinary implementation; calculations use scripts, not model guesses |
| WR/PF population/cost contracts, causal entry/exit diagnosis, FX sizing and stop-authority changes | GPT-6 Astra, high | Financial behaviour and conflicting evidence need deeper reasoning; provide concrete sources and done-check first |
| Final risk-affecting diff assessment | Separate competent reviewer if authorised and available; high effort for affected money path | Challenge the invariant and counterexample; AI agreement is not independent empirical verification |
| Unexpected complex failure | Reassess cause and access first; increase effort only for a named unresolved risk | No default Ultra/max, repeated full analysis or speculative multi-agent fan-out |

Use one lead worker. Batch independent read-only tool calls where supported. Deterministic calculations, broker receipts and exact-head CI provide verification; model choice alone provides none. A specific model/effort cannot guarantee the profitability target.

## 6. Self-check: bounded tests, review and evidence

Before each change, write the failing behaviour, expected output and invariant. Reproduce once; repair; check the reproduction and adjacent affected behaviour. Run the required full gate and CI on the final candidate. Existing valid exact-source results are reused; a changed candidate may need the repository-required gate again. Repeat only because source changed, a check failed, evidence is stale, or a named invariant remains unresolved.

For docs-only preparation, check source coverage, links, task IDs, chronology and exact uploaded bytes. Do not add unit tests or repeatedly run trading suites for a Markdown edit. A PR may trigger the repository's mandatory CI; do not disable it to save time.

| Self-check | Evidence required |
|---|---|
| Correct objective | WR and PF lead; service health never substitutes for performance |
| Correct numerical targets | PF 1.68, WR 75%, 20 trades OR specified day streak, effective 07:35 SGT; definitions W1 visibly unresolved |
| Truthful sample | Whole closed positions; partials/duplicates reconciled; missing costs/currency excluded or qualified; no zero-sample success |
| Account isolation | Named account/currency/host and source timestamp on every money/decision receipt |
| Protection preserved | Mandatory SL/TP1 and never-loosen checks; independent broker read-back where available |
| Useful fix | Proven failure condition and affected-path regression, not a test that repeats implementation text |
| Outcome evidence | Costs, matched strategy/account/direction, sample size and uncertainty; no claim Chandelier improves PF without closes |
| No repetition | Completed source/PR results reused; superseded work not recreated |
| Release | Approved exact candidate -> passing gates -> merge -> matching Railway commit -> logs |
| Market-open behaviour | Real session state, fresh data, complete decision and natural broker outcome; otherwise Not Verifiable |
| Deadline | 10:00 review and noon disposition; no profitability or whole-V3 promise unsupported by evidence |
| Approval boundary | Plan approval does not silently approve registry mutation, activation, risk changes, money repair, broker actions or unspecified deployments |

Stop optional checks once these affected requirements are sufficiently verified. A reviewer wrapper skipped for a missing key is not a review. A passing unit test is not live evidence. An HTTP 200 slow request is not a failed trade. Missing logs are not proof of inactivity.

## 7. Waiting For: keep policy separate from implementation

| ID | Waiting decision / evidence | Proposed review choice / impact |
|---|---|---|
| W1 | Target windows, population, scope, start cohort and operational effect | Recommend reporting/improvement targets rather than a new global entry veto. Confirm: latest 20 eligible whole closes? Per-account qualification with portfolio reporting? Opened after effective time or closed after it? Each day separately meets target or pooled window meets target? Do no-close days break the streak? What minimum sample qualifies the day route? Both metrics required for any qualification? Preserve honest insufficient/undefined states |
| W2 | Live account for 10 October, funds and daily loss cap | ...3489 held SGD 51.41 in the dated log; ...2148/...9009 zero. No funding or live activation implied |
| W3 | Timeframe ...0058 versus ...9908 and exact registry retire/re-anchor payload | Read current registry before asking; handover says attempted CAS was refused while other notes imply retirement. No bypass of classifier; no double application |
| W4 | Pooled D4 strategy switch-off and tick promotion/switch-on | Research showed no passing candidate. A human switch-on does not erase evidence qualification; 24-hour soak remains later |
| W5 | MAE/Chandelier visibility and empirical success criteria | Propose read-only eligible/spec/missing-reason visibility. Assess WR/PF plus MFE retained, small-profit stop-outs and drawdown; keep evidence confidence separate from target thresholds |
| W6 | Stop-policy broker unknowns and actual market hours | Verify trailing read-back, omitted-flag reset, trailing anchor and TP trigger effect on existing positions; do not issue manual test amendments |
| W7 | Scoped production release / operational payloads | Present concrete PR/head, affected services, tests, intended behaviour and rollback. With explicit approval auto-merge after gates, then check logs. #1222 approval is exhausted |
| W8 | Access, operational acceptance limits and host | Use existing secure access; never ask for secrets in chat. Clarify remaining load/retention/recovery limits, external observer and soak host where still applicable |
| W9 | Human-only remaining operations | TradingView closes on ...0949, Monday deploy freeze, verifier variable ownership and historical-money repair decisions; retained backlog state must be reconciled with #1207 removal before any action |

Until W1 is answered, implement no contradictory target gate. Read-only baseline/diagnosis can proceed independently after execution approval. The existing PF-only historical gate is documented, not treated as the owner's new policy. A stale 15-August deadline must not be reused as this target's deadline.

## 8. Complete carry-forward register from retrievable sources

This preserves all outstanding categories recoverable from the October 4 handover, its addendum, October 3 plan, older V3 closure/acceptance plans and this conversation. It is not a claim that unseen chats are fully captured. Each older requirement must be reconciled with later releases before execution. Historical acceptance counts are not live evidence.

| Register | Current disposition and next action | Source / relation |
|---|---|---|
| New WR/PF targets | Waiting W1; prepare tested, cost-aware assessment after confirmation; no promised achievement by noon | Owner order 4 October 07:35 effective; A2/A7 |
| R1 refusal-cost ledger | New unit exists; week sample of 756 scored refusals was legacy. Wait for valid newly scored examples; do not repeat old result as new proof | #1217; handover 1C.2 |
| R4 entry trend | Code helper exists; market, closed-market, HTF, momentum-limit and pending paths need suitable runtime samples | #1218; market/session waiting |
| R3 money/currency | Broker deposit currency provenance exists; confirm native unit/FX source before pooling or sizing | #1218; A2/A3 |
| Replay D1-D4 and pooled strategy action | Reuse results: widening unsupported, D2 unmeasurable, R:R unit matters, three pooled strategies off by evidence. Owner decides actual switch-off | replays-2026-10-03.md; W4 |
| MAE/MFE retention | Check final closed-trade values before an outcome comparison; add missing record only after proven gap | #1223 sections 4.3/4.4; A2/A4 |
| MAE distributions | Study winners/losers, initial-stop loss concentration, entry timing and within-trade excursion | #1223; A4 |
| Chandelier wiring/spec coverage | Reuse keeper/no-observer/stop-policy/trail-engine checks; inspect bars, ATR, digits and host. Make exclusions explicit | #1182/#1193/#1223; A6 |
| Chandelier authority and outcome | Check momentum-book exclusion, only-ratchet/no-second-amend authority, engine/broker agreement; compare actual net outcomes later | #1223; A6/W5/W6 |
| P0/P3 target/partial lifecycle | Existing formula contract stands, T4 option (a) is recorded resolved on 3 October. Natural final partial/TP1 reduction, min-volume/off-grid refusals and ownership/reservation receipts remain | #1170-#1172/#1190/#1191; no duplicate synthesis test unless a changed path fails |
| P0 old position exceptions / stuck exits | Refresh actual position identity/status before proposing action; closed historical book rows need no amendment. No direct exit/amend/cancel | integrated plan / October 3 plan; W9 |
| P1/P4 protection timing | Keep #1189 improvement and October 4 9-81-second samples dated. Obtain phase attribution, representative load/recovery, desktop/phone traces and LCP/CLS under agreed limits | P1/P4; A1/A5, later graded window |
| P2 calendars/roster | Reconfirm seven maps, exact profiles/calendar coverage, Sunday boundary and later holiday/DST dates. Do not recreate resolved roster policy | P2 K3/WEB-6b/S-8; A1 |
| P5a independent watchdog | Verifier incident/protection record survives. External observer and bounded detection/recovery evidence need scope reconciliation | #1198/#1199/#1219/#1220; W8 |
| Verifier incident ageing | Record active versus total, repeat about one week later; old no_orders notices should age from opening | #1219/#1220; not achievable by noon |
| Removed Telegram notification work | Mark delivery/unmute/channel restoration superseded by #1207. Handover's 512-item human backlog note conflicts with removal notes; verify remnants/credentials instead of recreating delivery | October 3 plan, October 4 handover; W9 |
| P5b/P5d accounting and history | Enumerate unresolved position/deal/P&L/exit/currency rows, 6 historically repairable versus newer 16-missing summary, raw broker exposure vs ledger/reservations. No guessed or destructive repair | #1170/#1172/#1206; A2, W9 |
| P5b performance population | Separate pre-contract, broker-pending, live-gap, outside-bot and undecidable records; preserve exclusions and net costs | A2/A4; no headline from incomplete subset |
| P5c scanners | Refresh registry revision, identities, exact maps, profile counts/bytes/native capacity/parity/comparisons; resolve intended timeframe account and retirement state | #1192/#1201-#1205; A6/W3 |
| P5c unresolved instrument names | SPX500/USOIL/UKOIL need exact broker-owned names; no guessed aliases or universe expansion | older scanner handovers; W3 |
| Gateway transport task 125 | HTTP 400 and three code-56 resets remain causes to read. Add recovered auth/TLS cluster and phase-duration evidence; do not repeat shipped DNS/listener/curl fixes | #1202-#1205/#1209/#1210; A6 |
| P6/P7 tick research | Profile/sample provenance, Q2 and conditional Q5/GW-2, promotion/sunset/retention and research-path decisions; reuse failed research/exits grid, do not rerun unchanged inputs | October 3 plan; evidence required before promotion |
| Tick P6c/P6d | Named human activation plus passing evidence, then dedicated-host 24-hour soak; currently no passing candidate recorded | task 37/120; W4/W8 |
| Tick programme historical definitions | Option 2 observation, realistic shadow and stronger statistics already built; horizon-at-entry/exit selection and trial-scope definition implemented #1206. Verify behaviour rather than ask for resolved definitions again | tasks 66/67/70/101; #1206 |
| P8 storage/capacity/recovery | Refresh actual volumes, recorder caps/segments/gaps/drops/spool trends; distinguish host free space from quota. GW-1 branch inventory, durable retention/recovery/cost and soak-host evidence remain | P8/GW-1/task 123; A1/A6, W8 |
| REC/WEB and reasons | Logged-in UI, freshness/native-currency labels, full traces, truthful empty/partial states and remaining close reasons; prioritise where they affect outcome evidence | REC/WEB; A2, broad UI later |
| Natural trading acceptance | Observe eligible ordinary path, actual broker fill, protection, partial and reconciliation; no synthetic production order for acceptance | P0/P3/P8; real events and market hours |
| Stop-policy broker unknowns | Four unknowns from section 7; read rather than assert resolved | stop-policy.md; W6 |
| Small log defects | Direction/trend absent on market-closed refusal; slow write phase; shared cpp-exec log prefix. Raise only if it harms causal diagnosis or times out | handover 1D; A5/A6 or Later |
| Old effort annotation mismatch | Preserve dated note about 210d794c; no history rewrite solely for metadata | handover 1D.4; reference only |
| October 1 unpublished work | Preserve all dirty files; compare against #1176/#1177 and later main to identify superseded/remainder. Do not reset, clean, cherry-pick the entire patch or reopen fixed defects | v3-handover-2026-10-01.md; repository workspace invariant |
| October 3 plan task 123 | Target synthesis duplicate withdrawn after 83 existing tests; P1/P4 first-loop, P2 Saturday coverage and P8 allocations measured. Sunday/current measurement, full history rows, traces and retention remain | plan-2026-10-03.md section 5; handover 1B |
| V3 group acceptance task 75 | Close each row only against its evidence and owner observation. Implementation, assistant verification and owner acceptance are distinct | revision 3, closure and acceptance sequence |
| Security alerts | #1222 merged and deployed; check automatic #40-#42 closure without dismissal | A1; no performance claim |
| Unknown earlier chats/tasks | Exact earlier reply lists could not be retrieved. Invite additions, keep sources/versions explicit; do not label all historical work exhaustively verified | provenance gap |

Nothing parked here is silently cancelled. No telemetry, UI polish or model switch substitutes for WR/PF improvement. Work that requires days, market events or owner action stays in Waiting For with a next evidence date rather than filling this morning's execution list.

## 9. Auto-merge, deployment and market-open acceptance

The owner wants automatic merge and log verification. Once a concrete PR/head and its resulting production deployment are explicitly approved, merge when the required gate succeeds, verify the deployed commit and review logs without asking again within that scope. Do not rely on #1222's exhausted approval or the repository's older standing merge exception to override the owner's current production APPROVE rule.

For each account after a release: record effective Scan/Analyse/Trade settings, funding/currency, fresh feed/calendar, analysis completion, ordered admission/risk decision, dispatch/broker receipt if one occurs, reconciliation, and existing-position monitoring/protection. An intended funding/session/risk/evidence refusal stays; an unintended implementation blockage is corrected. Tick research eligibility is separate from an ordinary timeframe path. No blanket enablement or gate removal.

Market-opening proof must use each instrument's actual calendar and current quote, not one global Monday time. Runtime read-backs on open crypto or existing positions can be useful today where data exists; they do not prove every weekday market. Later open-market checks include Chandelier spec push/engine/broker agreement, trend stamps and natural fill/partial lifecycle. A Sunday absence of bars cannot be read as empirical Chandelier failure.

Rollback proposals must specify the prior deployment/commit, affected service and limits. A rollback cannot undo already executed broker actions; reverting a stop-policy setting does not revert previously stamped positions. No direct broker action is authorised by this plan.

## 10. Preparation self-check and invariants report

| Material invariant / preparation check | Status and evidence at publication |
|---|---|
| Core objective is WR/PF, not throughput | Passed: sections 1, 4 and 6 |
| New target numbers and unresolved semantics retained | Passed: section 1 and W1; implementation remains Not Verifiable |
| October 4 handover and MAE corrections included | Passed: fetched from immutable main baseline, source index below |
| Older outstanding groups carried and reconciled | Passed for retrievable sources: section 8 covers P0/P3, P1/P4, P2, P5a/b/c/d, P6/P7, P8, REC/WEB and new items. Absolute completeness of unseen conversations is Not Verifiable |
| No profitability deadline invented | Passed: business goal retained, noon performance achievement explicitly Not Verifiable |
| Existing dirty source/work preserved | Passed: document created separately; no application patch/reset/clean performed |
| Risk limits, broker positions/orders, credentials, account activation and registry | Passed for this preparation: no mutations of these surfaces |
| Merge/deployment | Not executed: review branch/PR only; no main merge or deployment performed for this plan |
| Actual model/effort/usage metadata | Not Verifiable: section 5 contains recommendations only |
| Remote document and downloadable file match | Pending final upload verification; report the result to the owner after publication |

## 11. Source index and provenance

Project sources were read at main **94682929**; latest-source corrections outrank older frozen-state claims. Links below retain project-relative paths and PR identity. Dated production findings were inherited from the named reports or the October 4 service-log review; this document does not refresh them into current truth.

- [October 4 handover](handover-2026-10-04.md), #1221: main outstanding categories, merged work and limits.
- [October 4 MAE/Chandelier addendum](handover-2026-10-04-addendum-mae-chandelier.md), #1223: corrects the observer/MAE account, identifies missing outcome evidence.
- [October 3 plan](plan-2026-10-03.md): dated V3 group measurements, resolved owner decisions and superseded notification work.
- [October 1 handover](v3-handover-2026-10-01.md): original dirty-work preservation and natural-lifecycle carry-forward, with later dated notes.
- [September 26 integrated plan](v3-integrated-plan-2026-09-26.md), [frozen closure register](v3-closure-2026-09-24.md), [acceptance sequence](v3-acceptance-sequence-2026-09-23.md): specifications and required acceptance, not today's runtime state.
- [Revision 3 approved plan](performance-cards-reassessment-2026-09-22-revision-3.md), [revision 3 progress](revision-3-progress-2026-09-22.md): architecture, P0-P8 invariants and implementation provenance.
- [October 3 replays](replays-2026-10-03.md): PF 0.78 over 294 dated closes and initial-stop concentration are inherited measurements, not recomputed current baseline. No MAE/Chandelier benefit was established.
- [Stop policy](stop-policy.md): broker semantics and approval boundaries.
- [Goal defaults](../agent/services/goal-tracker.js), [edge bars](../agent/services/edge-bars.js), [tick-validation thresholds](../agent/config/tick-validation.json): inherited current-code thresholds; W1 defines the proposed new target change without silently altering tick eligibility.
- [Security PR #1222](https://github.com/ang-kl/bot-trade/pull/1222): verified CI/deployment in this session, no demonstrated performance gain.
- Owner's six Railway JSON exports uploaded 4 October and read from their provided scratch copies: bot-trade `1791068852354`, cpp-exec `1791068823671`, cpp-acct `1791068800917`, cpp-scan-tick `1791068771714`, cpp-verify `1791068750795`, cpp-scan-timeframe `1791068723019`; live connector log refresh reached about 07:10 SGT. Logs with shared cpp-exec prefix are attributed by Railway service ID, not prefix.
- [David Allen Company GTD overview](https://gettingthingsdone.com/what-is-gtd/): workflow reference; project timing, task priorities and assurance boundaries are this plan's own judgement.

AI NOTE: weakest stage is Evidence: complete after-cost closes and actual market behaviour are missing. Cheapest useful fix is a verification loop over one account's whole-close data and one actual decision-to-broker trace. Stop at the named done-check; report missing evidence rather than generating more activity.
