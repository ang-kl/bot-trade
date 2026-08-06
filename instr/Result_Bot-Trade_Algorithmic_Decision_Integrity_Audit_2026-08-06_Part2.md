# Result — Algorithmic Decision Integrity Audit, PART 2: the blocked sections, unblocked

**Continues:** `instr/Result_Bot-Trade_Algorithmic_Decision_Integrity_Audit_2026-08-06.md`
**Run:** 2026-08-06 03:52–04:00 UTC · **SHA at run:** `8cebc92` (`main`)
**Mode:** READ-ONLY RUNTIME. No order placed, amended, cancelled or closed. No credential,
account mode, risk limit or environment variable changed. Every number below was read
through the read-tier credential over `GET /state/*`; the raw payloads are in
`audit/algo-integrity-2026-08-06/evidence/part2/`.

---

## 0. Why this part exists

Part 1 reported **7 of 18 hypotheses BLOCKED** and marked §9–§15 unavailable, for one
stated reason: *"this environment has no agent DB and holds a read-tier credential by
design."* Part 1's §7 then listed, per blocked deliverable, the exact evidence that
would complete it.

That reasoning was correct about the database and **wrong about the credential**. The
read-tier credential is not a barrier to reading — it is the thing that grants reading.
Every blocked item in §7 named data that production already exposes on an authenticated
read route. Part 1 concluded "no production data" from the absence of a local DB file
without checking whether the same rows were reachable over HTTP. They were.

Two further changes since Part 1 removed the remaining obstacles:

- **§13's blocker is gone.** It required *"a recent successful broker session, fresh
  tick, reconciled state"* and reported the sidecar unreachable. Both sidecars are now
  reachable and all five accounts are authorised and trading (#660–#666).
- **The four demo accounts are authorised.** Part 1's funnel had almost no post-gate
  rows to read because dispatch was short-circuited upstream. It no longer is.

So this part completes what it can and says plainly what still cannot be done.

**Headline: the central verdict changes.** Part 1 said `EDGE UNPROVEN` and left open
whether the edge was absent or merely unmeasured. With the funnel readable, a third
answer appears, and it is the one the evidence actually supports: **the system is not
failing to find edge — it is refusing almost everything it finds, against a payoff
threshold it has never once achieved.**

---

## 1. F-RR-01 — the R:R floor in force is 3–4× the configured one (CRITICAL)

### The measurement

`GET /state/risk-full?account=<id>`, all five accounts, 2026-08-06 03:56 UTC:

| Account | Effective `minRR` | Global default | Ratio | Side |
|---|---|---|---|---|
| 43097342 | **6.16** | 1.5 | 4.1× | demo |
| 46130058 | **6.00** | 1.5 | 4.0× | demo |
| 46979908 | **5.00** | 1.5 | 3.3× | demo |
| 47790949 | **4.68** | 1.5 | 3.1× | demo |
| 42993489 | **4.50** | 1.5 | 3.0× | **LIVE** |

Each value sits in that account's own overlay: `risk.overlayKeys` contains `minRR` and
`risk.overridden` lists it, scoped to the account. The global `risk_config_json` still
reads `minRR: 1.5`, which is why every previous look at this number — including mine
earlier in this session — reported 1.5. `GET /state/risk-full` takes `?account=`, not
`?accountId=`; an unrecognised query parameter is silently ignored and the **global**
config is returned. That is how a per-account risk limit stayed invisible.

### What it costs

`GET /state/veto-breakdown`, 7-day window, 60,989 vetoes across 266 distinct guards:

| Vetoes | Guard family |
|---:|---|
| 30,123 | `unknown_daily_pnl (account)` — **now cleared**, see §4 |
| **11,211** | **`bad_rr`** |
| 3,671 | `daily_loss_limit_hit` |
| 3,069 | `enabled in registry but not in the sidecar authorized roster` — fixed by #660–#666 |
| 2,353 | `strategy 'fib_confluence' is OFF` |
| 1,620 | `insufficient_equity … usd_per_lot_unknown` |

`bad_rr` splits by the floor it was tested against:

| Vetoes | Floor | Example |
|---:|---|---|
| 4,761 | 4.5 | `bad_rr 1.54<4.5` |
| 2,970 | 3.2 | `bad_rr 1.60<3.2` |
| 1,309 | 4.68 | `bad_rr 1.60<4.68` |
| 1,203 | 2.68 | `bad_rr 2.00<2.68` |
| 299 | 5 | `bad_rr 2.00<5` |
| 166 | 6.16 | `bad_rr 2.49<6.16` |
| 164 | 6 | `bad_rr 2.49<6` |
| **311** | **1.5** | `bad_rr 1.48<1.5` |

**Only 311 of 11,211 — 2.8% — were judged against the documented 1.5 floor.**

A 100-row sample of `risk_events` for 47790949 shows 93 of the last 100 proposals
vetoed as `bad_rr`, every one against 4.68, spread across seven different strategies
(`fib_618_fade`, `burnin`, `vp_value`, `fib_confluence`, `va_breakout`,
`donchian_breakout`, `vwap_trend`). Rejected R:R values: 1.48, 1.50, 1.54, 1.59, 1.60,
2.00, 2.49, 2.74. This is not one strategy proposing bad trades. It is every strategy
proposing ordinary trades into a gate calibrated for extraordinary ones.

### The finding that makes it a defect rather than a preference

`GET /state/postmortems` for 47790949 — 30 closed trades with `r_multiple`:

```
n=26 with an R multiple   mean +0.03R   median -0.01R   range -0.11R … +0.91R
wins 8 (30.8%)  avg +0.15R
losses 18       avg -0.03R
BEST REALISED R ON ANY WINNING TRADE:  +0.91R
```

**The entry gate demands 4.68R. The best outcome this account has ever realised is
0.91R.** The average winner returns 0.15R. The gate is not filtering for a payoff the
system sometimes achieves and sometimes misses — it is filtering for a payoff the
system has never once produced, by a factor of five.

Two readings are possible and they are not exclusive:

1. **The floor is mis-set.** Nothing at 4.68R survives contact with a real market on
   these instruments and timeframes, so the gate approves ~1% and the strategies never
   get to demonstrate anything.
2. **The exit engine truncates.** Trades that *are* approved at RR ≥ 4.68 still close
   at ≤ 0.91R, which means the profit keeper, the ratchet, the time cap or the trail is
   ending them long before the target the gate insisted on. The gate demands 4.68R of
   *planned* payoff and the exit engine delivers 0.15R of *realised* payoff on winners.

Either way the entry gate and the exit engine are calibrated against different
universes, and the R:R the gate enforces is not a quantity the rest of the system is
built to capture. **This, not strategy quality, is the dominant reason the edge is
unproven: the system takes 7 trades a day out of 1,802 opportunities.**

### What is NOT claimed here

I am not asserting the correct value of `minRR`, and I have not changed it. `minRR` is
a risk limit and CLAUDE.md reserves those for the owner. What is asserted, and
evidenced, is narrower and factual: **the enforced floor is not the configured floor,
it differs per account, it was not visible on the route built to show it, and it
exceeds every payoff the system has actually realised.**

### Provenance — an honest gap

`GET /state/config-proposals` shows **no open `minRR` proposal**. `config-controller.js:132`
does contain a rule `minRR_below_breakeven` that proposes *raising* `minRR` when the
realised payoff is below breakeven, and its output shape matches these values. But I
could not read an applied-proposal history that names the write, so **I cannot prove
these five values came from that rule rather than from a manual edit.** Recorded as
unknown rather than assumed. The evidence needed is the `action_log`/`bot_changes` rows
carrying the `acct:<id>:risk_config_json` write.

---

## 2. F-SIZE-01 — a single trade spent more than the whole day's risk budget (DANGER)

From `GET /state/config-proposals`, account 46130058, severity `danger`, raised by the
system's own controller and still open:

> *"A single trade lost 9,171.76 against a daily cap of 8,293.13. One trade spent more
> than the whole day's risk budget, so position sizing is not enforcing the per-trade
> risk it claims. Raising the daily cap would hide this, not fix it."*

This is Part 1's §11 (risk of ruin, capital fragility) — the deliverable that was
blocked for want of balances and positions. It is now answered, and the answer is that
**the per-trade risk control did not hold.** `perTradeRiskPct` is 0.01 and
`maxRiskCapPct` 0.015; a loss of 110% of the daily cap in one position is not
consistent with either.

Part 1 rated capital safety `MIXED` on the grounds that the *controls exist in code*.
They do. This is evidence that at least once they did not *bind*. That moves the §11
verdict from "controls present, sufficiency BLOCKED" to **"controls present, at least
one documented breach, sufficiency DISPROVED for that case."**

The controller's own recommendation is the right one and I endorse it without
qualification: **find why that trade was sized past its own stop before changing any
cap.** Owner decision; no change made.

---

## 3. F-PEND-01 — the pending-order engine is arming a disabled strategy

`GET /state/pending-orders`, account 47790949, 50 rows:

| Status | Count |
|---|---|
| `expired` | 49 |
| `working` | 1 |

| Strategy | Rows |
|---|---|
| `fib_confluence` | **45** |
| `vwap_trend` | 4 |
| `rsi2_reversion` | 1 |

`fib_confluence` is **OFF** — it accounts for 2,353 vetoes reading
`strategy 'fib_confluence' is OFF in Auto Trade & Open`. So the pending-order engine is
placing resting orders for a strategy the risk gate will refuse on sight, and 49 of 50
duly expired unfilled. All 50 carry an `order_id`, so these reached the broker.

This is Part 1's §14, previously blocked. The lifecycle itself is sound — orders are
placed, tracked, and expired correctly, with no leaked or orphaned rows. The defect is
upstream: **nothing checks the strategy toggle before arming a pending order.**

**Attribution gap, reported rather than smoothed over:** the route's own coverage block
says `total 507, attributable 117, unstamped 390, pct 23.1, complete: false`. **77% of
pending-order rows carry no account stamp**, so the per-account figures above describe
under a quarter of the population. The direction of the finding is not in doubt — 45 of
50 for a disabled strategy is not a sampling artefact — but the magnitude is not
established, and no rate computed from these rows should be treated as portfolio-wide.

---

## 4. §10 — the opportunity and veto funnel, previously blocked

`GET /state/opportunity-funnel`, 1-day window:

```
opportunities   1,802
  approved         18   (1.0%)
  ordered          10   (55.6% of approved)
  filled            7   (38.9% of approved)

evaluations     8,237      re-evaluation ratio 4.6×
unkeyed           434      excluded from every count above
```

Three separate leaks, and only the first was previously known:

1. **1,802 → 18 (−98.9%)** the risk gate. §1 above is most of this.
2. **18 → 10 (−44%)** approval to order. **Eight approvals never became orders.** This
   loss is *after* every guard has already said yes, and Part 1 could not see it at all.
   It is the highest-yield thing on this list: whatever is dropping these has already
   passed every deliberate filter, so nothing is protecting the account by dropping them.
3. **10 → 7 (−30%)** order to fill. Consistent with limit orders not being reached; not
   in itself alarming, but it means the realised trade count is 39% of the approved count.

The 7-day `summary` gives `proposalsApproved 1,092`, `proposalsVetoed 52,409`,
`approvalRate 2%`, `upstreamSkips 8,646`, `distinctGuards 266`. The 434 unkeyed
evaluations predate `opportunity_key` and are correctly excluded rather than silently
folded in — the route says so itself, which is the behaviour Part 1's §21 asked for.

**H04 (strategy starvation) is now testable and the answer is yes, but not for the
reason the hypothesis proposed.** Strategies are not starved of setups — 1,802
opportunities in a day is not starvation. They are starved of *approvals*.

---

## 5. §12 — trade management and profit retention, previously blocked

`GET /state/postmortems`, account 47790949, 30 closed trades.

**Classification** (what the system says happened):

| Class | n |
|---|---|
| `stop_hunt` | 9 |
| `clean_win` | 8 |
| `chop` | 5 |
| `time_cap` | 5 |
| `thesis_wrong` | 2 |
| `gave_back` | 1 |

**Result** (what the money did):

| Result | n |
|---|---|
| `Miss` | 17 |
| `Partial` | 12 |
| `Win` | **1** |

**These two tables disagree, and the disagreement is the finding.** The classifier
records 8 `clean_win`; the result column records **one** `Win`. A "clean win" that
produces a `Partial` is a trade whose thesis worked and whose payoff did not — which is
the same truncation §1 inferred from the R multiples, arriving here independently from
a different table.

`stop_hunt` at 9 of 30 (30%) is the largest single class, and combined with `chop` (5)
and `time_cap` (5) it says 63% of closed trades ended for a reason unrelated to the
thesis being wrong — only 2 of 30 are `thesis_wrong`. **The strategies are not
primarily being beaten on direction. They are being beaten on stop placement, holding
time, and exit discipline.**

**`entry_quality` is `unknown` on all 30 rows.** The field exists, is selected, and is
populated by nothing. Any analysis keyed on entry quality — including anything on the
Performance page that groups by it — is reading a constant. Reported as a data-quality
defect, not repaired here.

The strategy label is `other` on 19 of 30 rows, so per-strategy attribution from this
table is weak: 63% of the sample is unattributed. Part 1's §21 rule applies — that is
`blocked`, not `passed`.

---

## 6. What cleared on its own

**`unknown_daily_pnl` is no longer blocking.** It is the largest guard in the 7-day
window at 30,123 vetoes (49% of all vetoes), and it was task #180's finding. As of
2026-08-06 03:52 UTC, `GET /state/unknown-pnl` returns:

```
blocking 0   unfillable 0   writtenOff 0
verdict: "nothing is blocking — the daily-loss total is complete"
```

The historical count stands as a record of what it cost. The condition is resolved and
needs no action. **The consequence matters: with `unknown_daily_pnl` cleared, `bad_rr`
becomes the single largest live constraint on the system — 11,211 vetoes and now the
top guard by a wide margin.** §1 is therefore not merely the most interesting finding
here; it is the binding one.

---

## 7. Hypothesis ledger — Part 1's blocked rows, resolved

| ID | Hypothesis | Part 1 | Part 2 |
|---|---|---|---|
| H03 | Live/backtest mismatch | blocked | **still blocked** — needs bar-level fixtures; no bar route |
| H04 | Strategy starvation | blocked | **CONFIRMED, redirected** — starved of approvals, not setups (§4) |
| H09 | Wrong trigger clock | blocked | **still blocked** — needs runtime event timing |
| H12 | P&L lineage defects | blocked | **RESOLVED** — `unknown-pnl` reports a complete daily total (§6) |
| H13 | Pending-order lifecycle gaps | blocked | **CONFIRMED** — arms a disabled strategy; 77% unstamped (§3) |
| H14 | Defensive drift / winner truncation | blocked | **CONFIRMED** — 8 `clean_win` → 1 `Win`; best-ever 0.91R (§1, §5) |
| H16 | Capital fragility | blocked | **CONFIRMED** — one trade > full daily cap (§2) |

**5 of 7 previously-blocked hypotheses are now decided. 2 remain blocked**, both for the
same honest reason: they need bar-level and event-level data that no read route exposes.
Neither is marked passed.

---

## 8. What is STILL blocked, and what would unblock it

| Deliverable | Blocker | Evidence needed |
|---|---|---|
| §9 backtest validity, walk-forward, bootstrap CIs, cost stress | no bar route | a read route serving stored bars per symbol/timeframe, or a DB copy |
| §10.2 marginal veto counterfactual replay | as above | vetoed rows **plus** the bars after each decision timestamp |
| §15 human awareness study | requires the operator | owner time; charts rendered to the decision timestamp only |
| Provenance of the five `minRR` overlay writes | no applied-change route surfaced it | `action_log` / `bot_changes` rows carrying the `acct:<id>:risk_config_json` write |
| Per-strategy postmortem attribution | 63% of rows labelled `other` | the strategy-label backfill applied to `trade_postmortems` |
| Portfolio-wide pending-order rates | 77% of rows unstamped | account stamping backfilled on `pending_orders` |

**None of these is marked passed.**

---

## 8b. Looked at and NOT raised

Recorded so the absence is a decision rather than an omission.

- **`sizing_failed: cTrader error: CH_ACCESS_TOKEN_INVALID`** — real, and exactly the
  shape of a token-expiry incident. **2 occurrences in 60,989 vetoes.** Two events is
  noise, not a pattern, and inflating it would make this document less trustworthy, not
  more. Worth watching only if the count grows.
- **`weekend quiet hours`, 1,240 vetoes** — working as designed and owner-approved
  (task #164, with the crypto exemption in #172). Not a defect.
- **`enabled in registry but not in the sidecar authorized roster`, 3,069 vetoes** —
  real and expensive, but this is the outage already diagnosed and fixed across
  #660–#666. Reported in Part 1 as F-CONN-01; not re-raised here.
- **`overexposed_*` and `max_positions` families, ~2,100 combined** — concentration
  guards doing their job against the duplicate-cluster mechanism (tasks #179, #184).
  Correct behaviour.

---

## 9. Revised verdict

Part 1: `BOUNDED SPECULATION` · defence `MIXED` · **`EDGE UNPROVEN`**.

Part 2 keeps all three labels and sharpens the third. `EDGE UNPROVEN` remains correct,
but it is no longer the whole answer, because the reason is now visible:

> The edge is unproven **because the system almost never trades.** 1,802 opportunities
> produced 7 fills in a day, and the dominant filter is an R:R floor of 4.5–6.16 —
> three to four times the documented 1.5, set per account, invisible on the route built
> to display it, and higher than any payoff the system has ever realised (best 0.91R,
> average winner 0.15R). A gate calibrated above the system's demonstrated ceiling
> cannot be satisfied by a good setup; it can only be satisfied by a mis-measured one.

On defence, one label does change. Part 1 rated capital safety `MIXED` because the
controls exist in code. §2 documents a case where a control did not bind — one trade
losing 110% of the daily cap. That is not a stronger `MIXED`; it is a specific,
evidenced failure, and the system's own controller flagged it as `danger` before this
audit did. **Credit where due: the machine caught this one itself. Nobody had read it.**

### The order I would fix them in, and why

1. **§1 `minRR`** — binding constraint; nothing downstream can be measured until the
   funnel passes more than 1%. **Owner decision: it is a risk limit.**
2. **§2 per-trade sizing** — the only finding here that can lose money faster than it
   is measured. **Owner decision: it is a risk limit.**
3. **§4 leak 2, approval → order** — 44% loss *after* every guard approved. Almost
   certainly a plain defect rather than a policy, and it needs no risk decision to
   investigate.
4. **§3 pending orders for disabled strategies** — cheap fix, removes 2,353 vetoes and
   49 wasted broker orders from the record.
5. **§5 `entry_quality` always `unknown`** — a dead field silently degrading every
   analysis keyed on it.

Items 3–5 are ordinary defects I can take without a risk decision. Items 1–2 are yours.

---

## 10. Corrections to Part 1

Stated plainly, because an audit that will not correct itself is not an audit.

1. **"No production data" was wrong.** Part 1 inferred it from the absence of a local
   agent DB. The data was reachable the whole time over authenticated read routes, and
   Part 1's own §7 listed exactly which rows were needed without checking whether a
   route served them. Five of seven blocked hypotheses fell to a credential Part 1
   already held. **The lesson generalises: "I cannot read the database" is not the same
   claim as "the data is unavailable", and Part 1 treated them as one.**
2. **The read-tier credential was described as a limitation.** It is a limitation on
   *writing*. Framing it as a barrier to evidence-gathering is what produced (1).
3. **`minRR: 1.5` was reported as fact** in Part 1 and again by me earlier in this
   session, from an unscoped read. The scoped read gives 4.5–6.16. The number was never
   1.5 on any account that trades.

---

*No live action was taken in the production of this document. No order was placed,
amended, cancelled or closed. No credential, account mode, risk limit or environment
variable was changed. The two findings that call for a change to a risk limit — §1 and
§2 — are reported for the owner's decision and were not acted on.*
