# FIRST_RESPONSE — `instr/Bot-Trade_Safe_Implementation_Prompt_v1.0.md`

The prompt's `<FIRST_RESPONSE>` block asks for exactly five things and forbids
editing code until the first plan gate is approved. This document is those five
things. **No application code has been changed for this prompt.**

---

## 1 · Baseline facts

| | |
| :-- | :-- |
| Branch | `claude/handover-outstanding-file-1ktjs7` |
| HEAD | `290b8b9` (PR #508, open, CI green, **held for owner approval**) |
| `main` | `4a68bf6` |
| Node | v22.22.2 |
| Prompt's review anchor | `fc8577e` = "Sidebar session control replaces the page footer…" (PR #506) |
| Drift since the anchor | 2 owner doc-uploads (`9df8e68`, `4a68bf6`) + PR #507 (merged) + PR #508 (open) |
| Test tooling | `ws` and `better-sqlite3` **are** installed and runnable here — 1618 node tests, 303 vitest, all passing |

**The prompt's stated verification limitation does not apply to this
environment.** It says *"JavaScript runtime tests were not fully runnable because
`ws` and `better-sqlite3` were unavailable"*. Both resolve here and the full suite
runs, so JS findings can be validated by execution rather than inspection alone.
Nothing needs to be marked BLOCKED on that basis.

**What I cannot reach:** production. This environment holds `AGENT_SECRET` for
**staging only**. Every live figure in this document is staging. Any finding that
depends on production runtime state is marked BLOCKED, not confirmed.

---

## 2 · Finding validation

### P0-1 ACCOUNT SCOPE IS INCOMPLETE — **CONFIRMED**, with the exact fallback

`agent/services/risk.js:572`:

```js
const acct = proposal.accountId != null ? String(proposal.accountId)
                                        : (getState(db, 'ctrader_account_id') || null)
```

Same pattern at `risk.js:1063`. So a proposal that reaches the risk gate without
`accountId` has **every** scoped check silently evaluated against whichever
account happens to be *selected* — balance, leverage, exposure, open positions.
This is the finding, verbatim, and it is real.

C++ side also confirmed. `cpp-exec/src/engine.cpp` lines 317, 330, 337:

```cpp
withAccountId(payload, primaryAccountLocked())
```

The sidecar stamps the **primary** account onto write payloads.

**Partly already addressed, and the prompt does not know it.** PR #508 (open,
held) removed exactly this class of bug from the equity stop: it had a cap from
the selected account's balance, a loss summed across all accounts, and a disarm
of the master flag. Phase-2 must **build on #508, not redo it** — see the
dependency note in §3.

### P0-2 TIMEOUTS DO NOT FORM A DURABLE COMMAND MODEL — **CONFIRMED**

`agent/loop.js:124` says so in its own log line:

> `${name} exceeded its ${budget}s budget … abandoning the wait, cycle continues (run finishes detached)`

The wait is abandoned; the underlying broker work may still be in flight. There
is partial mitigation (the L3 idempotency work: no blind resubmit, a 3-minute
ledger dedupe, a duplicate-symbol veto), but there is **no command state machine
and no `unknown` state**. A timeout produces neither a durable `unknown` nor a
triggered reconciliation. TD-3 is genuinely missing.

### P1-1 THE FAST PATH IS NOT RELIABLY ACTION-FAST — **CONFIRMED**

- Session pool is opt-in: `ctrader-ws.js:167` gates on `poolEnabled()`.
- `fast-monitor.js:148` is a serial `for (const pos of positions)` — one slow
  broker call delays every later position in the same tick.

### P1-2 POST-FILL ANALYTICS BLOCKS LOCAL REGISTRATION — **CONFIRMED**

`agent/loop.js:531-591`: `await captureDepthAtEntry(symbolId)` and the
VWAP/relative-volume computation both run **before** the `INSERT` at :573. The
inline comment claims depth "never blocks", but the persist still sits after the
whole enrichment block, so a slow or hanging enrichment delays the moment a
confirmed fill becomes locally visible.

