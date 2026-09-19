# Agent-Graph Engineering Audit — Wave 1 (five workstreams)

Against `instr/Bot-Trade_Agent-Graph_Engineering_Audit_Prompt.md`.

| | |
|---|---|
| **Frozen source SHA** | `ed9a60f537785b776bb93f0f5d49b3b361733320` |
| **Deployed SHA** | `ed9a60f` — **matches** (§14 satisfied) |
| **Run at** | 2026-08-03 12:51 UTC |
| **Runtime evidence** | production `sg-trade.up.railway.app`, read-only credential |
| **Workstreams completed** | WS-01, WS-02, WS-08, WS-11, WS-12 |
| **Workstreams blocked** | WS-03, WS-04, WS-05, WS-06, WS-07, WS-09, WS-10 |
| **Production trading actions taken** | none (§3.6) |

## Audit-integrity statement — read this first

§3.2 requires that the reviewer not be the author, and §15 requires UAT by someone
who did not implement the change. **Neither was satisfied.** One agent produced
every package here, and that agent also wrote seven of the PRs merged into this
SHA today. Independent review and external UAT are **not claimed**; the mechanical
gate (§11) was run and is reported honestly, and every finding below carries its
own evidence so a second reader can check it rather than trust it.

Treat this as **discovery**, not as an accepted audit.

---

# 1. Executive verdict

**Has the system become too reluctant to trade? Not primarily — and the framing
of the question is where the risk of a wrong remedy lies.**

The approval rate is **1.9% (928 approved / 48,586 vetoed** over seven days), which
looks exactly like over-defence. It mostly is not. Of the four dominant blockers,
**three were defects that presented as caution**, and all three were repaired today:

