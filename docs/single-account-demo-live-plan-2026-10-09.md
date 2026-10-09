# One-account demo → one-account live plan

**Codex · №12,495 · single-account-plan · 9 October 2026**
<!-- Codex · №12,495 · 2026-10-09; codex-footprint: single-account-plan; documentation only. -->

**Engineering review cutoff: 15 October. Planned live decision: 19 October.**

**Screenshot update — Codex · №12,502 · 9 October 2026:** the owner has now supplied the missing account picture; see §9. It shows live account **42993489 active with S/A/T on**, so the pictured setup does not yet enforce the planned demo-only new entries. This update supersedes the earlier “screenshot unavailable” limitation for the fields actually visible. It does not establish the picture's capture time or certify hidden risk settings.

This is a settings and verification plan, not an instruction already applied. No trading code, account mode, risk limit, stop, order, credential, scanner profile or deployment was changed for this document.

## 1. Recommendation and verified baseline

Use **DEMO 5067353 / account 43097342 / SGD** for new demo trades, then assess **LIVE 1251247 / account 42993489 / SGD** for the owner's 19 October decision. Keep the other accounts exactly as the owner configured them and continue protecting their existing positions.

For this build, prefer **timeframe-based entries with existing tick-triggered position monitoring/profit-taking**. Tick-based entry is a different feature and is not required to obtain tick-triggered exits. There is no verified performance comparison establishing tick entry as superior for these two accounts. Do not activate it simply because it reacts faster.

Keep the owner's goals unchanged: **WR 75%; PF 1.68**. Reducing capital or account count is not a reason to relax either target. These are reporting objectives, not newly invented entry vetoes.

| Evidence | What is established | Limit |
|---|---|---|
| Fresh GitHub main | `558850b5719a5c3c0216e5db225363b6e0ff0c4a`, PR 1281; current code inspected | Code defaults are not proof of stored overrides |
| Production identity | Node serves `558850b`, version 0.1.381 at 12:23:03 SGT on 9 October | A healthy response does not prove every trading setting |
| Production platform | All six services online, one replica each; settled native deployments unchanged | No service shutdown is recommended |
| Account intention | Owner reports only 43097342 is now used for demo; 42993489 is the future live account | Current mode/phase/arming/risk snapshots were not available through a bound application read credential |
| Instrument expansion | At 11:38 SGT both target accounts had 240 watchlist rows and 39 broker-classified indices; HK-share exclusion applied | Equal counts do not prove identical members, contracts or enabled flags; no extra UTC+8 stocks qualified |
| Native hybrid | At 12:23 SGT both live/demo engines ready, configured 0, pending 0, queued 0 | No enrolled hybrid plan or natural hybrid fill is established by this snapshot |
| Reused movement proof | Prior owned GER40 account 47790949 native movement → stored journal → broker-stop link was verified | It belongs to another account; it does not certify the two target accounts |

**Assumptions:** “below $2,000” means **below SGD 2,000**; exact starting capital and leverage remain to be confirmed. The new screenshot referenced in the request was not present in the received message. Other accounts' precise current modes therefore remain unverified; no older screenshot is substituted. This session has connected GitHub/Railway reads but no bound application read key. No credential request or protected-route retry was made.

## 2. Advantages and disadvantages

| Advantage | Qualification |
|---|---|
| Both accounts use SGD | Easier account-to-account comparisons and native net-profit reporting. Instruments quoted in other currencies still require fresh broker FX for sizing and costs. |
| One new-entry account | Fewer account-specific risk evaluations and fewer opportunities to confuse ownership. Existing positions on other accounts still require management. |
| Cleaner forward experiment | The same intended strategies, economic instruments, risk percentages and exit policies can be compared without pooling accounts. |
| Less operational complexity | One demo run can be audited through intent, fill, protection, partial and whole close. It does not remove shared database or Node bottlenecks. |