### P1-3 DEFAULT RISK AND BOOT BEHAVIOUR ARE AGGRESSIVE — **PARTLY CONFIRMED; one claim NOT REPRODUCED**

| claim | actual | verdict |
| :-- | :-- | :-- |
| 3% daily loss | `dailyLossPct: 0.03` (`risk.js:114`) | confirmed |
| 5 open positions | `maxOpenPositions: 5` (`risk.js:144`) | confirmed |
| absolute daily fallback | `dailyLossLimit: 300` USD (`risk.js:113`) | confirmed |
| ~5% risk per trade / 5% hard cap | risk is computed via `computeRiskBasedVolume(balance, …, riskPct, …)`; the percentage is supplied per call, not a single named default — **I did not locate a single authoritative 5% constant** | **not verified — do not accept as stated** |
| **"possible live autopilot at boot"** | `agent/db.js:532` seeds **`autotrade_enabled: 'false'`**, and `masterPhases()` reads `=== 'true'`, so an unreadable or fresh DB is **disarmed** | **NOT REPRODUCED** |

The last row matters: the prompt lists boot-armed autopilot as a P1 finding, and
the code deliberately defaults the other way, with a comment saying the asymmetry
is load-bearing. Implementing a "fix" for it would be work against a defect that
does not exist.

### P1-4 SOME DATA-DEPENDENT CONTROLS MAY FAIL OPEN — **NOT VALIDATED (mixed evidence)**

Counter-evidence exists and is strong: `unresolved-pnl.js` exists precisely to
make an unknown daily P&L **fail closed**, `loadGlobalGuards` fails closed on an
unreadable config, and PR #508 adds "no usable cap is not a breach" (which fails
*towards not acting*, the safe direction for a position-closing circuit).

I have **not** audited the quote / spread / margin paths, which is where the
finding actually points. Marking this validated either way would be a guess.

### P1-5 SECURITY IS TOO BEARER-TOKEN-CENTRIC — **CONFIRMED, two concrete instances**

1. **The login OTP is not cryptographically random.** `agent/index.js:325`:
   ```js
   const code = String(Math.floor(100000 + Math.random() * 900000))
   ```
   `Math.random()` is not a CSPRNG. The session token immediately below it *does*
   use `crypto.getRandomValues` (`index.js:250`), so the weakness is isolated to
   the 6-digit code — which is the thing an attacker would actually guess. There
   is a 5-attempt lockout and a 5-minute expiry, which limits but does not
   excuse it.
2. **Device sessions are stored as raw bearer tokens.** `index.js:243/255` keep
   `device_sessions` as `{ rawToken: expiresAtMs }` in `agent_state`, with a
   **90-day** lifetime. TD-9 asks for "short-lived hashed sessions"; neither
   property holds. (My own #506 browser-session store hashes for its *metadata*,
   but the map the auth middleware reads is still raw.)

### P1-6 HEALTH AND SIDECAR EXPOSURE IS TOO BROAD — **CONFIRMED, and worse than stated**

`GET /health` is **unauthenticated** (`index.js:260` skips auth for it), and it
returns:

- `clients` — the presence roster, which per `client-presence.js:132` includes
  **`ip`** for every open browser tab. So an anonymous request to the public URL
  returns **the owner's browser IP addresses**.
- `dbPath` **and `dbPathAbsolute`** — the container filesystem layout.
- `recentErrors` — a ring of recent error strings.
- `memoryMB`, `loopPhaseLag`, `loopCpuProfile` — internal timing detail.

I verified the endpoint is public and that the roster shape carries `ip`. This is
the highest-severity item I found that is **live right now and costs nothing to
fix**.

### P2-1 OPERATIONAL HARDENING IS INCOMPLETE — **BLOCKED**