| Blocker family | Vetoes (7d) | % of all | Classification |
|---|---:|---:|---|
| `unknown_daily_pnl` | 32,896 | **63.7%** | **Defect** — a veto with no release. Fixed (#597) |
| `daily_loss_limit_hit` | 9,335 | 18.1% | **Working as designed** — real losses against a real cap |
| `insufficient_equity:usd_per_lot_unknown` | 1,859 | 3.6% | **Defect** — could not size, so could not enter. Fixed (#593/#594) |
| `stage_matrix:strategy_off` | 1,611 | 3.1% | **Owner policy** — strategies deliberately disarmed |

Four families account for **88.5%** of all vetoes; the top 18 account for 99.3%.
The long tail of 489 distinct guard strings is 48 families once variants are
collapsed, and it is not where the volume is.

**The single most consequential finding is not a veto at all — it is that the
go-live goal is arithmetically unreachable.** See F-GOAL-01.

**Three controls with the greatest marginal effect:** `unknown_daily_pnl`
(now released), the per-account daily-loss cap, and — newly dominant since the
first two were fixed — **margin exhaustion**, which no longer leaves room to
deploy the risk budget the owner authorised (F-RISK-01).

**Safeguards that remain essential and should not be touched:** the daily-loss
cap itself, the duplicate-symbol guard, the margin-level floor, and the
`enabled = 0` flag on the live account (F-POLICY-01 — note the same-day
correction recorded against that finding).

---

# 2. Findings

### F-GOAL-01 — The go-live goal cannot be met, and the two targets contradict each other

| Field | Value |
|---|---|
| Classification | **Policy conflict** |
| Severity | **High** (drives every arming decision and the 12-Aug deadline) |
| Confidence | **High** — arithmetic on live figures |

**Evidence** (`/state/goal-tracker`, live):

```
goal: { winRatePct: 68, profitFactor: 1.68, gateOn: "profitFactor",
        deadline: "2026-08-12", minTrades: 30 }
portfolio: 330 trades · 116 wins · win rate 35.15% · net −3,789.47
           spanDays 25 · tradesPerDay 13.2 · expectedRemaining 132
           winRate.winsNeeded 199   ← from 132 remaining trades
```

Per account, all five below target, `requiredRateOnRemaining` in the last column:

| Account | Trades | PF | Verdict | Required win rate on remaining |
|---|---:|---:|---|---:|
| 47790949 | 135 | 1.01 | at_risk | 88.89% |
| 46130058 | 130 | 0.72 | out_of_reach | 105.77% |
| 43097342 | 62 | 0.33 | out_of_reach | 148% |
| 46979908 | 13 | 0.41 | insufficient_sample | 160% |
| 42993489 | 6 | 0.53 | insufficient_sample | 100% |

**Two separate problems.**

1. **Unreachable.** Hitting 68% win rate needs **199 more wins from ~132 expected
   remaining trades**. Three accounts need a win rate *above 100%* on what remains.
   The system already computes and displays this (`out_of_reach`) — nothing is
   hidden — but the deadline stands regardless.

2. **The two targets are not the same target.** At the measured payoff ratio
   (1.26–1.45), profit factor 1.68 implies a win rate of **~53.6%**, which the
   tracker itself reports as `impliedWinRatePct`. A **68%** win rate at that payoff
   would yield PF ≈ **3.1**, nearly twice the stated PF goal. So "68% and 1.68"
   are not one goal with two readouts; the win-rate target is far stricter. With
   `gateOn: "profitFactor"` the stricter number is the one *not* enforced — which
   is defensible, but means the 68% figure is decorative and should be said so.

**Minimum remedy:** none in code. §18.1's rule — *do not optimise win rate
independently from payoff* — is the point: pick **one** gating metric and set the
other as derived. **Owner policy decision required.**

**Regression test:** a goal-tracker test asserting `impliedWinRatePct` is
consistent with `target` and `payoffRatio`, so the two can never silently diverge.

---

### F-RISK-01 — The risk budget cannot be deployed: margin is the binding constraint, over its own cap

| Field | Value |
|---|---|
| Classification | **Under-defence / correctness** |
| Severity | **High** (capital) |
| Confidence | **High** |

**Evidence** (`/state/risk-full?account=46130058`, live):

```
balance 46,039.37   used margin 24,481.86   free 22,712.97   margin level 192.77%
maxMarginUsagePct 0.40   →  authorised margin 18,415.75
actual usage 24,481.86 / 46,039.37 = 53.2%   ← 33% OVER its own 40% cap
open positions 16
```

The bot's own margin cap is **40% of balance**. Actual usage is **53.2%**. The
margin-level floor (200%) is also breached at 192.77%, which is why
`margin_level_floor` appears 314 times in the veto log.

This is the opposite of over-defence: a cap that is **stated and exceeded**. The
account cannot deploy its daily risk budget (2,248 left, `tradesLeft: 1`) because
margin, not the risk gate, is now the limit.

**Note the sequencing.** This became the binding constraint *today*, after the
three defect fixes released entries: 46130058 went from 3 open positions to 16,
and today's realised loss went from −2,538.99 to −4,886.08, within a paced cap of
7,134. **The fixes worked; the next constraint is margin.**

**Minimum remedy:** determine whether `maxMarginUsagePct` is enforced at dispatch
or only reported. If reported-only, that is a second F-OBS. **Not yet traced —
this is WS-03 territory and is blocked.**

---

### F-OBS-01 — `/state/risk-full?account=X` returns the SAME margin block for every account

| Field | Value |
|---|---|
| Classification | **Evidence gap** |
| Severity | **Medium** |
| Confidence | **High** — two requests, identical numbers |

Requesting the risk view for two different accounts returns byte-identical margin:

```
account=46130058  → used 24,481.86  free 22,712.97  level 192.77%
account=47790949  → used 24,481.86  free 22,712.97  level 192.77%
```

The margin block reads `broker_snapshot_cache_json`, a **single global blob**,
while balance and leverage beside it are correctly per-account. This is §7 WS-12's
third listed failure verbatim — *"all accounts while only one account was
checked"* — and it means every margin figure on the Risk page is attributed to
whichever account you are viewing regardless of whose it is.

**Minimum remedy:** scope the snapshot read, or label the block `portfolio-wide`
and stop rendering it under an account heading. The `ScopeDot` machinery added
this week is exactly the right vehicle for the second option.

---

### F-OBS-02 — 13.3% of gate approvals never become orders, and the system says so in one place only

| Field | Value |
|---|---|
| Classification | **Evidence gap / correctness** |
| Severity | **High** |
| Confidence | **High** |

`/health` self-reports:

```
verdict: "silent_drop"
because: "278 approved at the gate but only 241 order(s)/trade(s) exist
          — 37 approval(s) went nowhere"
considered 4,685 → reachedGate 3,400 → approved 278 → landed 241
```

**37 of 278 approvals (13.3%) vanished between approval and execution.** The
pipeline verdict names it, and nothing else does — it is not on any page, in any
alert, or in the veto breakdown. In a system whose approval rate is 1.9%, losing
13% of what survives is a large proportional loss and it is invisible.

This is the highest-value **unblocked** remediation target found by this audit.

**Minimum remedy:** record a terminal disposition for every approved proposal, so
"approved → no order" is a queryable state with a reason rather than a subtraction
between two counters. **Blocked for root cause** — needs WS-03 (execution
authority), which requires C++ evidence not gathered here.

---

### F-POLICY-01 — `mode` is displayed and not enforced; the live account's S.A.T. switches read ON

> **CORRECTED 2026-08-03, same day, by the author.** The finding as first
> written said *"`canEnter()` is never called on the dispatch path"*. **That is
> wrong.** `registryAutopilotAccounts()` has always filtered the entry roster on
> the `enter` capability via `capabilitiesFor()` — the source trace behind the
> claim grepped for `accountCapabilities|canEnter` and missed the direct
> `capabilitiesFor` call. Mode IS enforced on the registry route.
>
> Two real defects survive the correction, and they carried the live-account
> risk:
>
> 1. **The LEGACY roster bypassed the registry.** `getAutopilotAccounts()`
>    prefers `ctrader_account_roles_json` whenever more than one role carries
>    `autopilot`, and that branch filtered on `autopilot` alone — no mode, no
>    `enabled`. Fixed: the legacy list now intersects the registry's
>    enter-capable set.
> 2. **The readout was wrong even where the dispatcher was right** — the item
>    below, unchanged and confirmed.
>
> Kept visible rather than rewritten, per §12: *do not rewrite history to make
> the first attempt appear successful.*

| Field | Value |
|---|---|
| Classification | **Policy conflict / under-defence** |
| Severity | **Capital** |
| Confidence | **High** — source-traced |

`/state/account-phases`, live:

```
47790949  enabled=True   mode=manage_only  effective={scan:T, analyze:T, autotrade:T}
42993489  enabled=False  mode=manage_only  effective={scan:T, analyze:T, autotrade:T}  ← LIVE 1251247
```

`account-capabilities.js:59` maps `manage_only → enter: false`. But `canEnter()`
is called **only** from `pause-disposition.js` — never on the dispatch path
(source trace: `grep -rn "accountCapabilities|canEnter"`). So `mode` is decorative:
an account marked *manage_only* still enters.

For account **42993489 — the live Pepperstone account 1251247** — the effective
S.A.T. switches all read **true**, inherited from the master. The single thing
preventing live entries is `enabled = 0` in the registry. One flag, no second
barrier, and the UI beside it says autotrade is on.

**Minimum remedy:** either enforce `canEnter()` at dispatch, or stop rendering
`mode` as though it gates entry. The first is task #124/A2, already on the backlog.

**This is the finding I would fix first**, ahead of anything about trade frequency.

---

### F-VETO-01 — Veto accounting counts occurrences, not opportunities

| Field | Value |
|---|---|
| Classification | **Evidence gap** |
| Severity | **Medium** |
| Confidence | **High** |

51,636 veto rows across 489 distinct guard strings — but the strings embed live
values (`daily_loss_limit_hit pnl=-2538.99 limit=2419.32`), so one guard becomes
hundreds of "distinct" entries and the same rejected proposal is re-counted every
cycle it is retried. §18.2 asks for **gross, unique and overlapping** vetoes and
**trades restored if removed**. Only gross is available.

Collapsing variants into families (this audit's own normalisation) reduces 489
strings to **48 families**, of which four cover 88.5%.

**Minimum remedy:** emit a stable `guard_key` alongside the human string, and
stamp a proposal id so retries of one opportunity collapse to one. Without it,
no marginal-effect claim in this audit or any future one can be made honestly —
including the claim that a control is over-defensive.

---

### F-PR-01 — Defensive change accumulation is real but front-loaded, and slowing

| Field | Value |
|---|---|
| Classification | **Observation** (no defect) |
| Severity | Low |
| Confidence | High |

Commits touching risk/guard/exit machinery (`risk.js`, `global-guards.js`,
`profit-keeper.js`, `profit-ratchet.js`, `unresolved-pnl.js`, `loss-guardian.js`,
`loss-cap.js`):

```
2026-07   44 commits
2026-08    8 commits
```

Between 21 and 30 July the system gained, in order: an aggressive breaker + algo
risk cap, the Loss Guardian, a margin-headroom gate, per-strategy expectancy
gating, global capital protection (5A), a news-window gate, carry-cost gating, a
margin-level floor, a per-position dollar loss cap, the profit ratchet, spike
tightening, and the C++ trail engine — **twelve independent controls in ten days**,
each locally reasonable.

WS-02 asks for cumulative rather than local effect. The honest answer from this
wave: **the accumulation is visible, but the measured cost is dominated by the
defects inside two of those controls, not by the controls' design.** A claim that
the stack is collectively too tight cannot be made without WS-10 counterfactual
replay, which is blocked.

---

# 3. What is NOT established

Per §20, **over-defence may be labelled only** when a control uniquely blocks a
material set with plausible positive expectancy, out of sample. **This audit
establishes that for exactly zero controls.**

- No counterfactual replay was run (WS-10 blocked).
- No blocked opportunity was followed to its counterfactual outcome.
- Unique vs overlapping vetoes cannot be separated (F-VETO-01).

So: **NOT ESTABLISHED** for every over-defence hypothesis. The 1.9% approval rate
is consistent with over-defence *and* with three fixed defects plus a real loss
limit doing its job — and today's evidence favours the second reading.

# 4. Blocked packages

| WS | Blocker |
|---|---|
| WS-03 C++ execution authority | needs sidecar runtime + broker ack traces |
| WS-04 TrailEngine | needs tick-level C++ telemetry |
| WS-05 stop-loss authorities | partially source-traceable; needs runtime precedence |
| WS-06 profit keeper | needs MFE-vs-realised per closed trade |
| WS-07 time caps | needs per-strategy timeframe vs cap comparison |
| WS-09 payoff truncation | needs MFE capture data |
| WS-10 counterfactual replay | needs hold-out backtest infrastructure; §19 forbids tuning and scoring on one period |

# 5. Human decision register

1. **F-GOAL-01** — one gating metric, or restate 68% as derived. The 12-Aug
   deadline is unreachable on the win-rate metric as measured.
2. **F-RISK-01** — is `maxMarginUsagePct` 40% intended as a hard cap? It is
   currently exceeded by 33%.
3. **F-POLICY-01** — enforce `mode`, or stop displaying it as a gate.
4. Whether the live account should rely on `enabled = 0` alone.

# 6. Mechanical gate (§11)

Run at the frozen SHA:

| Command | Result |
|---|---|
| `node --test agent/**/*.test.js` | **2225 pass**, 0 fail |
| `npx eslint .` | clean |
| `npx vitest run` | **550 pass**, 43 files |
| `npm run build` | ok |
| `npm run check:no-green` | ok |

Per §11: *a green gate does not erase a source finding outside the tested
contract.* None of the six findings above is covered by an existing test.

# 7. Completeness statement

- **Source SHA** `ed9a60f` · **deployed SHA** `ed9a60f` — matched.
- **Runtime accessed:** `/health`, `/state/veto-breakdown`, `/state/goal-tracker`,
  `/state/risk-full`, `/state/positions`, `/state/account-phases`, `/state/fx-legs`.
- **Packages completed:** 5 · **blocked:** 7.
- **Confirmed findings:** 6 · **conditional:** 0 · **over-defence established:** 0.
- **Independent review:** NOT PERFORMED. **External UAT:** NOT PERFORMED.
