# Assessment 2026-10-08 — cross-contamination and the debt of unvetted code

Ordered by the owner after № 11,806 ("Can you do an assessment? Use empirical
evidence to perform litmus test for cross-contamination in the codebase and
technical debt now for unvetted code"). Reported at № 12,067. Session
`claude-builder`, https://claude.ai/code/session_01C1hz86KuE5JKVq6W2KtUE2.

Every number below is a measurement made 08-10-2026 02:53–03:10 UTC against
`origin/main` at `a75878d` (Codex №12,066, merged 02:15Z) and against
production as it answered at that time. Each litmus test names its threshold
BEFORE its value; the thresholds are mine and are stated so the owner can
reject them. Verdicts are Passed / Failed / Not Verifiable (§10 P3).

Nothing in production was changed by this assessment. Every read was a GET
with the read secret, a Railway log read, or a git/GitHub read.

---

## 0. Headline

| # | Litmus test | Threshold | Measured | Verdict |
|---|---|---|---|---|
| A1 | Stop-path files edited by both agents in 7 days | 0 | 7 of 7 (loop, actions, profit-keeper, trade-guard, exec-engine, guardian, stop-policy) | **Failed** |
| A2 | Files carrying both agents' code-comment stamps | ≤ 5 | 2 | Passed (weak: the convention is two days old) |
| A3 | Shared-symbol-map reads outside the selected account's own path | 0 | 17 call sites in 10 files, not classified per site | **Not Verifiable** (exposure 17) |
| A4 | Every Node stop amend is a ratchet transaction | 4 of 4 | 3 of 4 (loss-guardian is blind) | **Failed** |
| A5 | `is_live` allowlist shrinking (principle 1) | non-increasing | 103 → 108 files in 5 days (+5), 154 tokens | **Failed** |
| A6 | Four shared sidecar copies byte-identical | identical | identical; all four log as `[cpp-exec]` | Passed (with a mislabel debt) |
| A7 | Docs that direct production action match production | 0 stale | the re-anchor payload is stale (demo feed moved 46130058 → 47790949 within 23 h); 12 docs name removed/never-built routes | **Failed** |
| B1 | Merged PRs with a human review (24-09 → 08-10) | ≥ 50 % | 0 of 199 (0 %); 88 reviews exist, all COMMENTED by the Codex connector bot; the owner commented on 24 | **Failed** |
| B2 | Post-merge P1 findings (review after the merge) | 0 | 34 of 199 PRs (17 %) carry a P1 from the post-merge review, every one merged | **Failed** |
| B3 | Longest fix-chain (PR fixing the previous PR's P1) | ≤ 2 | 8 PRs in 26 h across both agents; 20 Node deploys in those 26 h | **Failed** |
| B4 | Test files that read `.js` source instead of behaviour | ≤ 5 % | 190 of 748 (25.4 %); 176 assert on the text | **Failed** |
| B5 | `origin/main` passes its own full gate | green | node --test 7,676 pass / 0 fail / 3 skipped; eslint clean, vitest 1,350 / 146 files, build, no-green: all green | Passed |
| B6 | Lint suppressions without a named rule | 0 | 75 of 110 `eslint-disable` lines | **Failed** |
| B7 | Production error-class lines since the 07-10 merges | 0 unexplained | 0 TypeError, 0 Unhandled; 4 `database is locked`; verify_watchdog failing 17× over 12 h, last 00:44Z | Passed for crashes; **Failed** for the watchdog controller |
| B8 | Log lines per hour that carry no decision | ≤ 100 | scanner ≈ 1,400/h (`slow request GET /comparisons`), Node ≈ 1,270/h (`trail-config N spec(s) for account`) | **Failed** |

Read the table as one finding: **the code is vetted after it is live, not
before.** Both agents merge under the standing gate within a median of 14
minutes of opening, the other agent's P1 arrives after the deploy, and the
fix ships as the next PR. The gate is green (B5) and production has not
crashed (B7), which is why the chain is survivable. It is still a chain of
eight production deployments to land one change (the ratchet amend), and
the docs that direct the owner's next production action are already wrong
(A7).

---

## 1. Method and sources

- **Repository**: `origin/main` `a75878d`, clone deepened to 23-09 (254
  commits). Commits classified by their subject/body markers: `Codex` →
  Codex; `Claude`, `claude-builder`, `Conversation ref` → Claude; the rest
  (dependabot, the owner's merges, unmarked) → other. 7 days: 57 Claude /
  30 Codex / 23 other. 14 days: 139 / 33 / 48.
- **GitHub**: the closed-PR listing (199 merged since 24-09), and for each
  of them the reviews, review comments and issue comments (B1, B2).
- **Production**: `GET /state/trail-status`, `GET
  /state/scanner-alignment-snapshot`, `GET /state/scanner-mirrors` (read
  secret); Railway deploy logs for bot-trade (Node), cpp-exec, cpp-verify and
  cpp-scan-tick from 07-10 03:50Z (the first ratchet deploy) to 08-10
  03:00Z; the Node deployment list (20 deployments in the window).
- **Static**: grep/AST-free counters over `agent/`, `src/`, `scripts/`,
  `cpp-*/src`, `docs/`. Heuristics are named as such.
- **Not used**: no subagent, no workflow, no external search. The counting
  script's corpus here is partial (§1 of CLAUDE.md), so the serial is
  ratcheted on the highest visible stamp (Codex's №12,066 in `a75878d`).

---

## 2. Cross-contamination

"Cross-contamination" is read as: two writers (two agents, or two services)
changing one thing on different premises, so that either's correct change is
undone or misread by the other. The litmus tests measure exposure first and
then look for the contamination that actually happened.

### A1 — co-edited files (exposure)

7 days on `origin/main`: 401 files touched, 63 by both agents, 42 of them
non-test source. The stop-writing path is where both agents worked the same
week:

| File | Claude commits | Codex commits |
|---|---|---|
| CLAUDE.md | 40 | 18 |
| agent/loop.js | 15 | 3 |
| agent/routes/actions.js | 7 | 3 |
| agent/services/profit-keeper.js | 6 | 3 |
| agent/lib/stop-policy.js | 3 | 2 |
| agent/lib/exec-engine.js | 3 | 2 |
| agent/services/guardian.js | 2 | 2 |
| agent/services/trade-guard.js | 1 | 4 |
| agent/db.js | 3 | 2 |

Threshold 0 stop-path files co-edited in 7 days: **Failed** (7). This is
exposure, not harm; the harm is measured in B3.

### A2 — both agents' comment stamps in one file

The dated code-comment convention (`Claude · № …`, `Codex · №…`) is two days
old, so this test has little power. 25 files carry Claude stamps, 27 carry
Codex stamps, 2 carry both: `agent/services/trade-guard.js` and
`src/components/common/Card.test.jsx`. **Passed** at ≤ 5, weakly.

### A3 — the shared symbol map read for a non-selected account

The class of defect behind #1248 → #1249 → #1250 → #1251 (the guard priced
and identified a row off the selected account's map). `getSymbolMap(db)` is
still read at 17 call sites in 10 non-test files (loop.js 5, actions.js 3,
ctrader-creds.js 2, state.js, index.js, pending-signals, tp-suggest,
strategy-autopilot, telegram-control, exec-parity). Whether each site runs
on the selected account's own path was not classified here; the per-site
reading is the next audit. **Not Verifiable** at this scope; exposure 17.

### A4 — five writers of one stop

The stop on a position is written by the sidecar's TrailEngine (per tick)
and by four Node services. After #1248 (Claude) and #1257 (Codex):

| Writer | `ratchetOnly` on its amend |
|---|---|
| profit-keeper.js | yes |
| trade-guard.js | yes |
| stop-policy-controller.js | yes (#1257) |
| loss-guardian.js | **no** — it writes a stop only on a naked position (`fromValue: null`), so a stop the engine armed between the guardian's read and its amend is replaced blind |

Threshold: every Node stop amend is a ratchet transaction. **Failed** (3 of
4). Low frequency (naked positions only), real window (the engine arms on a
push within a sweep).

### A5 — `is_live` outside routing (owner principle 1)

`agent/lib/one-account-model.test.js` allowlists every file that may read
`is_live` / `isLive`, by exact count. The allowlist has only grown:

| Commit | Date | Files allowlisted |
|---|---|---|
| b35ec42 | 02-10 | 103 |
| 09b5a70 | 05-10 | 104 |
| 0d684aa | 07-10 | 105 |
| 31ad4b1 | 07-10 | 107 |
| a626227 | 07-10 | 108 (one is mine: the re-anchor builder, routing only) |

154 tokens allowlisted. Principle 1 says only routing may read it; a guard
that admits five new readers in five days is recording the drift, not
stopping it. **Failed** (non-increasing required).

### A6 — the shared sidecar copies

`http_server.hpp/.cpp`, `json.hpp`, `log.hpp` are byte-identical across
cpp-exec, cpp-verify, cpp-scan-tick, cpp-scan-timeframe (sha256 equal).
**Passed**. The debt: every copy logs with the prefix `[cpp-exec]`
(`http_server.cpp:20` in all four), so the scanner's and the verifier's own
lines are attributed to the exec gateway — measured in cpp-scan-tick's
stream 02:58–03:00Z, 40 of 40 lines read `[cpp-exec] http: slow request …`.

### A7 — docs that direct a production action, against production

**The scanner re-anchor payload is stale.** `docs/scanner-realign-2026-10-07.json`
(796 profiles, `expectedRevision` 5bd5533f…) was built 07-10 04:03Z from a
snapshot whose demo tick feed streamed from **46130058**
(`docs/scanner-realign-evidence-2026-10-07.json` → `observedTickFeeds`). The
snapshot at 08-10 02:58:45Z reads the demo tick feed from **47790949**
(`tickFeeds[1].accountId`), the live feed unchanged at 42993489. The payload
moves 743 profiles onto 46130058 — an account the demo gateway no longer
streams — and the registry is still at 5bd5533f, so the compare-and-set
would ACCEPT it. The command in `docs/handover-2026-10-07-claude.md` §4.1 is
therefore wrong as written. Who moved the demo feed account between 07-10
04:01Z and 08-10 02:58Z is **Not Verifiable** from here (variables are
listed by name only; the scanner's log carries no account line).

Docs naming routes that do not exist on `main`: `/state/mae-chandelier`
(removed 03-10 in #1207) in 9 docs; `/state/scope-audit` and
`/actions/scope-audit` in 2; `/state/boot-record` in 1 (never defined).
Owner principle 5 ("the .md plans are checked"): **Failed**.

### A8 — the two agents' shared ledger

CLAUDE.md is 2,424 lines / 160 KB and was edited 40 times by Claude and 18
by Codex in 7 days. Two agents stamp one serial sequence: Codex's visible
stamp is №12,066, Claude's last was № 11,806, so this reply ratchets by 261
to stay above both. The ledger is where contamination shows first (CLAUDE.md
records two earlier double-counts). Debt, no verdict: the ratchet rule is
holding, at the price of a 160 KB file both agents must read every session.

---

## 3. Technical debt of unvetted code

"Unvetted" is read as: merged without a review by someone other than its
author before it reached production.

### B1 — human review before merge

199 PRs merged between 24-09 and 08-10 02:15Z (138 on claude/ branches, 32 codex/, 27 fix/, 2 other). Reviews on them: 88, every one in state COMMENTED and every one by the Codex connector bot (it commented on 197 of the 199). Human reviews in state APPROVED or CHANGES_REQUESTED: **0**. The owner commented on 24 PRs; all 199 were merged under the owner's token (the agents merge through it, so merged_by does not separate owner merges from agent merges). Size: median 405 lines changed per PR, p90 1,876, 179,924 lines changed in total over the fourteen days. Threshold ≥ 50 % with a human review: **Failed** (0 %). What vets the code is the standing gate (tests, lint, build, CI) plus the other agent's review after the fact; nobody reads a diff before it is live.

### B2 — P1 findings after the merge

34 of the 199 merged PRs (17 %) carry at least one P1 from the Codex connector's review: #1064, #1065, #1066, #1083, #1084, #1162, #1168, #1174, #1176, #1177, #1179, #1181, #1182, #1183, #1184, #1185, #1192, #1198, #1202, #1207, #1209, #1215, #1223, #1232, #1239, #1241, #1243, #1244, #1245, #1246, #1248, #1249, #1253, #1262. Every one was merged; by this repo's convention the P1 is fixed in the NEXT PR (CLAUDE.md), which is how the chain in B3 forms. On Claude's branches 23 of 138 (17 %), on codex/ 6 of 32 (19 %), on fix/ 5 of 27 (19 %): the rate is the same for both agents. Threshold 0 post-merge P1s: **Failed**. A P1 is, by the reviewer's own grading, a defect that should block a merge; 34 of them reached production first.

### B3 — the fix chain and the deploy count

One change — "a Node stop amend is a ratchet transaction on the sidecar" —
took eight PRs across both agents, each fixing the previous PR's P1:

#1246 (Claude, engine on by default) → #1248 (ratchet amends; Codex P1 on
#1246) → #1249 (identity symbol from the snapshot; Codex P1 on #1248) →
#1250 (quote/pip metadata by the snapshot id; Codex P1 on #1249) → #1251
(Codex: refuse without an owned symbol) → #1253 (push cadence cap) → #1254
(stop-known in the digest; Codex P1 on #1253) → #1257 (Codex: require
ratchetOnly plus own snapshot symbol/direction in the stop-policy
controller).

Each of them deployed: the Node service deployed 20 times between 07-10
00:10Z and 08-10 02:15Z (three of them the same commit `0aca9fca`,
redeployed on variable changes). The log window holds 15 `npm error signal
SIGTERM` groups — fifteen restarts — and 22 `sidecar unusable (no reconcile
data yet)` lines, one boot gap per restart. Threshold ≤ 2: **Failed**.

Median open-to-merge across the 199 merged PRs: 14 minutes (p25 9, p75 31);
110 merged within 15 minutes, 164 within an hour.

### B4 — tests that read source instead of behaviour

748 test files; 190 (25.4 %) `readFileSync` a `.js`/`.jsx`/`.mjs` source
file and 176 assert on that text (`match`/`test`/`includes`). CLAUDE.md's
failure mode #2 ("a test can pass by matching its own comment") is the
reason this is a litmus test and not a style note. Threshold ≤ 5 %:
**Failed**. 36 test files assign `process.env` (167 lines) — order-dependent
risk, measured as exposure only.

### B5 — `origin/main` under its own gate

Run on `a75878d` from a clean checkout (`node_modules` present):

- `node --test agent/**/*.test.js`: 7,679 tests, 7,676 pass, 0 fail, 3 skipped.
- npx eslint . clean; npx vitest run 1,350 tests / 146 files; npm run build; npm run check:no-green. All green. **Passed**. The gate is doing its job; what it cannot do is read a diff.

### B6 — suppressions and markers

110 `eslint-disable` lines in `agent/` and `src/`; 75 name no rule (a blanket
suppression), 9 `react-hooks/exhaustive-deps`, 4 `eqeqeq`. 36 `TODO`/`FIXME`
/`HACK`/`XXX` markers in non-test source. 1 `test.skip` (plus the 3 runtime
skips). Threshold 0 blanket suppressions: **Failed**.

### B7 — production since the 07-10 merges

Node deploy log, 07-10 03:50Z → 08-10 02:16Z, filter `error` (201 lines,
saturated at the 200-line read, so the counts are lower bounds; the
`TypeError`, `Unhandled`, `guard_ratchet`, `already_tighter` and `sweep
error` filters each returned nothing across the same window):

| Line | Count | Reading |
|---|---|---|
| `PM WMT.US […7342/…9908]: FULL_EXIT FAILED — MARKET_CLOSED (held until the session opens, retry in 15 min at most)` | 80 | the closed-market hold (#1186) doing its job: two rows, every 15 min, 04:25Z → 13:19Z, stopped at the US open. Info level, not a defect |
| `npm error signal SIGTERM` (5-line group) | 15 | one per restart |
| `[exec] reconcile: sidecar unusable ({"error":"no reconcile data yet"})` | 22 | the boot gap after each restart |
| `[phase-audit] controller verify_watchdog: failing — Nx in a row — watchdog incident record unreported (a cpp-verify build before the delivery channel was removed on 03-10-2026, or busy)` | 17 | intermittent across 12 distinct hours, last 08-10 00:44Z "3x in a row"; cpp-verify's latest deployment is SKIPPED (unchanged build), so "busy" is the live hypothesis — the D1 slim route (#1219) was meant to end this |
| `[loop] error: database is locked` | 4 | 07-10 04:23Z and 09:06Z |

Crash classes: **Passed** (0). The verify_watchdog controller: **Failed**
(a controller still reporting failure after the fix that targeted it).

Trail engine at 02:58Z: the demo side `enabled: true`, 1 tracked,
`alreadyTighter: 3`, `amendsOk: 5`, `amendsFailed: 0`, `lastPushRefusal:
null`. The ratchet is answering `unchanged` in production (3 of 8 amends),
which is the contamination #1248 was built to stop, now counted.

### B8 — log lines that carry no decision

- cpp-scan-tick: `[cpp-exec] http: slow request GET /comparisons status 200
  total 360 ms (read 0, handle 2, write 357)` every ~2.5 s — 40 of 40 lines
  in a 96-second read, ≈ 1,400 lines/h. The 250 ms slow-request threshold
  (#1203) is below the route's steady write time, so every poll is "slow".
- Node: `[since-entry-trail] trail-config N spec(s) for account N` 276 times
  in 13 minutes (≈ 1,270/h) beside 25 `pushed … (accepted)` lines. The
  per-account line fires every sweep; only the push line says anything.

Threshold ≤ 100/h of no-decision lines: **Failed**. Cost: the error-class
reads above saturate at 200 lines because of this volume.

### B9 — size and sprawl (no verdict, measured for the record)

- `agent/loop.js` 7,028 lines; `routes/actions.js` 6,594; `routes/state.js`
  5,191; `Tune.jsx` 3,824; `risk.js` 2,922; `Performance.jsx` 2,763;
  `db.js` 2,746.
- 3,442 exports in `agent/`; 349 (10 %) are referenced in no other file
  (heuristic: name match across `agent/` and `src/`; constants exported for
  tests are counted, so this is an upper bound on dead code).
- `docs/`: 141 files in the root, 196 doc files added since 24-09 (14 a
  day), 33,273 Markdown lines against 262,508 lines of agent JavaScript.

---

## 4. What to do, in order

1. **Do not run the §4.1 re-anchor command as written.** Rebuild the payload
   from a fresh `/state/scanner-alignment-snapshot` once the owner says which
   demo account the scanner is meant to stream from (47790949 is what it
   streams now). The builder refuses observations older than five minutes,
   so a rebuild is a one-command step; the apply remains the owner's.
2. **Loss-guardian's amend becomes a ratchet transaction** like the other
   three (one PR, one mutation).
3. **Review before deploy, not after.** Either agent's PR waits for the other
   agent's P1 pass (or the owner's) before the merge, as the standing policy's
   "CI green" is extended to "review posted". That turns the eight-PR chain
   into two.
4. **Stop the allowlist growing**: the one-account test refuses a NEW file in
   the `is_live` allowlist unless its entry carries a `routing:` note.
5. **Source-reading tests**: no new test may read source; the 176 existing
   ones are retired as their wiring gains an injection point.
6. **Shared sidecar copies**: a per-service log prefix (one line in each
   copy's `main.cpp` passing its name), and the scanners' slow-request
   threshold above `/comparisons`' steady write time, or the comparisons
   payload paged.
7. **Docs**: mark the 12 route references removed/never built, or move those
   docs to `docs/archive/`.
8. **verify_watchdog**: read the controller's own error text at the next
   failure against cpp-verify's `/watchdog-status` timing; the D1 change
   targeted exactly this and the controller still fails three in a row.

---

## 5. Invariants (P3)

| Invariant | Verdict |
|---|---|
| Production was not changed by this assessment | Passed (GET reads, log reads, git/GitHub reads only) |
| Every number is a measurement, not a recollection | Passed (commands and sources in §1; log reads saturated at 200 are named as lower bounds) |
| The gate on `main` is green at the assessed commit | Passed (B5, run here on a75878d) |
| The serial is ratcheted above both agents' visible stamps | Passed (№ 12,067 > Codex №12,066) |
| The re-anchor payload matches production | **Failed** (A7) |

---

Conversation ref: ordered after № 11,806 · reported № 12,067
Effort: max
Session: https://claude.ai/code/session_01C1hz86KuE5JKVq6W2KtUE2