| Disadvantage | Response |
|---|---|
| Fewer independent whole closes | WR/PF and day-streak evidence may arrive more slowly. Do not force trades to reach a sample count. |
| Demo fills differ from live | Match broker product/contract, fees, spread, minimum volume and margin; demo execution still cannot guarantee live liquidity, slippage or rejection behaviour. |
| Small capital constrains position sizes | Some index/share contracts or exact 50% partials will be unaffordable or unrepresentable. Correct refusal is preferable to increasing risk to make the feature fire. |
| Concentration | One account removes cross-account diversification; many index symbols can still represent the same underlying exposure. Keep cluster/currency/notional controls. |
| Same settings can produce larger individual trades after consolidation | `sharedSignalRiskSplit:'equal'` divides risk across eligible accounts. With only one recipient, that division can disappear. Compare the actual final sized risk; do not assume consolidation always reduces each trade's size. |
| Savings are conditional | `manage_only` can still scan. Shared scans, breadth of 240 symbols and management of old positions remain. No 7× speed-up or automatic improvement in analysis quality is claimed. |

## 3. Exact settings supported by current code

**All entries below are recommendations for review, not applied changes.** Read effective values and their account/global origin before editing. Use account-scoped settings; never reset an entire risk configuration to defaults.

| Control and real implementation | Recommendation | Current-value status / side effect |
|---|---|---|
| Account mode: `active`, `manage_only`, `paused`; `/actions/registry-account` | 43097342 active for this demo. 42993489 must not start new live entries before the owner authorises go-live. Preserve the other five accounts' chosen modes. | Owner-reported single-demo intention; stored modes unverified. `manage_only` and `paused` retain general position management. |
| Account phases: `/actions/account-phases`, fields `scan`, `analyze`, `autotrade` | On the demo, confirm effective scan/analyse/entry permissions and existing strategy arms. Where the owner wants less load on other accounts, use their own Scan/Analyse switches rather than stopping shared services. | Master switches still veto per-account switches. Scan-OFF requires the owner's signed-in device under the current route. No generic `scanWhileManageOnly` API knob is invented. |
| Held positions on non-entry accounts | Prefer preserving their existing management-capable mode. Review changing `paused` to/from another mode separately if their hybrid ownership depends on it. | Capped hybrid enrolment accepts account modes `active`/`manage_only`; general protective management and hybrid enrolment are not identical predicates. Do not archive/remove an account to save load while positions/orders remain. |
| Entry mode: `/actions/entry-mode`; revision-controlled `mode` and `admittedBases` | Candidate configuration: `TIME_BASED` with `admittedBases:['bar']` on the demo; reproduce that intended entry policy on live at the approved transition. | Read `engine_status_json` first. `TIME_BASED` alone can still admit ticks if its existing overlay is `['bar','tick']`. Wait for the actual gateway epoch acknowledgement/STABLE result after any approved switch. |
| Entry-mode policy: `/actions/entry-mode-policy` | Prefer `policy:'manual'` during the comparison so the experiment does not auto-promote tick entry. | This is a supported setting; current stored value is unverified. Existing config seed says manual, but later owner overrides take precedence. |
| Scan cadence: `/actions/loop-interval`, body `{minutes:2}`; `loop_interval_min` | Retain 2 minutes if already set. Otherwise 2 minutes is the review candidate after checking cycle duration and stalls. | Global process setting, not per account; supported range 1–60. Source default is 5 minutes. Two minutes is nominally 30 cycles/hour, not guaranteed timing or hundreds of trades/hour. It does not set tick-exit latency. |
| Strategies and account pins: existing Armed-per-Account controls and `/actions/stage-matrix` with explicit `accountId`, `kind`, `key`, `stage`, `on` | Compare the actual armed strategies/timeframes and preserve hand pins. Use the intended matching strategy set for demo/live; do not turn every strategy on. | A strategy being scanned is not proof it is allowed to trade. `/actions/strategies` replaces the global list and can clear other accounts' pins: do not use it for this two-account comparison. Stored matrix and exact scope require a current read. |
| Watchlists: `acct:<id>:autopilot_symbols_json` through current account/watchlist controls | Retain the HK-share exclusion. Compare the two owned lists and use economically equivalent products with verified affordable minimums. | Keep broker IDs account-owned. Same text/same count is insufficient. Cash, futures and perpetual index variants must not be treated as interchangeable. No speculative Singapore-stock addition. |
| Broker leverage | Match the intended live account's actual leverage/product margin rules in the broker's demo setup where available. | Not a bot risk-percentage setting. Do not write a fictitious leverage/balance to the bot or use FX leverage for all CFD products. |
| Demo funding | Use broker-reported demo capital close to the planned live amount where the broker supports it. | Do not falsify the stored balance, reset trade history or abandon existing positions. A small risk cap on a large demo account does not reproduce a small account's margin constraints. |