Not validated. Container user, base-image pinning, `uncaughtException` policy,
dependency integrity and CI secret scope need the Dockerfiles, the Railway
service config and the CI workflow definitions read together. I did not do that
work and will not claim a verdict.

---

## 3 · Dependency-aware implementation plan

The prompt's own sequence is sound in its core (identity → durability → one
execution contract → then performance). I propose **two deviations**, both
argued in §4.

```
#508 (OPEN, HELD)  ── must land or be rejected first ──┐
                                                        │
S-0  SECURITY QUICK WINS  (pulled forward from Phase-8) │
     health exposure + OTP CSPRNG. No interaction with  │
     routing, concurrency or execution. Independent.    │
                                                        ▼
PHASE-0  baseline + risk register + safe-mode confirm
                        │
PHASE-1  characterisation tests + TWO-ACCOUNT FAKE BROKER
         ← the gate everything else depends on. Nothing
           in Phase 2+ is provable without it.
                        │
PHASE-2  account identity & routing  ── builds on #508 ──
         make missing accountId a hard error for writes;
         remove risk.js:572 / :1063 fallback; remove
         engine.cpp primaryAccountLocked() on writes
                        │
PHASE-3  durable commands + unknown outcomes (needs P2's
         immutable accountId to key the journal)
                        │
PHASE-4  one account-aware execution contract (needs P3's
         command identity)
                        │
PHASE-5  controlled concurrency ── LAST of the risky set,
         because it multiplies the blast radius of any
         residual routing or durability defect
                        │
PHASE-6  immediate fill + async enrichment (independent of
         P5; could run earlier if you prefer)
                        │
PHASE-7  live data policy + risk config separation
                        │
PHASE-8  remaining security hardening (CORS, OAuth, rate
         limits, sidecar networking)
                        │
PHASE-9  operations & release
```

**Why Phase-1 is the real gate.** Every safety claim after it — "one account
cannot close another's position", "a late broker success does not duplicate" —
is unprovable without a two-account fake broker with deterministic delays,
rejects, late responses and reconnects. Writing routing changes first would mean
asserting isolation instead of demonstrating it.

---

## 4 · Risks and pushback

<PUSHBACK>
finding_or_request: PHASE-8 places security hardening after concurrency (PHASE-5).
evidence: /health is unauthenticated (agent/index.js:260) and returns the presence
  roster including per-tab `ip` (client-presence.js:132), plus dbPathAbsolute and
  recentErrors. The login OTP uses Math.random() (index.js:325).
risk: Both are exposed RIGHT NOW, on a public URL, and neither has any
  interaction with routing, execution or concurrency. Sequencing them last leaves
  a live information leak and a weak auth secret in place through the phases most
  likely to need debugging with the endpoint open.
proposed_alternative: An "S-0" change unit before PHASE-0: move `clients`,
  `dbPathAbsolute` and `recentErrors` behind auth (keep an unauthenticated
  liveness subset — status/version/uptime — so the AgentDownBanner and Railway
  healthcheck keep working), and swap the OTP to crypto.randomInt. Two small,
  independently reversible diffs with no trading-path blast radius.
decision_needed: Approve S-0 as a standalone change unit ahead of PHASE-0.
recommended_action: implement alternative
</PUSHBACK>

<PUSHBACK>
finding_or_request: P1-3's claim of "possible live autopilot at boot".
evidence: agent/db.js:532 seeds autotrade_enabled: 'false'; masterPhases() reads
  `=== 'true'`, with an in-code comment stating the asymmetry (scan/analyze
  default ON, autotrade default OFF) is deliberate and load-bearing.
risk: Implementing a fix would change a default that is already correct, and the
  change would look like a safety improvement while actually being a no-op at
  best. It also risks disturbing the asymmetry that keeps a fresh or corrupt DB
  from arriving armed.
