# Per-account control, traffic lights and workspaces — design

Owner, 2026-07-28: *"i plan to switch to different trading-account. should i
have choices like pause scanning for this account while I work on another. and
whether I need traffic lights for scan, trade, etc for each account in the
list. if I pause (either stop pending order (kill them) or let the last pending
order finish), let plan"* · *"can you ensure each account would has it workspace
for settings, table, historical data, insights, logs"*

Status: **proposal**. No code changed. Every claim below is cited to the
current source.

---

## 0. The finding that reframes the question

You asked whether you *should have the choice* to pause one account while you
work on another. The honest answer is that you need more than a choice, because
**switching accounts today is not a pause — it is an abandonment.**

`POST /actions/ctrader-select-account` (`agent/routes/actions.js:3163`) does
three things on a genuine account change:

1. **Sweeps the old account's positions out of the bot's ledger.**
   `sweepMonitoredPositionsForAccount` (`agent/db.js:900` →
   `agent/db.js:878-893`) runs `UPDATE monitored_positions SET status =
   'closed', last_check_action = 'closed_account_switch'` for every active row
   **not** belonging to the new account.
2. **Collapses the account roster to one entry** —
   `setState(db, 'ctrader_account_roles_json', JSON.stringify([{ accountId,
   isLive, autopilot: true }]))` (`agent/routes/actions.js:3185`).
3. Repoints `ctrader_account_id`, the symbol map, balance and leverage
   (`actions.js:3183`, `3209-3213`).

The positions are still **open at the broker**. They are simply no longer
watched by us. Everything that protects them is keyed off active
`monitored_positions` rows, so switching away silently stops:

- trailing stops and the profit keeper,
- the per-position dollar loss cap (the GOOGL −$900 layer, `services/loss-cap.js`),
- the profit ratchet,
- time caps and the naked-position guardian.

What survives is only the broker-side SL/TP — *if* one was set. This is
precisely the failure mode you already paid for once.

**So: yes to per-account pause, but the first milestone is not the pause. It
is making "switch" stop meaning "abandon".**

---

## 1. The safety principle

One rule that constrains every design below:

> **Managing an open position is never pausable.**

Scanning is optional. Entering is optional. *Watching money that is already at
risk is not.* Any "pause" that stops stop-management is a bug wearing a
feature's clothes. A pause therefore means **"start nothing new"**, never
**"stop looking after what exists"**.

Corollary: an account can only reach a genuinely quiet state — nothing running
at all — when it is **flat**: no open positions and no live pending orders.
Until then it stays in a managing state, and the UI must say so.

---

## 2. Three switches per account, not one

Today pausing is three **global** flags — `scan_enabled`, `analyze_enabled`,
`autotrade_enabled` (read at `agent/loop.js:1911-1912`, `841`). They apply to
the whole process, so there is no way to quiet one account.

The registry already has the right column: `accounts.mode TEXT NOT NULL
DEFAULT 'manage_only'` with values `'active' | 'manage_only' | 'paused'`
(`agent/db.js:354`). It is **written** in three places but **enforced in
exactly one** — `getAutopilotAccounts` filters `a.mode === 'active'`
(`agent/services/account-registry.js:203`). Scanning, analysis, pending-order
work and the guards ignore it entirely.

Proposal: keep `mode` as the user-facing preset, but define it over three
independent capabilities, because they fail and resume independently.

| capability | what it governs | pausable? |
| :-- | :-- | :-- |
| **SCAN** | look for setups on this account's universe | yes — freely |
| **ENTER** | open positions, arm pending orders | yes — this is the money switch |
| **MANAGE** | stops, trailing, loss cap, ratchet, time caps, reconcile | **only when flat** |

Presets:

| mode | SCAN | ENTER | MANAGE |
| :-- | :--: | :--: | :--: |
| `active` | on | on | on |
| `manage_only` | on¹ | **off** | on |
| `paused` | off | off | on² |
| `archived` | off | off | off — permitted only when flat |