### Small-account risk proposal — requires owner review before application

These keys are accepted by `/actions/risk-config` with `accountId`, stored under `acct:<id>:risk_config_json`, and read by the real risk engine. Their effective current values are **unverified**. Preserve any tighter existing bound.

| Key | Candidate for both target accounts | Meaning and important interaction |
|---|---|---|
| `perTradeRiskPct` | 0.005 (0.5%) or the existing lower value | A review starting point, not a measured optimum. Below SGD 2,000, 0.5% is below SGD 10 initial price-risk equivalent before costs/gaps. Do not type 0.5 into the raw fractional field. |
| `maxRiskCapPct` | At most 0.005, preserving a lower existing cap | The hard percentage ceiling also bounds an existing `perTradeRiskUsd` override. Keep any stricter absolute limit; do not clear it blindly. |
| `maxOpenPositions` | At most 2, preserving a stricter setting | Controls new entries. It does not order existing positions closed or guarantee a fixed portfolio loss. |
| `dailyLossPct` | Review 0.02 (2%) as a new-entry daily allowance | Below SGD 2,000 this is below SGD 40 equivalent. It is not a guaranteed maximum loss during gaps. The risk day is the existing FX day, not the goals' completed SGT day. |
| `dailyLossFloorUsd` |`null` for the small-account proposal | Source default is USD 200. The floor is applied last and can enlarge a small percentage cap. Its current override must be read before deciding. |
| `dailyLossTierAtUsd`, `dailyLossTierSmallPct`, `dailyLossTierLargePct` |`null` for this simple percentage-cap proposal | Otherwise the existing tier rule can replace `dailyLossPct` and bypass the flat limit. Setting only `dailyLossPct` is insufficient. |
| `dailyLossLimit` | Retain any tighter existing positive USD cap | It is USD, not SGD. With the tier disabled it can bind alongside the percentage. Do not put a desired SGD amount into this USD field. |
| `equityStopPct`, `campaign`, loss-cap/ratchet settings | Preserve; inspect before approving the daily-cap change | If `equityStopPct` is null, current code links the liquidation/disarm threshold to `dailyLossPct`. Reducing the latter can therefore change forced-close behaviour. That side effect needs an explicit decision; it is not a silent part of this plan. |
| Spread, drift, cluster/currency, margin, notional, unknown-P&L and entry RR controls | Preserve current effective values | Keep the existing 3R entry floor and all ownership/freshness protections. More affordable volume must come from legitimate sizing, not relaxed gates. |

**Critical distinction:** the source default is 5% nominal per-trade risk with a 1.5% hard cap, and a USD 200 daily-loss floor. These are source facts, **not a statement that either account currently uses them**. The proposed 0.5%/2% settings are new recommendations requiring approval, not verification of current state. Changing them does not change the 75%/1.68 reporting goals.

## 4. Stop-loss and profit-taking: what stays, what can happen

**Do not change the stop-loss or entry mechanisms for account consolidation.** Use the existing account-owned gateway on demo and live, preserving ratchet-only transactions, symbol/direction identity, TP preservation and “unchanged is not a movement.”

The current build contains several deliberately separate policies:

- General managed-exit source defaults include `trailR:0.5` and `capMinutes:0`; stored `managed_exit_json` can override them. This is a shared policy, not a per-account knob in the generic account-setting allowlist. Do not tune it globally merely to make these two accounts look alike.
- Since-entry native Chandelier specifications use 3×ATR(22), with valid account-owned prices/precision; book positions keep their separate stop authority. Do not stack a new trailing rule over them or promise every position takes the same path.
- Stop-policy source defaults are enabled, `triggerMethod:'OPPOSITE'`, trailing `on_lock`. Broker trailing is requested once the stop locks profit; current per-position acceptance still needs broker readback.
- Eligible ordinary trend/breakout/momentum bot positions use the capped hybrid: **exact 50% at 2 initial price-R**, with the residual retaining the existing broker SL and final TP. The final TP must be beyond the trigger. It is a capped runner, not an unlimited hold.
- Enrolment requires owned entry/deal/position evidence, an appropriate active/managed owner, no competing guard/book/partial authority and valid size/precision. Each half must satisfy broker minimum and volume step. Smaller capital can mean no representable half; that is a legitimate refusal, not proof the controller failed.
- Range/mean-reversion positions keep their current family policy. Current managed-exit defaults have a 1R take scoped to mean-reversion, with a 50% take fraction; do not describe this build as universally closing them in full or change them to 2R for cosmetic consistency.

