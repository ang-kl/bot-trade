# bot-trade: stop-loss, profit mechanisms and the five important interactions

**Prepared:** 15 October 2026 (SGT). **Code baseline:** [`87db6d356997c7fc510c1fe3474d11916ce3054f`](https://github.com/ang-kl/bot-trade/commit/87db6d356997c7fc510c1fe3474d11916ce3054f). **Conversation reference:** the inventory in Codex №14,532 and the owner's request for a downloadable report explaining the five interactions and reasons for changes.

## What the evidence establishes

The bot has several stop and profit controllers. They operate under account, position and strategy ownership rules; listing them together does not mean every controller acts on every trade. The figures below are code defaults and strategy proposals, not freshly captured production settings.

Four of the five interactions are primarily policy or semantic distinctions. The strongest additional finding is a **reproduced early-trim observation gap**: its shadow calculation is inside a profit-keeper path that excludes positions governed by managed exits. Enabling the shadow feature therefore does not provide coverage for all registered managed positions.

This report distinguishes:

- **Implemented behavior:** established by the pinned source and, where stated, isolated execution.
- **Recorded reason for a change:** what the source history or PR says motivated it. Historical economic observations were not recaptured or independently reanalysed here.
- **Conditional obstruction:** a setting, ownership rule or missing input that can prevent an action. This does not establish its occurrence on a current account.
- **Operational status:** **Not Verifiable** without a fresh, account-owned production receipt.

No application code or production setting was changed. No broker order, amendment, forced fault or production restart was performed.

## 1. Programmed stop-loss mechanisms

**R** below is price movement divided by the position's recorded initial stop distance. It is a price-risk measure, not net cash profit after costs.

| Mechanism | Programmed behavior and important scope |
|---|---|
| Initial broker SL | Strategies propose stops from structure, swing extremes and ATR. Entry gates check side and minimum distance. An hourly-ATR floor can widen a proposed stop **before** sizing; the approved bracket is sent with the order. |
| Managed peak trail | Default distance **0.5R behind peak favourable excursion**. Activates only when the peak exceeds 0.5R; proposals must tighten the current stop. Governed by `managed_exit_json` and the account registry. |
| Broker stop policy | Default **OPPOSITE** quote trigger. Requests broker-side trailing when the stop reaches or passes the entry-price boundary; book rows are exempt from that request. This is desired behavior until broker acceptance/readback proves it. |
| Native Chandelier trail | C++ advances peaks from ticks and submits ratchet amendments through a worker. Node supplies the distance. A separate since-entry specification uses **3 × ATR(22)** and requires valid bars and broker precision. |
| Profit-keeper trail | Adaptive default **2.5 × ATR(14)** behind the peak, with swing-structure trailing and spike tightening to **1 × ATR**. The usual decision path excludes managed-exit positions and book-owned positions. |
| Owner-set position guards | Pip-triggered breakeven, an optional entry offset, and fixed-pip trailing in the position's `guard_json`. These are separate from the legacy R ladder. |
| Session-open guard | Default first **30 minutes** after a major session opens, minimum **+0.3R**, then a tighten-only move to entry for eligible positions. |
| Missing-stop protection | Loss Guardian can install a stop on a naked position: default **3 × ATR(14)**, with a **2% entry-price fallback** when ATR is unavailable. Can close when the boundary it would protect is already breached. The protection auditor checks broker-held SL/TP and repair eligibility. |
| Momentum-book stop | Default initial and trailing distance **3 × daily ATR(20)**. The book has its own horizon, stop-management and ownership rules. |

Source: [entry payload and risk overrides](https://github.com/ang-kl/bot-trade/blob/87db6d356997c7fc510c1fe3474d11916ce3054f/agent/loop.js), [risk gate / ATR floor](https://github.com/ang-kl/bot-trade/blob/87db6d356997c7fc510c1fe3474d11916ce3054f/agent/services/risk.js), [managed exits](https://github.com/ang-kl/bot-trade/blob/87db6d356997c7fc510c1fe3474d11916ce3054f/agent/services/managed-exit.js), [stop policy](https://github.com/ang-kl/bot-trade/blob/87db6d356997c7fc510c1fe3474d11916ce3054f/agent/lib/stop-policy.js), [native trail](https://github.com/ang-kl/bot-trade/blob/87db6d356997c7fc510c1fe3474d11916ce3054f/cpp-exec/src/trail_engine.hpp), [loss guardian](https://github.com/ang-kl/bot-trade/blob/87db6d356997c7fc510c1fe3474d11916ce3054f/agent/services/loss-guardian.js).

## 2. Programmed profit-taking and other exits

| Mechanism | Programmed behavior |
|---|---|
| Structural targets | Volume-profile POC/value-area edges, volume nodes, Fibonacci structures and breakout measured moves, depending on the strategy or target suggester. |
| Fixed-R targets | Some strategies propose **TP1 at 2R and TP2 at 3R**. Entry gates can adjust or refuse the proposal. A plan with two levels is not proof of two broker orders. |
| Capped hybrid | Default **50% close at +2R**, anchored to the broker-proven fill and initial risk. Existing broker SL/TP are retained. Native tick detection supplies events; the durable Node execution path still arbitrates and proves the close. |
| Managed mean-reversion take | Default **50% at +1R**, with remainder protection. Scoped to the configured mean-reversion families; weeks-horizon positions have a take exemption. |
| Legacy R ladder | Generic defaults: breakeven **0.7R**, half close **1R**, runner starts **2.5R**, full banking **4R**. Asset-class overrides vary these. The managed ruleset suppresses this ladder where it applies. |
| Owner-set TP ladder | Position guards can close specified lots at price levels. The broker holds one native TP; additional levels require bot-managed execution. |
| Keeper giveback / fixed-profit close | Fixed mode defaults to arming at **$50** and allowing **40% peak-profit giveback**. Optional absolute-profit close and scale-out are configurable. Cross-currency and ownership requirements affect reach. |
| Invalidation and time cap | Deterministic price-based invalidation can close a position. At a time cap, a losing or unreadable position can close; an eligible winner can be protected and held, with an extension backstop. |
| Momentum rank exit | Holdings leaving the rank band can exit under cadence and minimum-hold conditions. This is separate from the protective stop. |
| Weekend banking | Banks eligible profits before long closures. Gap-prone instruments can be flattened regardless of profit sign; book exemptions apply. |

Capital-level controls also include **per-position floating-loss caps**, **daily loss entry vetoes**, **account daily-drawdown stops**, **campaign drawdown entry vetoes**, **portfolio entry limits**, and an **equity high-water profit ratchet**. Their actions differ: some refuse new entries; some halt an account or close exposure. A campaign or portfolio veto should not be described as an automatic position close without checking its actual caller.

Source: [position manager](https://github.com/ang-kl/bot-trade/blob/87db6d356997c7fc510c1fe3474d11916ce3054f/agent/services/position-manager.js), [capped hybrid](https://github.com/ang-kl/bot-trade/blob/87db6d356997c7fc510c1fe3474d11916ce3054f/agent/services/capped-hybrid-policy.js), [trade guards](https://github.com/ang-kl/bot-trade/blob/87db6d356997c7fc510c1fe3474d11916ce3054f/agent/services/trade-guard.js), [profit keeper](https://github.com/ang-kl/bot-trade/blob/87db6d356997c7fc510c1fe3474d11916ce3054f/agent/services/profit-keeper.js), [momentum book](https://github.com/ang-kl/bot-trade/blob/87db6d356997c7fc510c1fe3474d11916ce3054f/agent/services/momentum-book.js), [weekend bank](https://github.com/ang-kl/bot-trade/blob/87db6d356997c7fc510c1fe3474d11916ce3054f/agent/services/weekend-bank.js), [loss cap](https://github.com/ang-kl/bot-trade/blob/87db6d356997c7fc510c1fe3474d11916ce3054f/agent/services/loss-cap.js), [profit ratchet](https://github.com/ang-kl/bot-trade/blob/87db6d356997c7fc510c1fe3474d11916ce3054f/agent/services/profit-ratchet.js).

## 3. The five important interactions: what works, what can prevent it, and why it changed

### Interaction 1 — managed exits suppress the legacy ladder

**Intended behavior.** `applyManagedRules()` sets the legacy breakeven, ordinary partial and runner triggers to `Infinity`. It supplies the peak trail instead. The managed bank take is separately scoped by strategy family; it is not the generic 4R banking rule. Both slow and fast monitors use the shared helper.

**Why it was changed.** [PR784](https://github.com/ang-kl/bot-trade/pull/784) adopted the simpler peak-trail policy. [PR790](https://github.com/ang-kl/bot-trade/pull/790) corrected inconsistent callers: the fast monitor had still used the old ladder while the slow monitor used managed rules. The recorded incident was an early `bank_target_4R` exit that beat the managed trail. [PR852](https://github.com/ang-kl/bot-trade/pull/852) scoped the +1R take to mean reversion so it would not truncate trend/breakout tails. [PR905](https://github.com/ang-kl/bot-trade/pull/905) changed that take to a partial and stopped routinely closing winners at a time cap. These are recorded policy decisions and historical evidence, not fresh proof of a profitable exit regime.

**Why it may appear not to work.**

- No legacy +0.7R breakeven or +1R ordinary partial is expected while managed rules govern the position. A different managed mean-reversion partial or capped hybrid can still exist.
- `managed_exit_json.on = false`, an absent account identity, an unregistered account, or an account-registry read failure means the managed override does not apply. The legacy rules can then remain effective.
- Paused rows can be outside the normal fast/slow monitor population; book-owned rows have their own manager. Strategy family and stored horizon influence take/time-cap eligibility.
- The managed trail uses **strictly greater than** its distance: peak exactly +0.5R does not activate the default trail. It also needs entry, recorded risk and a usable price. An already tighter stop does not need another amendment.
- Owner guards, the capped hybrid, signal invalidation/time caps, and account safety exits are not all erased by suppressing the legacy ladder.

**Verified here.** A registered trend position received `beTriggerR`, `partialTriggerR` and `runnerTriggerR = Infinity`, `bankTriggerR = 0`, and `alwaysTrailR = 0.5`. With entry 100 and recorded risk 10, price 105 returned HOLD; 105.1 returned MOVE_SL to 100.1. These illustrative fixtures verify the rule boundary, not current broker execution.

Source: [shared override](https://github.com/ang-kl/bot-trade/blob/87db6d356997c7fc510c1fe3474d11916ce3054f/agent/services/managed-exit.js#L63), [trail activation](https://github.com/ang-kl/bot-trade/blob/87db6d356997c7fc510c1fe3474d11916ce3054f/agent/services/position-manager.js#L498).

### Interaction 2 — MAE/MFE measurements do not automatically optimise Chandelier settings

**Intended behavior.** `mfe_r` and `mae_r` track excursions on the management price basis; `mfe_r` contributes to the managed peak trail. Separate `mfe_exit_r`, `mae_exit_r` and `exit_excursion_from` record exit-side observations: bid for a long, ask for a short. Those new fields are not inputs to the current trailing decision. I found no active general MAE-to-ATR-multiplier optimiser in this baseline.

**Why it was changed.** [PR1207](https://github.com/ang-kl/bot-trade/pull/1207) removed the standalone MAE/Chandelier observer at the owner's direction. Its recorded production read had one position but zero usable bar coverage, adjustable rows or receipts; its fetches added broker calls and it created a third stop authority. The file name survives because it still provides ATR and since-entry trail helpers. [PR1356](https://github.com/ang-kl/bot-trade/pull/1356) added the exit-side columns separately: changing the existing MFE column would have changed the managed stop input and mixed old and new price bases on already-open positions.

**Why it may appear not to work.**

- Expecting MAE automatically to tune the ATR multiplier asks for a mechanism absent from the current implementation.
- Expecting every initial SL to be Chandelier-derived also differs from the code: initial stops come from their strategy/risk path; the since-entry helper produces a trailing specification.
- A since-entry specification is withheld without enough valid ATR bars, a valid entry or broker digits. The keeper's mode and bar-fetch path matter. Native trailing also depends on a valid pushed specification, feed and broker amendments.
- The standard keeper and since-entry trail use different parameters: keeper adaptive default 2.5×ATR(14), since-entry specification 3×ATR(22). These are separate policies.
- An exit-side value on a position opened before the new columns tracks **from `exit_excursion_from`**, not necessarily from entry. Missing observations must not be treated as full-lifetime MAE/MFE.

**Verified here.** Valid controlled bars and digits produced a since-entry distance of 6 price units (3×ATR of 2). Missing bars or null digits produced no specification. This establishes prerequisite handling, not that production currently has those inputs.

Source: [retained helper and removal rationale](https://github.com/ang-kl/bot-trade/blob/87db6d356997c7fc510c1fe3474d11916ce3054f/agent/services/mae-chandelier-observe.js), [exit-side measurement contract](https://github.com/ang-kl/bot-trade/blob/87db6d356997c7fc510c1fe3474d11916ce3054f/agent/services/exit-excursion.js).

### Interaction 3 — early trim is observation-only, and its observation coverage has a gap

**Intended behavior.** Default `enabled = false`; the only implemented mode is `log`. Even a stored `mode: "act"` is normalised to `log`. A qualifying decision creates `SHADOW /early-trim` with `applied: false`. There is no early-trim close or stop-amend path.

**Why it was written this way.** [PR685](https://github.com/ang-kl/bot-trade/pull/685) records the owner instruction **“ship T2 log-only now.”** The concern was that early profit trimming might further truncate winners. The intent was to compare shadow observations with an offline, cost-aware evaluation before granting execution authority. That historical plan is not evidence that the comparison was subsequently completed.

**Why it may appear not to work.**

- No actual lot reduction or breakeven amendment from early trim is expected, even when its shadow toggle is on.
- **Reproduced coverage gap:** its calculation is inside the keeper decision loop. The keeper excludes managed-exit rows from that loop; registered accounts are governed by managed exits by default. Enabling `early_trim_json` therefore does not make it observe all managed positions.
- Keeper off, scope restrictions, `keeper_opt_out`, owner guard rules, book ownership, missing prices/metadata or insufficient remainder size can also prevent evaluation or a qualifying observation.
- The caller writes a shadow row only when `trimDecision.trim` is true. Below-threshold and other negative decisions do not create equivalent rows. No row is therefore ambiguous: disabled, excluded, unreadable and below-threshold cases can look alike.
- The input named `originalSl` comes from `trades.sl_price`. That column has mutable writers elsewhere, including the momentum book, although book-owned rows are excluded from this shadow path. The name alone does not prove immutable opening provenance; the applicable writer/ownership path must be checked for a given row. No reachable shadow mismeasurement or live incident from this input is claimed here.

**Verified here, through the actual keeper and real in-memory SQLite:**

| Controlled case | Keeper checked | Managed skipped | Shadow rows | Broker writes |
|---|---:|---:|---:|---:|
| Managed on; shadow enabled; above trim threshold | 0 | 1 | 0 | 0 |
| Managed off; same above-threshold position | 1 | 0 | 1 | 0 |
| Managed off; below-threshold position | 1 | 0 | 0 | 0 |

This proves the wiring and observation limit. It does not prove a missing production row on any named account. **Recommendation:** decide and document the shadow's intended population; if it should cover managed positions, observation should be separated from keeper execution authority. Do not turn this shadow into a trading feature merely by changing a mode field.

Source: [mode normalisation](https://github.com/ang-kl/bot-trade/blob/87db6d356997c7fc510c1fe3474d11916ce3054f/agent/services/early-trim.js#L70), [keeper population filter](https://github.com/ang-kl/bot-trade/blob/87db6d356997c7fc510c1fe3474d11916ce3054f/agent/services/profit-keeper.js#L527), [decision subset](https://github.com/ang-kl/bot-trade/blob/87db6d356997c7fc510c1fe3474d11916ce3054f/agent/services/profit-keeper.js#L589), [positive-only shadow write](https://github.com/ang-kl/bot-trade/blob/87db6d356997c7fc510c1fe3474d11916ce3054f/agent/services/profit-keeper.js#L727).

### Interaction 4 — the LLM monitor can recommend EXIT but cannot close the position

**Intended behavior.** The deterministic evaluator runs first. The LLM fallback can assess ambiguous or textual theses, but its EXIT is recorded as advice. `llm_monitor` is absent from `CLOSE_AUTHORITY`, and the advisory branch does not call the broker executor.

**Why it was changed.** [PR628](https://github.com/ang-kl/bot-trade/pull/628) records the owner's concern about penny-profit exits. Its historical sample contained 31 explicit closes, 26 within 0.1R of entry; it also reported 12 LLM exits with only two positive outcomes and no stop moves. The decision removed discretionary close authority and added a floor against purposeless near-entry churn. These are historical repository-reported measurements, not fresh causal proof that every future LLM exit would be harmful.

**Why it may appear not to work.**

- An LLM recommendation of EXIT, or a thesis marked broken, is not a confirmed position close. The stored check action can still contain the recommendation while the trade remains active.
- Alerts are selective: the current branch notifies for an LLM exit recommendation when current R is below −0.5. An advisory at another R may be journalled without that notification.
- External positions, strategy management switches, an already-fired deterministic rule, the cycle deadline or provider unavailability can prevent the LLM read itself.
- Protective/deterministic exits still have their own authority. Removing the LLM's close authority does not remove broker SL/TP, loss caps, account stops or owner closes.
- A blocked discretionary close can also be the null-exit floor around entry. Protective and owner writers have explicit exemptions; unknown R is not silently converted to zero.

**Verified here.** `mayClose('llm_monitor')` returned false; an attempted verdict at −1R returned `no_close_authority:llm_monitor`. This is intended policy behavior. A new automatic LLM-close feature would require a deliberate owner policy decision and an independently qualified execution path.

Source: [advisory branch](https://github.com/ang-kl/bot-trade/blob/87db6d356997c7fc510c1fe3474d11916ce3054f/agent/loop.js#L2977), [close authority and null-exit policy](https://github.com/ang-kl/bot-trade/blob/87db6d356997c7fc510c1fe3474d11916ce3054f/agent/services/null-exit-guard.js).

### Interaction 5 — price breakeven is not net cash breakeven

**Intended behavior.** The ordinary breakeven rule and session-open guard move SL to the entry price. An owner guard can add a configured pip offset. These mechanisms do not automatically calculate a universal account-, quantity- and commission-aware cash-breakeven price.

**Clarification of the inventory wording.** `locksProfit()` accepts a long stop **at or above** entry, and a short stop **at or below** entry. Equality is included. Broker trailing can therefore be requested at price breakeven; the function name must not be read as proof of positive net money.

**Why it was written this way.** [PR1183](https://github.com/ang-kl/bot-trade/pull/1183) introduced a shared stop policy, OPPOSITE triggering and broker-side trailing at the entry-price lock boundary. The recorded purpose was consistent protection across amendment sites, including protection between bot passes/outages and reduced sensitivity to one-sided spread events. It was not a universal cost-accounting implementation. Subsequent account-commission work collects and compares broker terms; the current commission module explicitly states that the risk gate does not read those terms yet. An admission rule called “breakeven” is also a different mechanism from moving a held position's SL.

**Why it may appear not to work.**

- If an idealised fill occurs exactly at entry, gross price P&L is zero; commission, swap and other charges can make net P&L negative. Actual stop execution can also differ from the stop price.
- A manual offset is a price setting, not proof that it covers this account's charges or this order size.
- Missing or invalid entry/side/stop context prevents the lock flag. Book ownership suppresses the bot's broker-trailing request; it does not necessarily clear a trailing flag previously set by an owner.
- A requested flag or SL is not confirmed broker protection. Refusal, cooldown, an already tighter stop or incomplete readback must be distinguished from a successful movement.

**Verified here.** A BUY with entry 100 and stop 100 satisfied `locksProfit()` and requested `trailingStopLoss: true` under the default policy. A separate arithmetic illustration with gross P&L 0 and fees 7 gives net −7; the fee figure is illustrative, not a broker receipt.

**Recommendation:** reserve “price breakeven” for the entry-price rule. A claim of cash breakeven needs actual account costs, filled/residual quantity, currency, and execution evidence. A future cost-aware stop rule is a policy change to prepare for review, not a setting silently enabled by this report.

Source: [inclusive lock predicate](https://github.com/ang-kl/bot-trade/blob/87db6d356997c7fc510c1fe3474d11916ce3054f/agent/lib/stop-policy.js#L108), [owner guard offset](https://github.com/ang-kl/bot-trade/blob/87db6d356997c7fc510c1fe3474d11916ce3054f/agent/services/trade-guard.js#L49), [commission module and its current scope](https://github.com/ang-kl/bot-trade/blob/87db6d356997c7fc510c1fe3474d11916ce3054f/agent/services/commission-terms.js).

## 4. How to classify a specific position's apparent failure

For a read-only check, join the **same account and position** across these facts:

1. Effective `managed_exit_json`, `profit_keeper_json`, `early_trim_json`, `stop_policy_json`, applicable class overrides and hybrid settings.
2. Active/paused status, source, strategy family, stored horizon, book ownership, owner guards, opt-out and any retained close attempt.
3. Entry/fill, initial-risk provenance, current quantity and broker symbol precision.
4. Quote/bar timestamps and whether the required input was usable at decision time.
5. The computed action and its named skip/refusal/hold reason.
6. The sent command, actual fill or SL movement receipt, and fresh broker-held SL/TP/flags.

Classify the outcome as **policy-disabled**, **out of scope**, **below trigger**, **missing evidence**, **already protected**, **broker refused**, **pending reconciliation**, or **confirmed execution**. An action label, HTTP success, absent log or displayed MFE is insufficient by itself.

This report has not obtained that joined production receipt for the three demo accounts or the live account. Their current operational states remain **Not Verifiable here**.

## 5. Recommended improvements — proposals only

- Expose each position's active controller and named skip/refusal reason, including the controller that owns a partial close.
- Give shadow observation an explicit population independent of execution permission, and record bounded negative/unevaluable outcomes so missing logs are explainable.
- Keep management excursions, exit-side excursions and coverage start times distinct; do not silently feed a new measurement basis into existing stops.
- Present LLM EXIT as a recommendation and show confirmed broker closure separately.
- Distinguish price locks from after-cost cash locks, using actual account-specific quantities, fees and currency evidence for the latter.

These proposals do not enable trading, restore the removed observer, grant LLM close authority or change the owner's risk/SL/TP policies. Engineering correctness and financial PF/win-rate improvement require separate acceptance evidence.

## 6. Verification receipt and limits

**Source baseline:** `87db6d356997c7fc510c1fe3474d11916ce3054f`, rechecked against main during this task.

**Independent execution:** Node **22.23.3**, unchanged source helpers and the actual keeper with real in-memory SQLite and controlled broker boundaries. Seven grouped checks completed, including the three shadow-coverage cases above. All controlled keeper cases made **zero broker writes** and returned no errors.

**Existing tests:** `managed-exit.test.js`, `early-trim.test.js` and `null-exit-guard.test.js`: **47 passed, 0 failed, 0 skipped**, approximately 2.75 seconds. This is focused verification, not a full-system stress or profitability qualification.

The observations and counts are embedded in this document. Full probe/source receipts and logs are retained in the audit workspace. Installed agent dependency lock hashes matched the audited snapshot. No application build or full suite was run for this analysis; publication CI is separate. Production settings, broker acceptance and account outcomes were not recaptured.