¹ Scanning while not entering is genuinely useful — you keep the insight
history warm for an account you intend to come back to, at the cost of some
scan budget. Make it a checkbox inside `manage_only` rather than assuming.
² Not a contradiction: `paused` means *you* have stepped away, so the machine
looks after what is open and starts nothing new.

`archived` is new and is what "I'm done with this account" should mean. It is
the only state that stops everything, and the system must refuse to enter it
while positions or pendings exist — with a message naming what is still open.

---

## 3. Traffic lights — yes, and exactly four

You asked whether you need them. Yes: with several accounts the single most
expensive mistake is *believing an account is quiet when it isn't*, and the
inverse — thinking it's working when its broker session is down. Four lights
per row, each with a one-line reason on hover:

| light | green | amber | red |
| :-- | :-- | :-- | :-- |
| **Link** | broker session authorised, reconcile fresh | reconcile stale > 2 min | disconnected / auth failed |
| **Scan** | scanning, last sweep < 1 revisit ago | scanning but starved (limiter queued, or revisit overdue) | off |
| **Enter** | armed, risk gate passing | armed but blocked (daily cap, streak breaker, margin floor) | off / halted |
| **Manage** | watching N positions, all with stops | watching, but ≥1 position has no stop | not watching while positions exist ← **must be impossible** |

The Manage light is the important one. It is red only if the invariant in §1 is
violated, so red there is an alarm, not a status. Wire it to a Telegram alert.

Beside the lights, two counts that make a pause decision consequential and are
currently invisible when switching: **open positions** and **live pendings**.

Amber deserves emphasis: "scanning but starved" is exactly the state production
was in this morning, and nothing on screen said so.

---

## 4. Pending orders when you pause — your actual question

A pending order is a *resting instruction that will fire while nobody is
watching*. That is what makes this the sharp edge of pausing, and why it
deserves an explicit choice rather than a default buried in code.

Three dispositions, all legitimate:

| choice | behaviour | when it's right |
| :-- | :-- | :-- |
| **`cancel`** *(recommended default)* | cancel this account's working entry orders on pause; log each one with its price so it can be re-armed | you are stepping away and will not be watching |
| **`drain`** | create no new pendings; let existing ones live to their natural expiry, then go quiet | your phrasing — "let the last pending order finish". Respects analysis already committed |
| **`keep`** | leave everything armed; only stop scanning | you're pausing for a few minutes, not leaving |

**Why `cancel` as the default:** a pending order encodes a prediction you made
under conditions you were actively watching. Once you switch accounts, that
supervision is gone. A fill then creates a *new position on an account you have
mentally left* — the worst outcome available. Cancelling costs only a missed
opportunity, which is recoverable; an unattended fill may not be.

**Important scope limit:** this applies to **entry** pendings only. Protective
stop-loss and take-profit orders live broker-side on open positions and are
never touched by a pause — cancelling those would be the naked-position bug.

`drain` needs one guard: a pending with no expiry never drains. Require an
expiry (or apply a pause-drain deadline, default 24h) and show the countdown,
otherwise "drain" quietly becomes "keep" forever.

Whichever is chosen, **write it down**: a `position_events` / `action_log`
record per cancelled or drained order, so tomorrow you can answer "why didn't
that trigger?"

---

## 5. Per-account workspaces

Measured, not assumed — 16 of 23 tables already carry `account_id`:

**Scoped (16):** `accounts`, `analyses`, `broker_deals`, `broker_orders`,
`cup_handle_diagnostics`, `decision_log`, `monitored_positions`,
`pending_orders`, `pending_signals`, `performance_snapshots`,
`position_events`, `risk_events`, `scans`, `signals`, `trade_postmortems`,
`trades`.

**Unscoped (7):** `action_log`, `agent_state`, `backtest_runs`,
`controller_heartbeats`, `regimes`, `symbol_hours`, `token_usage`.

So the *data* layer is largely there. Mapping the unscoped seven against what
you asked for:

| your ask | today | gap |
| :-- | :-- | :-- |
| **tables** (trades, positions, orders, events) | scoped ✓ | reads must filter by the *viewed* account, not the *selected* one |
| **insights** (postmortems, decisions, risk events, perf) | scoped ✓ | same — read-side scoping |
| **settings** | `agent_state`, **global** | the real gap — see below |
| **historical data** (backtests) | `backtest_runs`, **global** | add `account_id` |
| **logs** | `action_log`, **global** | add `account_id` |

Correctly global, and should stay that way: `regimes` and `symbol_hours` are
facts about *instruments*, not accounts — duplicating them per account would
multiply the broker load we just spent the day reducing.
`controller_heartbeats` is process health. `token_usage` is a process cost.

### 5.1 Settings — resolve, don't duplicate

`agent_state` is one flat key-value table holding every setting: risk config,
loss cap, profit ratchet, watchlist, strategy toggles. A per-account convention
already exists — `acctKey(accountId, key)` → `` `acct:${accountId}:${key}` ``
(`agent/services/account-registry.js:166`) — but only **two** keys use it today
(`account_balance_usd`, `account_leverage`; see `services/risk.js:280`, `296`,
`services/perf-ledger.js:154`).

Do **not** fork every setting per account — seven accounts × ~40 settings is a
configuration surface nobody can keep coherent. Instead a two-level resolver:

```
settingFor(accountId, key)  →  acct:<id>:<key>   if present
                            →  <key>             otherwise (the shared default)
```

So an account inherits your house rules until you deliberately override one,
and the UI can show **"inherited"** vs **"overridden for this account"** with a
one-tap revert. That is the difference between per-account settings that stay
maintainable and seven drifting copies.

Which settings should be overridable is a real decision: risk sizing and the
protection layers clearly yes; the symbol universe probably (`accounts.symbol_universe`
already exists, `agent/db.js:357`); LLM/provider settings almost certainly not.

### 5.2 The read-side switch

The subtle part. Scoped tables are only half the job — every read must scope to
the account **being viewed**, which is not necessarily the one being traded.
Today `getState(db, 'ctrader_account_id')` is the implicit answer everywhere.
A workspace needs an explicit *viewed account* that flows from the UI through
every `/state/*` route, defaulting to the selected one. Without that, you'll
switch the workspace and still be reading the trading account's numbers.

---

## 6. Milestones

Ordered by risk removed, not by effort.

| # | milestone | why first |
| :-- | :-- | :-- |
| **A1** | **Stop the switch from abandoning positions.** Keep the old account in the roster and its `monitored_positions` active whenever it has open positions; switch changes only the *viewed/entering* account. Refuse (or loudly warn) on a switch away from an account with unmanaged exposure. | closes a live money risk that exists today |
| **A2** | **Enforce `accounts.mode`** at the scan, analyse, entry and pending sites — the column exists and is ignored. Add the three-capability model and `archived`. | makes "pause" real |
| **A3** | **Pause disposition for pendings** — `cancel` / `drain` / `keep`, per account, with the audit record and the drain deadline. | your specific question; small once A2 exists |
| **A4** | **Traffic lights + counts** on the accounts list, Manage-red wired to Telegram. | you can't operate what you can't see |
| **A5** | **Workspace reads** — a viewed-account parameter through `/state/*`, plus `account_id` on `action_log` and `backtest_runs`. | per-account tables/insights/history/logs |
| **A6** | **`settingFor()` resolver** + inherited/overridden UI. | per-account settings, without seven drifting copies |

A1 and A2 are the ones I would not run a second live account without.

---

## 7. Open decisions for the owner

1. **Default pause disposition** — I recommend `cancel`; `drain` is the closest
   to your wording. Which should be the default, and should it be per-account?
2. **Scan while `manage_only`?** Costs scan budget shared with the active
   account; buys warm insight history. Default off, opt in per account?
3. **Which settings are overridable per account** — risk sizing and protection
   layers yes; what else?
4. **Should switching require the old account to be flat**, or is a warning
   with an explicit "leave it managed in the background" enough? (I lean to the
   latter — a hard block would be unusable.)
5. **Archive semantics** — does archiving retain history for reporting
   (recommended) or hide it from all aggregates?