**Penny-profit concern:** tick processing cannot make a small risk budget produce large absolute gains. Half closed at 2R contributes about 1R of original whole-position price-risk before costs; the runner may add or lose further profit under its existing SL/TP. Minimum fees can make a split exit comparatively expensive. Do not increase volume, lower cost filters or widen a stop to force a hybrid result. Judge reconciled whole-position net after costs, average win/loss, drawdown and runner contribution alongside the unchanged WR/PF goals.

## 5. Tick versus timeframe — use each for its actual role

| Role | Current architecture and recommendation |
|---|---|
| Market context/entry | Preserve proven timeframe strategy logic. Node coordinates scan/analysis/risk/entry admission; the scanners do not acquire trading authority by having spare CPU. |
| Stop movement | Native gateway tick ratchet plus existing broker-side protection. `cpp-exec` serves the demo route and `cpp-acct` the live route in this deployment. Retain account-owned routing and readback. |
| Hybrid trigger | Dedicated native account-owned ticks detect the enrolled 2R trigger and retain a durable native journal event on both environments. |
| Hybrid execution and records | Node still consumes the event, obtains the existing close claim, coordinates the broker partial, and stores response/residual/journal evidence. Its normal next-pass delay is 25 ms after work; configuration refresh 30 s and error backoff 5 s. This is not a guaranteed end-to-end deadline. |
| Independent check | `cpp-verify` supplies an independent account/position protection readback. It does not replace the broker fill/residual proof or make the trade. |

“Tick-based” describes the trigger source; it does not mean microsecond broker execution, or that Node can be turned off. Native decision timing, storage/fsync, transport, Node lag and broker execution are separate intervals. Healthy replicas cannot prove a missing timing chain.

The existing 690-profile warning named 43097342 after the recent boot. Source shows it refers to unmatched **timeframe observation** profiles. It does not by itself prove all timeframe entries stopped. Recheck relevance to this account-owned feed; do not copy another account's symbol IDs or register/re-anchor profiles without the owner's separate approval. Unused scanner-mirror parity remains deferred when no promotion depends on it.

## 6. Closure batch and deadlines

| When / responsible party | Work | Exit condition |
|---|---|---|
| 9–10 October; owner UI/export, then Codex review | Capture the two target accounts' effective modes/phases, entry mode/bases/policy, strategy pins, native balance/currency/FX age, actual leverage, risk overlay/global origin and protection settings. Check other accounts retain the owner's setup. | One dated comparison with exact values; every difference intentional. This can progress groups 4/7/26 and avoids repeated guesswork. No automatic live activation. |
| By 12 October; owner approves settings, Codex validates readback | Review small-account risk proposal, contract affordability, matching strategy/universe and 2-minute cadence. Apply only specifically approved settings through existing controls. | Stored effective values agree with the approved diff; no unintended risk increase, loss of protection or global-policy spillover. |
| By 15 October; Codex bounded evidence assessment | Join existing target-account entry/refusal records, stop movements, exceptions, quantity/cost receipts and complete closes. Reuse shipped fixes/tests. | Close each complete group independently; preserve missing members instead of declaring all groups passed from one trade. Priorities 4/5/6/7/13/15/16/22/26/33/34; 9 when retained full-holding data exist; 14/30 only if applicable. |
| By 15 October; Codex separate bounded investigation | For 19/27, inspect a new attributable watchdog/lag case only if there is contemporaneous function/SQL/request evidence. For 20, do the due incident-age comparison. 40 depends on a supported authorised alert read. | Reproduced mechanism corrected under new code permission, or exact causal/access gap recorded. No repeated broad tests, speculative timeout change or alert-audit substitution. |
| After an eligible plan exists; ordinary demo trading | Observe native 2R trigger → durable event → claimed broker partial → fill → exact residual → stored journal; later reconcile whole-position net and partial/runner contribution. | One real owned execution chain establishes that case. It is not a whole-population WR/PF pass. At the 12:23 snapshot there were 0 plans, so waiting blindly for a 2R event is not useful. |
| 15–18 October; owner and ordinary operation | Preserve the agreed demo configuration; only react to material failures. Gather whatever natural closes occur. | No new monitoring schedule; no forced trade, unnecessary rebuild or guarantee that the market supplies the sample. |
| 19 October; owner decision | Review engineering readiness, current operational settings/protection and the unchanged financial objectives separately. Enable only 42993489 if the owner elects to proceed. | No date-triggered switch. A live account cannot acquire its own forward performance record before live trading; demo evidence is a rehearsal, not a fabricated live pass. |