proposed_alternative: Mark P1-3's boot claim NOT REPRODUCED and drop it. Keep the
  numeric-default review (3% daily, 5 positions), which IS confirmed.
decision_needed: Confirm you accept the finding is wrong on this point.
recommended_action: investigate — the reviewer may have seen a *deployed*
  agent_state value of 'true' rather than a code default. That is a
  configuration observation, not a code defect, and needs production evidence.
</PUSHBACK>

<PUSHBACK>
finding_or_request: "Do not force-push" (AUTHORITY_AND_SAFETY).
evidence: I have force-pushed `claude/handover-outstanding-file-1ktjs7` twice
  today with --force-with-lease, to rebase my own unmerged feature branch onto a
  moved main.
risk: None to shared history — no rewrite of main, no data loss, lease-protected.
  But the instruction is unqualified and I would rather disclose than assume an
  exemption.
proposed_alternative: Read the rule as "no force-push to main or shared
  branches"; keep using --force-with-lease for rebases of my own open PR branch.
decision_needed: Confirm that reading, or tell me to use merge commits instead.
recommended_action: proceed with guardrail
</PUSHBACK>

<PUSHBACK>
finding_or_request: PHASE-0 step 3 — "Disable live autopilot and keep additional
  accounts in manage_only or observe."
evidence: On staging this is already the standing state (only 46130058 enabled,
  zero live rows enabled). I have no production credential, and a separate
  standing instruction forbids me enabling anything or touching live accounts.
risk: If PHASE-0 is read as "go and set production modes", that is a production
  state change I am both unable and instructed not to make.
proposed_alternative: I treat PHASE-0 step 3 as a VERIFICATION step on staging and
  a REQUEST to you for production. You confirm production's current live/autopilot
  state, or give me a read-tier production token so I can verify it myself.
decision_needed: Which of those two.
recommended_action: stop — this is a genuine gate; the prompt's own PHASE-0 gate
  says "stop and report if current live state is unknown". It is unknown to me.
</PUSHBACK>

<PUSHBACK>
finding_or_request: The prompt validates against `fc8577e`, and PR #508 is open,
  unmerged, and overlaps P0-1.
evidence: #508 already made the equity stop per-account (cap, loss, disarm, trip
  marker) and is held pending your approval because it changes when money stops.
risk: If PHASE-2 starts while #508 is unresolved, either the same fix is written
  twice, or #508 is rebased under a moving Phase-2 and the ironclad tests drift.
decision_needed: Merge #508, or reject it, before PHASE-2 begins.
recommended_action: stop
</PUSHBACK>

### Assumptions
- "Fake broker" means a new in-repo test double, not a third-party simulator.
- Feature-flag names may be adapted to the repo's existing `agent_state` /
  `risk_config_json` conventions rather than introducing env vars, since that is
  where every other switch lives and it keeps them observable in the UI.
- `TRADING_MODE` maps onto the existing account-registry `mode` column
  (`active` / `manage_only`) rather than becoming a parallel concept.

---

## 5 · The first approval gate

**I am asking to proceed with exactly two things, and nothing else:**

1. **S-0 (security quick wins)** — put `clients` / `dbPathAbsolute` /
   `recentErrors` behind auth while keeping an unauthenticated liveness subset,
   and replace the `Math.random()` OTP with `crypto.randomInt`. Two small
   reversible diffs, no trading path touched.
2. **PHASE-1 (characterisation tests + two-account fake broker)** — tests only,
   no production behaviour changed, and it is the prerequisite that makes every
   later safety claim demonstrable rather than asserted.

**Blocked on you, and I will not proceed past them:**

- **#508** — merge or reject. PHASE-2 overlaps it.
- **Production live state** — the prompt's own PHASE-0 gate says stop if it is
  unknown. It is unknown to me. Confirm it, or give me a read-tier production
  token.

I will not touch PHASE-2 (routing enforcement) or later until PHASE-1's tests can
actually detect a cross-account action.
