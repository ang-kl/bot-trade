# NASA programme — current baseline (13-10-2026)

Claude · № 14,078+ 13-Oct (owner: NASA programme step 1, "Begin with the
current-baseline inventory"; claude-builder).

Source assessed: `doc/bot-trade-NASA-assessment-2026-10-13.md` (pinned at
1688c448). Baseline read against `origin/main` 2392c24 and production
(sg-trade, commit 2392c24) on 13-10-2026 05:00–06:10 UTC. NASA chapter
references are the assessment's; they are guidance. Authority to change code
comes from the owner's programme order and the standing rules in CLAUDE.md,
not from NASA text.

States used: **Fixed** (code and evidence on main), **Open** (confirmed gap),
**Pending existing PR** (fix exists, not merged), **Not Verifiable** (cannot be
established from what is readable here).

## 1. Findings classified

| # | Finding | State | Evidence (this baseline) |
|---|---|---|---|
| A | Account commission collected, not used by the gate | **Read-only check extended (#1358, NASA-4); gate use is an owner decision** | `commission-terms.js` is read/record only; `/state/commission-terms` notes "The risk gate does not read these terms yet." Live check, 30 days: 47790949 29 symbols agree / 0 disagree / 15 not compared; 46130058 27 / 0 / 12; 46979908 22 / 0 / 7; **43097342 and 42993489 (SGD deposit) 0 compared** (`deposit_currency_SGD`). Not-compared reasons: quote currency not USD (13), base-currency USD price unknown (19), terms not recorded (1), minimum commission on a split position (1). |
| B1 | Ordinary bot entry records the gate's lots, not the lots sent | **Fixed** (#1348 b2e3af5, #1350 1d2d7c7) | `loop.js` sets `volLots = sized.lots` before the intent insert; the gate's figure is kept as `requested_volume` only when it differs. |
| B2 | Filled vs residual not distinguishable on an open row | **Fixed in the NASA-3 PR** (`trades.filled_volume` + source; opened_lots labelled) | `trades.volume` is rewritten to the residual by the keeper scale-out (`keeper-close-receipts.js:209`), the general partial (`general-partial-execution.js:181`) and re-strategize volume changes (`restrategize.js:105`). `/state/positions` `opened_lots` reads `trades.volume` (`routes/state.js:956`), so after a bot partial it shows the residual. No column holds the filled opening quantity. |
| B3 | `requested_volume` has two meanings | **Fixed in the NASA-3 PR** (the residual is no longer copied after a reduction) | Entry writes it only when gate ≠ sent (loop.js). Broker history import writes `requested_volume = COALESCE(requested_volume, volume)` before overwriting `volume` with the closing deals' lots (`broker-history-import.js:468`): for a scaled-out row that "requested" value is the residual, not any request. `position-history.js:270` already treats it as a plan field never compared — the population is only mislabelled, not mis-scored. |
| B4 | Other writers of `trades.volume` | **Inventoried; see §2** | 6 INSERT sites, 9 UPDATE sites. |
| C1 | Import guard misses inline `await import(...)` and the second import on a line | **Pending existing PR (NASA-2)** | Confirmed on Node 22.22.2 with the exact regex. The parser that replaces it also found what the regex hid: `strategies.js` loads 8 strategy modules through `import(path)`, and `loop.js` reaches research code at run time through `performance-populations.js` `buildReport` and the research route handlers (load time: none). |
| C2 | Timer check blind to an interval | **Pending existing PR (NASA-2)** | Measured on Node 22.22.2 and Node 20.20.2 (`/opt/node20`): `_getActiveHandles` reads 0 for ref'd, unref'd and immediate; `getActiveResourcesInfo` misses unref'd timers. The replacement probe catches all six violating fixtures on both runtimes. |
| D | Research monitor: missing reading skipped, null baseline disables the delta check, no freshness check | **Pending existing PR (NASA-2)** — and a fourth gap found: `fastMonitorReading` turned an absent figure into 0 (`Number(null)`), i.e. "no skipped ticks" | `bar-form-research.js` `poll`: `if (!r) return`; `before == null` skips the skipped-tick delta; reading `at` never compared with now. No production occurrence measured; every run this session showed 0 skipped ticks and no breach, but that is the instrument whose validity is in question. |
| — | PR #1348 (lots) | Merged; its two follow-ups merged in #1350 | — |
| — | Open PRs / agent locks | none / none at 05:20 UTC | GitHub PR list; `agent-locks` branch. |

## 2. Quantity population (B) — every writer of `trades.volume`

| Writer | Path | Writes | Unit | Contract today |
|---|---|---|---|---|
| `loop.js:1159` INSERT | bot market dispatch | lots sent (`sized.lots`); `requested_volume` = gate lots if different | lots | **sent** ✔ |
| `routes/actions.js:127,176` INSERT | manual order / execute-analysis | lots typed and stepped (#1329, #1348) | lots | **sent** ✔ |
| `services/pending-orders.js:195` INSERT | pending order filled | order volume | lots | sent; not re-checked this baseline |
| `services/reconciler.js:876` INSERT | adoption of a broker position | broker volume → lots | lots | **broker current** (residual if already reduced) |
| `db.js:1463` INSERT | migration/backfill | historical | lots | historical; not touched |
| `reconciler.js:743` UPDATE | heal a units-as-lots row | broker lots | lots | **broker current** |
| `keeper-close-receipts.js:209` UPDATE | keeper scale-out receipt | residual | lots | **residual** (overwrites sent) |
| `general-partial-execution.js:181` UPDATE | general partial receipt | residual | lots | **residual** (overwrites sent) |
| `restrategize.js:105` UPDATE | volume change seen | old lots × ratio | lots | **residual estimate** (ratio, not broker lots) |
| `broker-history-import.js:468` UPDATE | closed row | sum of closing deals' lots | lots | **filled-and-closed** (closed rows only) |
| `cross-account-duplicates.js:135` UPDATE | duplicate reopen fix | broker twin's volume | lots | broker current |
| `momentum-entry-contract.js:185` UPDATE | momentum entry contract | contract lots | lots | sent |
| `loop.js:3208` UPDATE | (fill confirmation path) | — | lots | to be read in NASA-3 |
| `routes/actions.js:218` UPDATE | manual route | — | lots | to be read in NASA-3 |

Consumers that read `trades.volume` as "opened": `/state/positions`
`opened_lots`; position-history `requested_volume` fallback. Consumers that read
it as "current": the risk audits after re-strategize. One column serves both.

## 3. Requirements per confirmed gap

### R-A Commission (A) — owner decision before any gate change
- **Expected outcome and source:** per account and symbol, the commission the
  broker charges equals the model from the broker's own `ProtoOASymbol` terms
  (spotware/openapi-proto-messages) — checked against that account's own
  closing deals (`broker_deals`), not against `tick-shadow-sim.json`.
- **Population:** five accounts; FX, metals, indices, energies, crypto, US and
  HK shares; commission types 1–4; minimum commission; two deposit currencies
  (SGD 43097342 / 42993489, USD the others).
- **Units and freshness:** terms recorded 12-10 23:33 UTC per account; money in
  the deposit currency; the check must say which conversion it used and its
  age.
- **Failure behaviour:** a symbol that cannot be compared stays "not compared"
  with its reason; it is never modelled from the class schedule silently.
- **Acceptance:** zero disagreements on compared symbols; SGD accounts
  compared through a recorded SGD rate; quote-currency and base-currency cases
  priced from a recorded quote. **Gate use stays with the owner** (task #44
  step 3).

### R-B Quantity contract (B2, B3)
- **Expected outcome and source:** proposed, sent, filled and residual lots are
  each recoverable for every position. Sources: the order request (sent), the
  broker's opening deals (filled), the broker position (residual).
- **Population:** §2's 15 writers; ordinary, manual, execute-analysis,
  pending, momentum, tick, adoption, reopen paths; all five accounts.
- **Units:** lots, with the account's own lot size for units; the source of
  each figure named (`lots_source` already does this for current lots).
- **Failure behaviour:** an unknown filled quantity stays unknown (NULL with a
  reason); it is never reconstructed from the request.
- **Acceptance:** after a bot partial on a demo account, `opened_lots` equals
  the opening deals' lots and `current_lots` the broker residual; a test per
  writer fails before and passes after.

### R-C Research isolation instruments (C1, C2)
- **Expected outcome:** the guard fails on every import form Node accepts
  (static, re-export, dynamic, inline, several on one line, comments and
  strings excluded) and on any timer left by a research module.
- **Source:** the ECMAScript module grammar (static `import`/`export … from`,
  dynamic `import()`), Node's `process.getActiveResourcesInfo()` (documented
  since Node 17).
- **Population:** every research module the isolation test lists; Node 22
  (CI, this container) and Node 20 (production image).
- **Failure behaviour:** a detector that cannot run on a runtime fails the
  test, it does not skip.
- **Acceptance:** deliberately violating fixtures fail; clean fixtures pass.

### R-D Research monitor (D)
- **Expected outcome:** a run proceeds only while a fresh monitor reading
  exists; a missing or stale reading is recorded as unknown and stops the run
  (or refuses its start) with a named reason.
- **Source:** the run's own declared limits (`agent/config/research.json`);
  the owner's order that research be blocked without the health evidence.
- **Population:** bar-form research job (the tick research job shares the
  slot; same rule to be applied there in a follow-up if it has a monitor).
- **Failure behaviour:** `monitor_unavailable` / `monitor_stale` /
  `baseline_unavailable` are terminal states with the last reading kept.
- **Acceptance:** fixtures for missing, stale and baseline-less readings each
  stop the run; a fresh reading lets it continue.

## 4. Order of work

1. NASA-2 (C1, C2, D): test and research code only — inside the authorised
   scope. Built in the NASA-2 PR.
2. NASA-3 (B2, B3): a filled-lots field written from the opening deals; the
   keeper/general partial keep it. Touches `keeper-close-receipts.js` and
   `general-partial-execution.js` (protected): **owner names the files first**.
3. NASA-4 (A): extend the read-only check to SGD and non-USD quotes. Gate use
   is the owner's decision.
4. NASA-5/6: fault matrix and the train/confirm validation. Live half 2 of
   the bar-form research has completed (no persistence on live or demo).

### Account scope (owner, 13-10 after № 14,148: "include the live account as well")

Every remaining step covers the live account **42993489** beside the three
demo accounts **43097342, 47790949, 46130058**:

| Step | Live account 42993489 |
|---|---|
| NASA-3 quantities | its rows and writers are in the population; acceptance read from its own deals |
| NASA-4 commission | compared against its own deals; it is SGD-deposited, so it needs the SGD conversion path (today 0 of 3 symbols compared) |
| NASA-5 fault matrix | every invariant checked on it read-only (positions, deals, records) |
| NASA-5 bounded validation | any step that PLACES or CHANGES an order on the live account is asked first (P7: live-account operations), stated per step |
| NASA-6 validation | reported per account with its own denominator, in SGD, never pooled with USD accounts |

## 5. Three completion states (kept separate)

| | Implementation verified | Operations validated | Financial objective demonstrated |
|---|---|---|---|
| A | partial (read-only check) | Not Verifiable | Not Verifiable |
| B1 | yes | production read 13-10: 5 positions, lots from reconcile | Not Verifiable |
| B2/B3 | no | no | — |
| C/D | NASA-2 PR: violating fixtures detected, 9 mutations red | Node 22 + Node 20 probe runs in this container; CI runs Node 22 | — |

## 6. Progress (13-10 evening)

Claude · № 14,322 13-Oct (claude-builder).

| Step | PR | State |
|---|---|---|
| NASA-2 research instruments | #1355 | merged 13-10 |
| Audit fix 4, MAE/MFE exit side | #1356 | merged 13-10, read back: columns fill on open markets |
| Audit fix 5, hybrid trigger from the broker fill | #1357 | merged 13-10, read back: DOW.US #1806 no longer `monitor_entry_conflict` |
| NASA-4 commission, per-deal broker rates | #1358 | see the PR; live check: new closing deals carry rates, USD accounts read ratio 1 |
| NASA-3 quantity contract | NASA-3 PR | filled lots from the position's own deals (sweep), closing deals, pre-partial broker volume, first sighting; opened lots labelled |
| NASA-5 fault matrix | batch 1: `agent/acceptance/matrix.json` + its test | started 14-10 on the owner's word ("start NASA-5 and NASA-6"); 13 order/exit forms × 8 adverse events: 70 covered by named real-path tests, 32 gaps (the next batches' work list), 2 not applicable (batch 3, 14-10: 9 existing tests cited; batch 4: weekend-bank recheck fix + 3 new receipts, time_cap × missing reopened). Batch 2 (14-10): every receipt is also proven to RUN and pass in the test runner (a reporter records passed, non-skipped tests by file and title), so dead code or a runtime skip no longer counts. Bounded demo validation and any live-account order stay ask-first. |
| NASA-6 strategy validation | batch 1: train/confirm split in bar-form research | started 14-10; selection on train only, confirm judged by the owner's replay bar (tick-validation.json replay). A research run stays on the owner's word. |

Sent lots after `trades.volume` is rewritten: bot rows keep them on
`entry_intents.volume`; manual-route rows have no separate record (left out of
NASA-3, stated).