**Time-dependent goals (group 3):** current `performance-targets.js` evaluates the latest 20 whole-position candidates and leaves the metric unmeasurable if those records contain unresolved money. Scratches are non-wins; PF is undefined without losses. The forward boundary remains 4 October 07:35 SGT. Required completed-SGT-day streaks remain WR 3 days / PF 8 days, with at least one close per day; an empty day breaks a streak and today is provisional. Partial fills do not become multiple wins. Keep signed commission/swap exactly once; the existing conversion-fee reporting convention is unchanged.

15 October is a work cutoff, not a promise that natural-event acceptance passes. 19 October 2026 is Monday. If the account has no weekend closes, the empty-weekend rule can prevent an eight-day PF streak at that decision date. Do not activate weekend trading or rewrite the rule just to hit the calendar. Any unmet objective must be explicit in the owner's decision.

The older goal-tracker's `gateOn:'profitFactor'` and old deadline defaults are a separate reporting surface. The newer 75%/1.68 performance targets above are authoritative for this plan. Record 19 October as the owner's decision date without changing hardcoded goals or claiming a nonexistent settings control changed them.

## 7. Verification boundary and exit

The plan's setting names, units, routes and policy behaviour were checked against pinned main. The recent deployment and owned catalogue receipts were reused. The previously pending automatic main CI 37880024633 is now confirmed SUCCESS on 558850b, updated 11:43:48 SGT; no gate or production build was rerun for writing a plan.

**Not yet certified:** exact current account modes/arming, balances, leverage, risk overrides, stored stop-policy overrides, matched contract costs, current target-account hybrid eligibility and natural execution. These need current authorised application/broker records or the owner's actual settings display. A variable name, source default or healthy HTTP response is not that evidence.

No whole acceptance group is newly closed by this document: **7 verified / 19 active / 6 deferred; unverified overlay 25**. Keep deferred 8/10/23/25/28/29, withdrawn 18/31, closed-review 17/32/39, historical archives 11/24/37/41 and unused staging excluded. Account consolidation is not retrospective verification or a history rewrite.

**AI NOTE — weakest evidence:** the currently effective risk/account settings, especially the USD 200-floor override and planned live capital. **Smallest next check:** one dated, authorised settings comparison for 43097342 and 42993489 before approving any patch. Missing historical data must stay missing; new prospective records must be genuinely written by ordinary operation.

## 8. Source references and next-work prompt

All source links below are pinned to the inspected release, not a moving branch:

- [Account modes/capabilities](https://github.com/ang-kl/bot-trade/blob/558850b5719a5c3c0216e5db225363b6e0ff0c4a/agent/services/account-capabilities.js); [account phases](https://github.com/ang-kl/bot-trade/blob/558850b5719a5c3c0216e5db225363b6e0ff0c4a/agent/services/account-phases.js); [setting allowlist](https://github.com/ang-kl/bot-trade/blob/558850b5719a5c3c0216e5db225363b6e0ff0c4a/agent/services/setting-resolver.js).
- [Risk defaults/budget/shared split](https://github.com/ang-kl/bot-trade/blob/558850b5719a5c3c0216e5db225363b6e0ff0c4a/agent/services/risk.js#L237); [daily-floor/tier arithmetic](https://github.com/ang-kl/bot-trade/blob/558850b5719a5c3c0216e5db225363b6e0ff0c4a/agent/services/daily-loss-pacing.js#L151).
- [Supported action routes](https://github.com/ang-kl/bot-trade/blob/558850b5719a5c3c0216e5db225363b6e0ff0c4a/agent/routes/actions.js); [account-scoped risk read](https://github.com/ang-kl/bot-trade/blob/558850b5719a5c3c0216e5db225363b6e0ff0c4a/agent/routes/state.js#L3999); [entry admission](https://github.com/ang-kl/bot-trade/blob/558850b5719a5c3c0216e5db225363b6e0ff0c4a/agent/services/entry-mode.js).
- [Managed exits](https://github.com/ang-kl/bot-trade/blob/558850b5719a5c3c0216e5db225363b6e0ff0c4a/agent/services/managed-exit.js#L129); [stop policy](https://github.com/ang-kl/bot-trade/blob/558850b5719a5c3c0216e5db225363b6e0ff0c4a/agent/lib/stop-policy.js#L32); [since-entry Chandelier](https://github.com/ang-kl/bot-trade/blob/558850b5719a5c3c0216e5db225363b6e0ff0c4a/agent/services/mae-chandelier-observe.js#L21).
- [Exact-half capped hybrid eligibility](https://github.com/ang-kl/bot-trade/blob/558850b5719a5c3c0216e5db225363b6e0ff0c4a/agent/services/capped-hybrid-policy.js); [native-event/Node controller](https://github.com/ang-kl/bot-trade/blob/558850b5719a5c3c0216e5db225363b6e0ff0c4a/agent/services/hybrid-tick-controller.js#L161); [performance targets](https://github.com/ang-kl/bot-trade/blob/558850b5719a5c3c0216e5db225363b6e0ff0c4a/agent/services/performance-targets.js#L10).
- Runtime receipts retained in `/workspace/bot-trade-hk-universe-evidence-2026-10-09/`, `/workspace/bot-trade-reporting-query-evidence-2026-10-09/` and `public-runtime-singleacct1224.json` in `/workspace/bot-trade-hybrid-clock-evidence-2026-10-09/`. Local paths are provenance references, not a guarantee of future workspace persistence.

**Ready-to-copy next task:**

> Assumptions: Read this dated plan and fresh main. Owner intends new demo entries only on 43097342/SGD and a possible 42993489/SGD live start on 19 October. Preserve all other account settings and 75% WR / PF 1.68. No current setting is assumed from a source default.
>
> Task: Obtain one authorised, dated settings comparison for the two accounts, then present the smallest exact account-scoped configuration diff for owner approval. Identify minimum-size/fee limitations before waiting for a hybrid event. No code change is authorised by this prompt.
>
> Output: Current value, desired value, key/route, scope, units, side effects and readback criterion for each difference. Separate executable checks, natural-event/time dependencies, access gaps and deferrals; retain acceptance counts unless an entire group passes.
>
> Material: Pinned sources linked above, fresh effective account/risk/phase/entry/strategy/watchlist records and account-owned broker metadata. Reuse existing genuine receipts; do not reconstruct missing broker facts.
>
> Invariants: No credentials, forced broker events, financial-history edits, stop/entry code changes, guessed IDs/FX, region/volume/staging change or monitoring schedule. Never enlarge a position merely to make the 50% partial representable. Preserve existing positions' protection and owner pins.
>
> Context and Close: Make the single demo a credible rehearsal of the planned small SGD live account. Stop when the configuration comparison and reviewable diff are delivered, or name the exact unavailable field. Settings application and any code change require the owner's subsequent explicit instruction.

## 9. Owner screenshot addendum

**Codex · №12,502 · 9 October 2026, 12:47 SGT** — source interpretation checked against unchanged main `558850b`. The owner supplied the picture after the original plan. Its capture time is not visible; this is an owner-provided UI observation, not a simultaneous broker read. The original dated runtime receipts remain intact.

| Account | Displayed settings and holdings | Meaning for the plan |
|---|---|---|
| LIVE 1251247 / 42993489 | Balance $51.41; active; S on / A on / T on; 1 position; WL 258; linked, rec 2m | New-entry configuration is displayed on. This conflicts with reserving live entries until the 19 October decision. It does not prove a new live trade occurred. |
| LIVE 1251442 / 43002148 | Balance $0; archived; S/A/T off; 0 positions; WL 60; unlinked, rec 6m; DISCONNECTED | Preserve the owner's archived/disconnected setup. The screenshot is not authority to reconnect it. |
| LIVE 1252961 / 43069009 | Balance $0; manage_only; S/A/T off; 0 positions; WL 60; linked, rec 2m | Displayed as management-only, with new-entry permission off. Preserve. |
| DEMO 5067353 / 43097342 | Balance $3,097.40; selected and active; S/A/T on; 0 positions; floating +$0.00; displayed equity $3,097; WL 258; linked, rec 2m | This is the intended demo account. If its owner-reported SGD currency remains correct, its displayed balance is above the proposed sub-SGD2,000 live capital; capital/margin parity is not yet achieved. |
| DEMO 5203012 / 46130058 | Balance $30,009.96; active; S/A off / T on; 2 positions; WL 258; linked, rec 2m | Ordinary timeframe dispatch is blocked by S/A off. The account is still armed at the T/mode layer; existing positions require management. Preserve the owner-set switches pending a deliberate decision. |
| DEMO 5268549 / 46979908 | Balance $697.67; active; S/A off / T on; 1 position; WL 260; linked, rec 2m | Same distinction: ordinary timeframe dispatch blocked, T remains on. Preserve existing position protection. |
| DEMO 5306502 / 47790949 | Balance $42,945.59; active; S/A off / T on; 3 positions; WL 259; linked, rec 2m | Same distinction: ordinary timeframe dispatch blocked, T remains on. Preserve existing position protection. |

**How to read the controls:** blue means the effective phase is on; red means off. A dot beside S/A/T marks a per-account override rather than inheritance. It is not a trade event or heartbeat. T means Autotrade; it does not mean tick trading. The highlight marks the selected account, not proof that every other account is unable to trade. The Disconnect button is an offered action, not a claim the row is disconnected; the archived row instead shows Reconnect and DISCONNECTED.

`rec 2m` is the rounded age of the last reconciliation, not the configured scan interval or a guaranteed management deadline. The dollar prefix is generic in this component: balance comes from the broker trader response, but the picture itself does not label deposit currency or leverage. Keep the owner's SGD declaration for the target-account plan separate from currency verification. The shown W/L counts also do not replace certified forward whole-position WR/PF.

**Recommended configuration decision:** to enforce no new live entries before 19 October, turn **T off on 42993489** through the existing per-account control. Current `setAccountArmed(false)` changes an active account to `manage_only` and keeps it connected for management of the displayed open position. Do not use Disconnect, close its position or change its stop merely to achieve demo-only entries. This recommendation has **not** been applied.

For the three other active demo accounts, S/A off is a real ordinary-dispatch veto; it is not correct to call those switches meaningless. It is also not a universal all-engine disarm: the momentum-book controller's phase callback explicitly reads T. Its full entry path still has additional gates, and the screenshot does not prove that book or tick entry is active or that a new order passed. If the owner later wants an explicit account-wide no-new-entry policy for them, review T off / `manage_only` separately. Their current configuration is preserved as requested.

The picture narrows the remaining check: current effective risk keys, deposit currency/FX, leverage/product margin, per-account entry modes, strategy pins and hybrid size eligibility are still not shown. No need to repeat the already supplied seven-account visual inventory. Current protection must be read independently; position counts alone do not establish SL/TP acceptance. No whole acceptance group is closed by this image.

Source: [rendered switches, balances and reconciliation age](https://github.com/ang-kl/bot-trade/blob/558850b5719a5c3c0216e5db225363b6e0ff0c4a/src/components/AccountSwitcher.jsx); [per-account arm/mode transaction](https://github.com/ang-kl/bot-trade/blob/558850b5719a5c3c0216e5db225363b6e0ff0c4a/agent/services/account-arming.js#L68); [ordinary dispatch phase gate and separate book wiring](https://github.com/ang-kl/bot-trade/blob/558850b5719a5c3c0216e5db225363b6e0ff0c4a/agent/loop.js#L1929).
