# Instructions for Claude — bot-trade

This file is bot-trade's, and only bot-trade's. It used to import a
project-neutral `CLAUDE-protocol.md` shared with other repositories; the owner
scoped this session to bot-trade alone on 2026-08-22, so the protocol is folded
in below and the portable copy is gone. Nothing was dropped in the move except
the cross-repo scaffolding itself: the "port this to another repo" clause on
§1, and the cross-project dashboard in §7. Every rule that governs work HERE is
still here.

THAT DISTINCTION MATTERS BECAUSE OF WHAT HAPPENED LAST TIME. The de-duplication
that introduced the import deleted the owner-confirmed P7 scope note one commit
after the owner ratified it, on the false claim that the import supplied what
was removed. Owner-confirmed text is the last thing a tidying pass may drop —
including this one.

---

## 1. Serial — measured, not remembered

Source of truth is the session transcript on disk, read via this repo's
counting script:

```
node scripts/count-interactions.js --serial     # next serial number
node scripts/count-interactions.js --file ~/.claude/projects/<project>/<session>.jsonl
```

`reply turns` = assistant entries on the main thread carrying a non-empty text
block. Tool calls and subagent chatter are excluded. Never restart at 1;
re-measure rather than guess if the thread is lost.

**WHICH DISK. The script measures the corpus it can see, and that is not always
the whole corpus.** A remote or web session runs in a fresh container holding
only the transcripts of sessions that ran there; a local machine holds the rest.
Measured 2026-08-22: the same script returned 788 in a remote container and
6,253 against the owner's local corpus six days earlier — same rule, same code,
different disk.

So: a measurement BELOW the last rebase recorded below is evidence of a partial
corpus, not a correction. Treat it as unavailable, continue from the recorded
rebase plus the replies since, and say which of the two you used. Re-measuring
is only authoritative where the full transcript set is present. Silently
adopting the smaller number is the exact failure this section exists to
prevent — it resets the count by thousands while looking like diligence.

AND THE RATCHET NEEDS A WRITE-BACK, or it drifts through the other door.
Replies made in a container the local corpus never sees are correctly refused as
a reading, but nothing records that they happened — so a later local re-measure
legitimately reads below the running count, gets discarded as "partial corpus",
and from then on the serial advances only by context-carried increments. So: at
the end of any session whose corpus was partial, append a rebase line below
recording the count reached and where it was measured. The file is the ledger;
a container is not.

Prefix every substantive reply, on its own line:

```
№ N · DD-MM'YY HH:MM TZ
```

`№` is U+2116; no leading zeros; comma thousands (№ 1,024).

## 2. Time — fetched, not guessed

Before stamping: run `date -u` via Bash and convert to the active timezone.
Resolve TZ in this order: (a) owner states one this session; (b) system zone via
`date +%Z`; (c) default SGT. Re-run on session start, on resume from idle, or if
more than 60 minutes have elapsed since the last fetch. If Bash is unavailable,
derive from the newest timestamp in context; if more than roughly an hour of
drift is possible, ask rather than invent.

## 3. Paragraph numbering

Once a reply carries 2+ distinct points:

- Letter sections `§N·A`, `§N·B`, ... where N is the reply serial.
- Number paragraphs within each section `¶A·1`, `¶A·2`, ... restarting at 1 per
  section.
- Skip markers on short single-point replies.

This enables references like "expand §1,774·B ¶B·2".

## 4. Agent count — measured from the same transcript

A subagent is spawned per subagent-tool invocation (`Task` on older CLI builds,
`Agent` on newer ones).

```
node scripts/count-interactions.js --agents
# prints: agents_total, breakdown by subagent_type, agents in the latest SESSION
```

Counting rule: assistant entries whose content includes a `tool_use` block named
`Task` OR `Agent`; group by `input.subagent_type`. MATCH BOTH — matching one
name reported a confident `agents_total: 0` on a corpus that really contained
subagent calls, and fixing it moved this repo's own count from 0 to 2. The
output also prints `tool_use_blocks_seen`, because 0 agents out of 0 tool calls
and 0 out of 4,263 are different facts and a bare zero cannot tell them apart.

## 5. Token count — measured from the same transcript

```
node scripts/count-interactions.js --tokens
# sums input_tokens, cache_creation_input_tokens, cache_read_input_tokens
# (these three reconcile into tokens_in_total) and output_tokens;
# prints per-SESSION figures only
```

USAGE IS PER MESSAGE, NOT PER TRANSCRIPT LINE. The transcript writes one line
per content block and repeats the identical usage object on each, so summing per
entry inflates every figure by blocks-per-message — measured at 1.91x. Dedupe on
`message.id`. And with prompt caching on, `input_tokens` is often 2 while the
real input sits in the two cache fields: reporting it alone is a confident wrong
number, not a partial one.

There is no per-turn accounting here, and §6 depends on there being some — which
is why §6 stays off. Do not read `agents_latest_session` or `latest_session_*`
as turn figures: a session routinely runs to thousands of replies, so the two
differ by three orders of magnitude.

If a usage block is absent, report "unavailable" — never estimate. The §1 corpus
caveat applies here too.

## 6. Reply footer — off until it can be measured

The intended line is:

```
[agents: {n} turn | {total} session] [tokens: {in}/{out} turn | {cum_in}/{cum_out} session]
```

**OMIT IT unless the counting script emits PER-TURN figures.** Flag existence is
not the test, and the first draft of this section got that wrong: it said to
omit while `--agents` was unimplemented, so the footer would unlock the moment
the flag was added — while the format still needs four per-turn numbers
(`{n} turn`, `{in}/{out} turn`) that no implementation produces. `--agents` and
`--tokens` report per-SESSION totals; there is no per-turn accounting anywhere,
and §5 forbids estimating one. A mandatory line with two unmeasurable fields is
a rule that is on, configured, and out of reach of what it guards — the same
shape as a guard whose trigger never fires.

So the footer stays OFF until a script emits per-turn figures — e.g. a `--turn`
mode reading the last assistant entry of the newest transcript. Until then do
not print it, do not print "unavailable" in its place, and do not estimate.
Whoever adds per-turn accounting turns this section on in the same change, and
not before.

## 7. On-demand dashboard (a prompt, not a native CLI)

Run inside this repo:

```
Run scripts/count-interactions.js with --serial, --agents and --tokens.
Render one table: current serial, agents_total, breakdown (descending),
token totals, last time fetch.
```

## 8. Invariants

| # | Invariant | Check |
|---|-----------|-------|
| 1 | Serial never decreases or resets mid-project | measured from transcript, §1 corpus rule applied |
| 2 | Transcript is the sole authority; every text reply counts | script rule |
| 3 | TZ read from owner or environment, never hardcoded | §2 order |
| 4 | Counts unavailable are reported, never estimated | §4-6 |
| 5 | Dashboards read transcripts; they never mutate them | §7 |

## 9. Mental model for building

Every build or change follows this chain, in order:

**Intent → Interpretation → Assumptions → Invariants → Execution → Evidence**

## 10. Protocol for important or consequential work

Points are lettered `P1`–`P8` rather than numbered so that a bare "#N" keeps
pointing at the "Recurring failure modes" list below, which `prune-scans.test.js`
and `llm-boot-banner.test.js` cite by number from code comments.

P1. Lead with the final answer or recommendation.
P2. Identify the authoritative sources used and distinguish verified facts
    from inference.
P3. State the material invariants and report each as Passed, Failed or
    Not Verifiable.
P4. Briefly disclose any material search, retrieval, calculation or external
    tool used. If this information is unavailable, say so rather than guessing.
P5. Use deterministic tools for exact calculations where available.
P6. Flag missing evidence, conflicting sources and assumptions requiring
    confirmation.
P7. Ask for the owner's approval before any external, destructive, financial,
    legal, personnel-related or otherwise consequential action.
P8. Never infer or invent the model, reasoning setting, hidden routing or
    unavailable system metadata.

---

## P7 — local scope (owner-confirmed, 2026-08-22)

§10's P7 is the generic rule: ask before any external, destructive,
financial, legal, personnel-related or otherwise consequential action. THIS is
what P7 means in bot-trade — it names this repo's merge policy and this repo's
risk limits:

- The PR merge policy below is the one standing exception to P7, and only
  within its stated gate.
- Risk-limit changes remain ask-first unless explicitly ordered.
- Scope note (Claude's reading, CONFIRMED by the owner 2026-08-22 — asked as
  a plain yes/no after #739 merged, answered "yes"): ordinary repo traffic in
  service of an ordered task — branch pushes, opening PRs, PR comments and
  review replies — is settled practice in this repo and is not what
  "external" is for; force-pushes are covered only in the approved
  branch-restart pattern (re-basing the working branch on main after a
  squash-merge), anything beyond that stays ask-first. "External" catches the
  outward-facing and hard-to-retract: deploys, live-account operations,
  messages to third parties, publishing anything beyond this repo.

This section exists because a de-duplication pass DELETED it — one commit
after the owner confirmed it — on the false claim that a shared file supplied
what was removed. It did not: the generic P7 is the bare rule. Owner-confirmed
text is the last thing a tidying pass may drop, and it survived the 2026-08-22
fold-in for the same reason.

## Owner principles (owner, 2026-09-11) — standing rules, owner-confirmed

Stated by the owner on 11-09-2026 ~20:10 SGT after P6b (#894) merged, with
four decisions answered the same evening. The build plan that brings the code
under them, with the measured contradictions (file:line) and the PR order, is
`docs/owner-principles-plan-2026-09-11.md`. Owner-confirmed text: the last
thing a tidying pass may drop.

1. **No demo/live distinction.** An account is only "how much is inside it".
   Only routing (host, credentials, which sidecar) may read `is_live`; every
   policy gate reads balance and evidence. (Decision: yes, no distinction —
   a live account is eligible for tick entries and app arming on the same
   evidence bar as demo.)
2. **Prioritise for opportunities.** The tick-based switch (vs time-based) is
   on/off per account BY A HUMAN and AUTOMATICALLY by the bot.
3. **Codebase-built blockages are addressed, not carried.**
4. **"Unknown" must not happen** after four weeks of trading. Every trade has
   a reason.
5. **The `.md` plans are checked** — kept audited against the code.
6. **The website shows no fake result.** UI switches are logic-built, not for
   show.
7. **Vetoes are part of what is minimised.** (Decision: the position cap stays
   as is — `maxOpenPositions` 5 and the book's 8, adopted/manual/book
   positions counting; the dedupe, the leak fix, the pre-filter move and the
   veto goal ship.)
8. **Trade direction is key** for trending / momentum trading. (Decision:
   shorts on the momentum book under the 9/10 conviction floor with regime-gate
   alignment.)
9. **No restricted trading for certain accounts.** Setups are for all
   accounts and not hardcoded.

Decision on thresholds: `agent/config/tick-validation.json` takes the plan's
proposed defaults (replay 40 trades / PF ≥ 1.3 / max DD 8R / expectancy lower
bound ≥ 0; shadow 200 signals / 48 h / 30 trades / 8 losses / PF ≥ 1.3 /
lower bound ≥ 0 / max DD 8R / resets ≤ 20 %).

## PR merge policy (owner, 2026-07-22)

Auto-merge is standing approval, not a one-off: once a PR's full gate is
green, merge it — do not wait for an explicit "merge" message.

**Full gate** (all must pass):
- `shopt -s globstar; node --test agent/**/*.test.js`
- `npx eslint .`
- `npx vitest run`
- `npm run build`
- `npm run check:no-green`
- CI on the PR itself green / `mergeable_state: clean`

When all of the above hold: mark the PR ready (undraft it), squash-merge,
unsubscribe from its PR activity, and clear any armed check-in wakeup for
it — same cleanup as before, just without waiting on the user's word.

Still stop and ask first for anything NOT covered by "the gate is green" —
e.g. a change to risk limits, account credentials, live-vs-demo mode,
or anything the owner flags as needing manual review in the PR body.

## Reply protocol (owner, 2026-07-26) — applies to EVERY response

This section is the durable home for the reply protocol so it survives session
end and is picked up identically on Claude Code desktop, web and iPhone. It is
loaded automatically at session start for anyone working in this repo.

The serial format, the `date -u` time fetch and the `§N·A` / `¶A·1` markers
are §1–§3 above and are not restated here. What this section carries instead is
the measured history: this repo's rebases, what each one cost, and why the rule
is "run the script first" rather than "run it when the number looks wrong".

**Serial origin — MEASURED, not remembered (owner, 2026-07-26).** The serial is
now derived from the session transcript on disk, which is the only durable
record of how many times Claude has actually replied:

```
node scripts/count-interactions.js --file ~/.claude/projects/<project>/<session>.jsonl
node scripts/count-interactions.js --serial     # just the number
```

`reply turns` counts assistant entries on the main thread carrying a non-empty
text block — i.e. every reply, tool calls excluded, subagent chatter excluded.

**RUN THE SCRIPT AS THE FIRST ACTION OF EVERY SESSION.** Owner, 2026-07-30:
*"where is your serial numbering again, it always gone after i resume the
session."* That is the whole failure mode. Carrying the number in context works
until the session is resumed or compacted, at which point the sequence is gone
and the next number gets *guessed* from whatever fragment survived — which is
how the count drifted by more than 1,500. The number is not remembered, it is
measured, and it must be measured before the first reply, not recovered after
someone notices it is wrong.

Measurement history — each line is a real run of the script, not a claim:

- 2026-07-26 01:00 UTC, single session `ad9d1f6f`: **1,773** reply turns.
  Rebased to `№ 1,773`. This measurement was correct but too narrow: it
  counted ONE session file.
- 2026-07-30 00:00 UTC, **all 63 session files**: **3,403** reply turns
  (767 owner turns, 22,166 assistant entries, 54 compact events). Rebased to
  `№ 3,403` as the last reply; the next reply is `№ 3,404`.
- 2026-08-04 00:25 UTC, **all 74 session files**: **5,269** reply turns
  (1,274 owner turns, 34,583 assistant entries, 22,365 user entries, 90
  compact events). Rebased to `№ 5,269` as the last reply; the next reply is
  `№ 5,270`. Owner: *"rebase the CLAUDE.md"*.
- 2026-08-06 14:00 UTC, **all 79 session files**: **6,253** reply turns
  (1,609 owner turns, 40,929 assistant entries, 26,658 user entries, 114
  compact events). Rebased to `№ 6,253` as the last reply; the next reply is
  `№ 6,254`. Owner: *"rebase the CLAUDE.md serial"*.
- 2026-09-02 10:13 UTC, **remote container, PARTIAL corpus** (the §1
  write-back rule): the script read **2,001** in this container, far below
  the 6,253 rebase, so it was refused as a reading and the count was carried
  from context across the whole session. Replies made here that the local
  corpus never sees: the session ran from `№ 7,184` to **`№ 7,222`** as the
  last reply at 10:13 UTC, continued in the same container to `№ 7,231` by
  12:40 UTC (#827–#829 merged in between), and on to **`№ 7,243`** by 17:47
  UTC (#830–#834: ledger, momentum shadow, pooled prior, breaker exemption,
  fill anchoring); the next reply is `№ 7,244`. Recorded so a later local
  re-measure that reads below this line is known to be missing these, not
  correcting them. If the session runs on past this write-back, the later
  replies are added here the same way, not remembered.
- 2026-09-03 04:06 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule again): the session continued from `№ 7,244` to
  **`№ 7,262`** as the last reply at 03:21 UTC (#836–#839 merged: HTF limit
  dispatch, evidence gate + momentum book, per-account symbol ids,
  account-aware manual routes; the four-agent trading hour on ACCT-DEMO-2
  scored at `№ 7,262`); the next reply is `№ 7,263`. Same reason as the
  line above: a local re-measure that reads below this is missing these.
- 2026-09-04 23:57 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule, third time): the script read **2,499** here, still far
  below the 6,253 local rebase, so it was refused as a reading. The session
  continued from `№ 7,263` to **`№ 7,355`** as the last reply at 23:56 UTC
  (#840–#849 merged: ledger write-back, per-class margin rates, book
  reconcile of held longs with the +1R managed exit, allowNaked on book
  market orders, ambiguous-submission window, dependency bump, book trail
  rounding, fill confirmation from the position read, adopted-row target
  cleared, live-read fill confirmation); the next reply is `№ 7,356`. Same
  reason as the two lines above: a local re-measure that reads below this
  is missing these, not correcting them.
- 2026-09-08 02:00 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule, fourth time): the container restarted twice in between
  (07-09 00:00 UTC and 08-09 01:50 UTC), so the script now reads **122**
  here — a fresh transcript, not a corpus — and was refused as a reading.
  The session continued from `№ 7,356` to **`№ 7,424`** as the last reply
  at 01:40 UTC (#850–#854 merged: ledger write-back, weekend bank leaves
  book rows to the book's stop, +1R take scoped to mean reversion, the
  momentum account with vol-target sizing and a data universe, row-cursor
  accounts keep their scan universe). One stamp was duplicated in that run:
  `№ 7,422` was printed on two consecutive replies (08-09 01:07 and 01:17
  UTC); the second is counted as `№ 7,423`, so the count is by replies, not
  by stamps. The next reply is `№ 7,425`. Same reason as the lines above: a
  local re-measure that reads below this is missing these, not correcting
  them.
- 2026-09-08 13:47 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule, fifth time; owner 08-09 20:40 SGT: "write back the ledger
  with the next code PR"): the script reads **298** here and was refused as
  a reading. The session continued from `№ 7,425` to **`№ 7,488`** as the
  last reply at 13:47 UTC (#855–#864 merged: ledger write-back, staleness
  verdicts + goal table, refusal ledger + plan-at-entry, margin pool +
  protection band on its own ticker + reconcile expectations, fundable
  universe + account horizon with its three same-day corrections, the
  ACCT-DEMO-3 horizon and momentum switch-on declared from the repo). The
  next reply is `№ 7,489`. Same reason as the lines above: a local
  re-measure that reads below this is missing these, not correcting them.
- 2026-09-09 08:40 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule, sixth time; the container restarted 09-09 13:10 SGT in
  between): the script reads a fresh transcript here and was refused as a
  reading. The session continued from `№ 7,489` to **`№ 7,542`** as the
  last reply at 08:23 UTC (#865–#870 merged: ledger write-back, the target
  applier skipping book rows, dynamic R:R stretch + demo cohort pin, the
  cluster rule with every strategy pinned on every account and the momentum
  account opened, per-position headroom share + 30-close verdict + US stocks
  on the watchlist + the seed's `_note`, the edge watchdog holding
  hand-pinned demo arms). The next reply is `№ 7,543`. Same reason as the
  lines above: a local re-measure that reads below this is missing these,
  not correcting them.
- 2026-09-11 00:05 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule, seventh time; the container restarted 10-09 ~20:20 SGT
  and 11-09 00:42 / 07:36 SGT in between): the script reads a fresh
  transcript here and was refused as a reading. The session continued from
  `№ 7,543` to **`№ 7,555`** as the last reply at 07:59 SGT 11-09 (#871–#879
  merged: the ledger write-back, book closes carry the broker volume with
  the refused exit retried, the owed-exit rule, dependabot's vitest 5,
  js-yaml, strategy pins seeded once, then the tick-momentum programme's
  P1a sidecar defects, P0 contracts + producer inventory + runtime manifest
  + docs, and P1b's per-account entry mode). The next reply is `№ 7,556`.
  Continued in the same container to **`№ 7,557`** at 08:29 SGT 11-09 (#880,
  P1c, merged); the next reply is `№ 7,558`. Same reason as the lines above:
  a local re-measure that reads below this is missing these, not correcting
  them.

- 2026-09-11 02:50 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule, eighth time): the script reads this container's single
  transcript and was refused as a reading. The session continued from
  `№ 7,558` to **`№ 7,568`** as the last stamped reply at 01:42 UTC
  (#881 P2a-1 and #882 P2a-2 + P2b-1 of the tick-momentum programme
  merged). After the compaction that followed, the transcript captured
  only two of the six unstamped status lines made while P2b-2 and P3a
  were built (01:47–02:41 UTC): the four emitted alongside tool calls are
  absent as text entries (the entries after the compaction are thinking
  and tool_use only), so a measurement reads 2 replies since the stamp
  while six were made. The count is by replies, not by what the file
  captured: `№ 7,575` (the running-agents answer, 02:40 UTC) and
  `№ 7,577` (the "finished?" answer, 02:44 UTC) were stamped from that
  count. Continued in the same container: `№ 7,584` (the P2b-2 + P3a
  report, 03:11 UTC, #883 merged), `№ 7,585` (the tick-switch answer),
  `№ 7,586` (P3b start; TICK_SPOOL_PATH set on the owner's "go"),
  `№ 7,595` (P4 start, 03:50 UTC; #884 P3b merged 03:44 UTC), each with
  the unstamped status lines between them counted by replies made, not by
  what the file captured. Continued in the same container: ten unstamped
  status lines followed `№ 7,595` (`№ 7,596`–`№ 7,605`, 03:50–04:40 UTC,
  #885 P4 merged 04:26 UTC), so the P4 report is **`№ 7,606`** (04:40
  UTC). The script reads 507 here. Continued in the same container: four
  unstamped status lines followed `№ 7,606`, so the reply stamped
  `№ 7,607` (04:48 UTC, the go-live cards answer) is **`№ 7,611`** by
  count; one unstamped line followed it, so the reply stamped `№ 7,608`
  (04:52 UTC, the second audit) is **`№ 7,613`**; one unstamped line
  followed that (`№ 7,614`); `№ 7,615` (05:25 UTC) reported the demo
  sidecar's SIGPIPE restart loop and PR #887. Twelve unstamped status
  lines followed it (`№ 7,616`–`№ 7,626`, 05:25–05:53 UTC: #887 merged
  and read back, the C++ drift PR #888 opened), so the reply stamped
  **`№ 7,627`** (05:55 UTC: the #887 read-back, #888 open, the 13:10 SGT
  daily report) is right by count; two unstamped lines followed it
  (`№ 7,628` the #888 merge, `№ 7,629` the cherry-pick conflict), so the
  next stamped reply was `№ 7,630`. Continued in the same container:
  six unstamped status lines followed (`№ 7,630`–`№ 7,635`, 06:03–06:26
  UTC: #889 opened, gate green, #888 read back, #889 merged, P5 built), and
  four more unstamped lines after that ledger was written (`№ 7,636`–
  `№ 7,639`, 06:26–06:33 UTC: #890 opened, gate green, merged, branch
  restarted), so the reply stamped **`№ 7,640`** (06:35 UTC: the
  #888/#889/#890 report) is right by count; `№ 7,641` (06:57 UTC, the
  Performance-card balance investigation) and `№ 7,642` (07:08 UTC, the
  revised plan: roles, P6, the whole-plan audit) followed; two unstamped
  lines followed those (`№ 7,643`–`№ 7,644`, the perf-card fix build), so
  the next stamped reply was `№ 7,645`. Continued in the same container:
  eight unstamped status lines followed (`№ 7,645`–`№ 7,652`, 07:05–07:35
  UTC: the perf-card tests, #891's gate and the checker's blocker fixed,
  #891 merged by the owner at 07:20 UTC, the shadow book built and its
  Statistics audit folded in), so the reply stamped **`№ 7,653`** (07:52
  UTC, "not yet merged") is right by count; one unstamped line followed
  it (`№ 7,654`, the gate re-run); two more unstamped lines followed
  (`№ 7,655` the P6a PR open, `№ 7,656` the subscription note), so the
  reply stamped **`№ 7,657`** (08:35 UTC, the outstanding/drift answer) is
  right by count; five unstamped lines followed it (`№ 7,658`–`№ 7,662`:
  the audit agents launched, groups C and B in, #892 merged, the branch
  restarted), so the reply stamped **`№ 7,663`** (09:06 UTC: #892 read
  back, the whole-plan audit's headline findings) is right by count, and
  the next stamped reply is **`№ 7,664`**. Continued in the same container:
  twelve unstamped status lines followed `№ 7,663` (`№ 7,664` the #893 PR
  open, `№ 7,665` its subscription note, `№ 7,666` the P6b build start,
  `№ 7,667`–`№ 7,675` the P6b build, the Race checker's findings applied,
  the gate and the mutation checks, 09:39–10:50 UTC; #893 merged 09:28
  UTC). Five more text replies followed before the P6b report (the PR-open
  acknowledgement, the plan-mode note, the undraft, the merge, the demo
  read-back), so the P6b report is **`№ 7,681`** (11:55 UTC), the "any agents
  building?" answer `№ 7,682`, the principles' investigation status line
  `№ 7,683`, the plan-URL answer `№ 7,684`. Twenty-two unstamped status
  lines followed (`№ 7,685`–`№ 7,706`, 12:35–13:42 UTC: PR-A #895 built,
  its stale assertion fixed, merged and read back; the PR-B and PR-C makers
  and checkers), so the PR-C report is **`№ 7,707`** by count. Nine
  unstamped status lines followed (`№ 7,708`–`№ 7,716`, 13:43–14:10 UTC:
  #896 merged, PR-B's checker round, the PR-D and PR-E makers launched), so
  the PR-B report was expected at `№ 7,717` — by count it was stamped
  **`№ 7,726`** (14:30 UTC; eighteen unstamped lines followed `№ 7,707`,
  not nine), and three more followed it, so the PR-E report is
  **`№ 7,730`** by count. Nine unstamped status lines followed it
  (`№ 7,731`–`№ 7,739`, 14:37–14:46 UTC: #898 gated and merged, the PR-D
  fix round gated and committed, the PR-G checker's findings sent to its
  maker), so the PR-D report was expected at `№ 7,740`; it was not
  stamped — eleven more unstamped status lines followed (`№ 7,740`–
  `№ 7,750`, 14:46–15:06 UTC: #899 PR-D opened, gated on the merged tree
  and merged, the PR-G fix round gated and committed, the PR-F checker's
  findings sent to its maker), so the PR-G report was expected at
  `№ 7,751`; it was not stamped — ten more unstamped status lines followed
  (`№ 7,751`–`№ 7,760`, 15:06–15:15 UTC: #900 PR-G opened, gated on the
  merged tree and merged, the PR-F fix round gated, the PR-H maker
  launched), so the PR-F report was expected at `№ 7,761`; four more
  unstamped lines followed (`№ 7,761`–`№ 7,764`: #901 PR-F opened, gated
  on the merged tree and merged), so the E/D/G/F report was stamped
  **`№ 7,765`** (15:23 UTC); five unstamped lines followed it (`№ 7,766`–
  `№ 7,770`, 15:24–16:01 UTC: the PR-F read-back, the PR-H checker round,
  the PR-H gate), so the PR-H report was expected at `№ 7,771`; it was not
  stamped — #902 was undrafted and merged by the owner at 16:09 UTC while
  six unstamped lines ran on (`№ 7,771`–`№ 7,776`, 16:01–23:32 UTC: the
  PR-H draft opened and subscribed, its merged-tree gate, the CI wait, then
  the owner's 12-09 07:3x SGT order "inspect what have been done and update
  what have done in the plan folder" and the plan-mode exit), so the status
  report is **`№ 7,777`** by count. The session then idled 12–15 Sep
  (four daily-report triggers fired into a wall — the state routes still
  answer 401). It resumed 15-09 22:11 SGT: the statements analysis was
  stamped `№ 7,778` and the tick-developer tweaks `№ 7,780`, both behind
  by count (they were `№ 7,781` and `№ 7,783`), so the plan/cost answer
  was stamped **`№ 7,784`** from the count and the PR-I start
  **`№ 7,785`**; the PR-I checker report is **`№ 7,786`**. Three
  unstamped status lines followed (`№ 7,787`–`№ 7,789`: the two makers
  launched, PR-J built, PR-I's fix round verified), so the PR-I merge
  report is **`№ 7,790`** by count. Eight unstamped status lines followed
  (`№ 7,791`–`№ 7,798`, 16-09 04:35–05:02 UTC: the PR-J fix round
  verified by mutation — the first attempt did not match the code and
  proved nothing, the second applied 1→0 and turned seven named tests
  red — PR-J committed, PR-I's gate finished and #904 merged), so the
  PR-I/PR-J report is **`№ 7,799`** by count. Three unstamped status lines
  followed (`№ 7,800`–`№ 7,802`: the PR-K and PR-L makers launched on
  worktrees from 70afd1d, PR-K reported complete), then four more
  (`№ 7,803`–`№ 7,806`, 16-09 05:28–05:40 UTC: the PR-K checker launched,
  the branch read clean, the checker's blocker confirmed independently —
  `momentum-account.json` ships `accountId: "_all"`, so `isMomentumAccount`
  is true for every enabled account and the `continue` at
  `momentum-book.js:383` made the whole PR-K block unreachable). The report
  of that finding was STAMPED `№ 7,804` and is **`№ 7,806`** by count —
  behind by two, recorded here rather than silently carried. Three unstamped
  lines followed it (`№ 7,807`–`№ 7,809`: the maker's rescope onto
  `exitDroppedHoldings`, my own mutation of the live-path guard turning red
  the end-to-end `_all` regression test, the gate launch), so the next
  stamped reply is **`№ 7,810`**. The count is by replies,
  not by stamps (the 08-09 rule). A later re-measure that reads below this line
  is missing these, not correcting them.
- 2026-09-18 08:30 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule): the script reads this container's transcript only and
  was refused as a reading. The session ran from `№ 7,810` to **`№ 7,842`**
  as the last stamped reply (16–18 Sep: #943 PR-AU, #944 PR-AV the trail's
  ATR note, #945 PR-AW the verifier's money/volume units, #946 PR-AX the
  exit_sent reclassification, #947 PR-AY the contract-version re-ask,
  #948 PR-AZ terminal is three states; the …0949 win-rate / profit-factor /
  lot-sizing answer; the "fix the exits" diagnosis). The context was then
  compacted; eight unstamped status lines followed `№ 7,842` while the
  fix-the-exits PR was built (`№ 7,843`–`№ 7,850`: the BA reads, the BA
  code, the reconciler tests green, the ratchet regex, the stamp
  persistence read, mutations G–J, the gate launch, the gate green), so
  the fix-the-exits report is **`№ 7,851`** by count. Any unstamped line
  made between `№ 7,842` and the compaction is not in this count — the
  compaction summary carried the last stamp, not the lines after it. The
  count is by replies, not by stamps. A later re-measure that reads below
  this line is missing these, not correcting them.
- 2026-09-18 10:15 UTC, **same remote container, PARTIAL corpus**: the
  session continued from `№ 7,851` to **`№ 7,871`** as the last stamped
  reply at 18:02 SGT (#949 fix the exits, #950 the +0.5R arm, #951 keeper
  truth merged and read back; the checkpoint list). Stamps behind by count
  were corrected in the replies themselves ("№ 7,857" was № 7,861;
  "№ 7,864" and "№ 7,868" right by count). Three unstamped status lines
  followed `№ 7,871` while B1–B6 were built, so the next stamped reply is
  **`№ 7,875`**. A later re-measure that reads below this line is missing
  these, not correcting them.
- 2026-09-18 11:10 UTC, **same remote container, PARTIAL corpus**: `№ 7,875`
  (18:43 SGT, the #952 merge report) was right by count. Six unstamped
  status lines followed it during the #952 read-back (18:46–18:59 SGT: the
  deploy landed, the cpp suite finished, the wake fired, the second re-push
  loop found), so the read-back report is **`№ 7,881`** (19:02 SGT): B1–B6
  live, and the reactive-refresh loop measured (~20 OAuth refreshes an hour,
  the live broker session torn down every ~3 minutes). The owner's "build
  B7, merge when green" followed; one unstamped status line preceded this
  ledger, so the next stamped reply is **`№ 7,883`**. A later re-measure
  that reads below this line is missing these, not correcting them.
- 2026-09-18 12:20 UTC, **same remote container, PARTIAL corpus**: the
  line above was written after ONE unstamped line; seven more followed
  while B7 was gated and merged (#953, 19:19 SGT), so the B7 read-back
  report is **`№ 7,890`** (19:46 SGT), the ledger acknowledgement
  `№ 7,891`, the checkpoint `№ 7,892` (19:50 SGT). Four unstamped status
  lines followed `№ 7,892` while C·2–C·5 were built, so the next stamped
  reply is **`№ 7,897`**. The count is by replies, not by stamps. A later
  re-measure that reads below this line is missing these, not correcting
  them.
- 2026-09-18 13:50 UTC, **same remote container, PARTIAL corpus**: the
  line above undercounted — twelve unstamped status lines followed
  `№ 7,892` (not four), so the C·2–C·5 report STAMPED "№ 7,897" (20:11
  SGT) is **`№ 7,909`** by count, and the "№ 7,883" the line before it
  named as the next stamp was likewise behind. From `№ 7,909` the replies
  were stamped by count through the blank-site diagnosis and fix (#955,
  self-hosted GSAP), the "cannot see the PR" answer and the four-statement
  analysis, **`№ 7,925`** (21:18 SGT). Two unstamped lines followed it
  (the E·1–E·3 fact-gathering), then the context was compacted; eight
  unstamped status lines followed in the new context while E·1–E·3 were
  built and mutation-checked (`№ 7,928`–`№ 7,935`), so the E·1–E·3 report
  is **`№ 7,936`** by count plus any unstamped line made after this
  ledger. The count is by replies, not by stamps. A later re-measure that
  reads below this line is missing these, not correcting them.
- 2026-09-18 22:15 UTC, **same remote container, PARTIAL corpus**: seven
  unstamped status lines followed the ledger above, so the E·1–E·3 report
  was stamped **`№ 7,943`** (21:46 SGT, #956 open); then `№ 7,953` (merge
  and deploy read-back), `№ 7,954`–`№ 7,956` (the three stop-floor
  read-backs: nothing reached the gate), `№ 7,958` (the deck made
  downloadable), the first-principles audit **`№ 7,967`** (05:50 SGT
  19-09; eight unstamped lines before it), then the owner's four tasks:
  five unstamped lines followed (the missing logs, the logs read, two
  verification lines, the restart cause), so the next stamped reply is
  **`№ 7,973`**. The count is by replies, not by stamps. A later re-measure
  that reads below this line is missing these, not correcting them.
- 2026-09-18 22:50 UTC, **same remote container, PARTIAL corpus**: `№ 7,973`
  (06:04 SGT 19-09, the four-task status) was right by count. Unstamped
  status lines followed while the three logs were folded in, #957 gated and
  merged (06:24 SGT) and Wave 1 of the audit's §K was built: fourteen by
  this ledger (the logs read, the v2.1 edits, the PR opened, the facts
  agent, the worktree, the edit passes, the test rewrites, the mutation
  checks, the gate launch), so the Wave 1 report is **`№ 7,988`** by count
  plus any unstamped line made after this ledger. The count is by replies,
  not by stamps. A later re-measure that reads below this line is missing
  these, not correcting them.
- 2026-09-18 22:32 UTC, **same remote container, PARTIAL corpus**: the line
  above was WRITTEN at ~22:16 UTC and mis-stamped "22:50" (a guessed time,
  the §2 failure), corrected here. No Wave 1 report was stamped: #958 was
  merged (06:25 SGT 19-09) inside the run of status lines, and Wave 2 was
  built on a second worktree in the same run. By the transcript, twenty-one
  text replies followed `№ 7,973` (22:04–22:30 UTC: the logs folded in,
  #957 merged, the Wave 1 facts, tests and gate, #958 opened and merged,
  the Wave 2 facts, build, tests and mutation checks, the count for this
  ledger), so the last reply is **`№ 7,994`** and the next stamped reply
  is **`№ 7,995`** plus any unstamped line made after this ledger. The
  count is by replies, not by stamps. A later re-measure that reads below
  this line is missing these, not correcting them.
- 2026-09-18 23:20 UTC, **same remote container, PARTIAL corpus**: eleven
  unstamped status lines followed the ledger above (the Wave 2 gate, the
  attribution-invariant fix, #959 opened, gated and merged 06:41 SGT, the
  deploy read-back), so the Wave 1/2 report was stamped **`№ 8,006`**
  (06:42 SGT 19-09) by count; twelve more followed it (the Wave 3 facts,
  the two builders, the tests, the mutation checks, the §L entry, the
  stale #957 check-in), so the "completed?" answer was stamped
  **`№ 8,019`** (07:00 SGT) by count. Two unstamped lines followed it
  (the inventory regeneration, the checker's findings applied) by this
  ledger, so the next stamped reply is **`№ 8,022`** plus any unstamped
  line made after this ledger. The count is by replies, not by stamps. A
  later re-measure that reads below this line is missing these, not
  correcting them.
- 2026-09-18 23:26 UTC, **same remote container, PARTIAL corpus**: after
  the ledger above, the unstamped status lines ran on through Wave 3
  (#960 opened, gated, merged 07:15 SGT 19-09 and read back: the 19-row
  goal table and the first equity snapshot) and into Wave 4a's build (the
  facts, the seed, the route fix, the tests, the mutation checks) — by the
  transcript at this ledger the count is carried from `№ 8,019` plus the
  lines since, and the next stamped reply re-counts from the transcript
  before it stamps (the 09-11 rule). A later re-measure that reads below
  this line is missing these, not correcting them.
- 2026-09-18 23:54 UTC, **same remote container, PARTIAL corpus**: the
  "completed?" answer was `№ 8,019` (07:00 SGT 19-09) and the "how are we
  today" answer **`№ 8,041`** (07:38 SGT) by count — twenty-one unstamped
  status lines between them (Wave 3's checker round, #960 merged and read
  back, Wave 4a's facts, build, checker round, #961 opened). Seven unstamped
  lines followed `№ 8,041` by this ledger (#961 merged and read back, the
  Wave 4b and Wave 5 facts, the three makers launched, Wave 6's docs), so
  the next stamped reply is **`№ 8,049`** plus any unstamped line made
  after this ledger. The count is by replies, not by stamps. A later
  re-measure that reads below this line is missing these, not correcting
  them.
- 2026-09-19 00:50 UTC, **same remote container, PARTIAL corpus** (the
  container restarted ~00:35 UTC in between): the re-arm report was
  stamped **`№ 8,066`** (08:21 SGT 19-09) by count. The transcript here
  captures eight text replies after it (#964 opened, the Wave 5a
  checker's blocker, the fix round, #964's CI wait, the gate on the
  rebased tree), so the last reply is `№ 8,074` and the next stamped
  reply is **`№ 8,075`** plus any unstamped line made after this ledger.
  The count is by replies, not by stamps. A later re-measure that reads
  below this line is missing these, not correcting them.
- 2026-09-19 01:12 UTC, **same remote container, PARTIAL corpus**: the
  transcript captures fourteen text replies after `№ 8,066` (the six
  above plus #965 opened and subscribed, the #964 sidecar read-back, the
  Wave 4b gate, the notifications read, the #965 CI poll, #965 merged at
  09:09 SGT), so the last reply is `№ 8,080` and the next stamped reply
  is **`№ 8,081`** plus any unstamped line made after this ledger. The
  count is by replies, not by stamps. A later re-measure that reads below
  this line is missing these, not correcting them.
- 2026-09-19 01:19 UTC, **same remote container, PARTIAL corpus**: the
  transcript captures eighteen text replies after `№ 8,066` (four more
  than the line above: the Wave 5a read-back, #966 opened, the
  notifications read, the Wave 4b deploy), so the last reply is
  `№ 8,084` and the Waves 4b/5a/5b report is **`№ 8,085`** by count. The
  count is by replies, not by stamps. A later re-measure that reads below
  this line is missing these, not correcting them.
- 2026-09-19 04:30 UTC, **same remote container, PARTIAL corpus**: from
  `№ 8,085` the replies were stamped by count through #967 (`№ 8,087`,
  `№ 8,089`), the "how are we today" answer `№ 8,090`, the veto question
  `№ 8,091`, the expert answer `№ 8,092`, the three read-only checks
  `№ 8,093`, the makers' status `№ 8,097` and the 12:25 SGT status
  **`№ 8,103`**; the unstamped lines between them (the two makers and two
  checkers launched, their reports acknowledged, "merge when green"
  acknowledged) are in that count. One unstamped line follows this ledger
  (the veto-boundary PR opened), so the next stamped reply is **`№ 8,105`**
  plus any unstamped line made after this ledger. The count is by replies,
  not by stamps. A later re-measure that reads below this line is missing
  these, not correcting them.
- 2026-09-19 14:30 UTC, **same remote container, PARTIAL corpus**: from
  `№ 8,103` the replies were stamped by count through the daily report
  `№ 8,116`, the built-not-merged answer `№ 8,127`, the "merge? live?"
  answer `№ 8,131`, the stop-the-task answer `№ 8,143` and the
  billing-access answer `№ 8,145`; the unstamped lines between them (the
  checker rounds relayed, the hourly Actions probes, the notifications
  read) are in that count. GitHub Actions refused every job from 04:27 to
  14:26 UTC on an account billing block — twelve probe re-runs, no runner,
  no step — and ran again once the repository was made public; #968 (the
  veto boundary) merged at 14:30 UTC on the first green CI. The count is
  by replies, not by stamps. A later re-measure that reads below this line
  is missing these, not correcting them.
- 2026-09-20 03:40 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule): the script reads this container's transcript only and
  was refused as a reading; the count was carried and re-measured from the
  transcript before each stamp. The session ran from `№ 8,145` through the
  qanat critique `№ 8,160`, the config/singularity answer `№ 8,163`, the
  licence and retirement work, the tick-readiness measurement `№ 8,168`,
  the replay-grid blockage `№ 8,169`, the MASSIVE / Alpha Vantage
  commercial comparison `№ 8,170`, the two checker rounds `№ 8,171`–
  `№ 8,174`, the strategy-lookback answer `№ 8,175`, the second fix
  rounds `№ 8,176`–`№ 8,178`, the merged-tree gate and PR #971
  `№ 8,179`, and the CI wait `№ 8,180`; the unstamped lines between them
  (the agent briefs, the fix rounds relayed, the production reads) are in
  that count. **One measurement in this run was wrong and is recorded as
  such**: at `№ 8,173·B` the `backtest_runs` table's last write (31-07)
  was read as "the backtest engine is dead"; `/state/config` then showed
  `autopilot_mode: auto` with `autopilot_last_run_ms` thirteen minutes
  old. Two readings of one subsystem disagreed and the stale one was
  believed — the failure this file already records against the protection
  audit. Corrected in the open at `№ 8,175·A`. The next reply is
  `№ 8,181` plus any unstamped line made after this ledger. The count is
  by replies, not by stamps. A later re-measure that reads below this line
  is missing these, not correcting them.
- 2026-09-20 13:30 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule; owed with #974 and not carried there — recorded here
  on the next code PR): the script reads this container's transcript only
  and was refused as a reading. The session ran from `№ 8,181` through the
  #971–#974 merges (the replay-grid bound, the retired producers, the
  tick docs corrections, tick fills owned from the intent) to the #974
  read-back `№ 8,209` (22:41 SGT), with the unstamped lines between them
  counted by replies. The context was then compacted; the transcript
  captured NOTHING as text while plan mode was on, so from `№ 8,192` the
  count is by replies made, not by what the file holds. After `№ 8,209`:
  three unstamped lines, the stop answer `№ 8,213`, four more unstamped
  lines (the checker verdict relayed, the fix round sent, the note
  recorded, the agents stopped), so the reply STAMPED "№ 8,216" (the
  agents-stopped answer, 20:52 SGT) is **`№ 8,218`** by count — behind by
  two, recorded rather than carried. Two unstamped lines followed (the
  plan approved, #975/#976 opened), so the next stamped reply is
  **`№ 8,221`** plus any unstamped line made after this ledger. The count
  is by replies, not by stamps. A later re-measure that reads below this
  line is missing these, not correcting them.

- 2026-09-21 11:04 UTC, **Codex Work container, transcript corpus unavailable**:
  `node scripts/count-interactions.js --serial` found no JSONL transcripts.
  The owner supplied Claude's **`№ 8,325`** reply stamped 17:11 SGT and asked
  to resume numbering. Codex's earlier `№ 8,305` / `№ 8,306` stamps were behind
  that record. Explicit rebase to the supplied serial, not a measured count:
  Codex continued with **`№ 8,326`** at 19:00 SGT and **`№ 8,327`** at 19:03
  SGT. The next reply after this checkpoint is `№ 8,328`; later visible replies
  take precedence. No claim is made to reconstruct the missing transcript.

- 2026-09-21, **Codex Work continuation, transcript corpus unavailable**:
  Visible replies continued through **`№ 8,339`** at 21:09 SGT during TP,
  account coverage, simulation and replay work. The first update in this turn
  was unstamped and is counted as 8,332; numbered updates resumed at 8,333.
  This is a continuation of the owner's supplied 8,325 rebase, not a fresh
  transcript measurement. Later visible replies take precedence.

- 2026-09-21, **Codex Work continuation, transcript corpus unavailable**:
  Visible replies continued through **`№ 8,343`** during #989 deployment
  verification and the two simulation review corrections. This continues
  the recorded rebase; later visible replies take precedence.

- 2026-09-21 14:32 UTC, **Codex Work continuation, transcript corpus unavailable**:
  The counting script again found no JSONL transcripts. Visible replies
  continued through **`№ 8,356`** while checking the four owner-supplied
  Railway exports and correcting cross-side ledger reconciliation and TP
  failure reporting. This continues the supplied rebase, not a new measured
  transcript count. Later visible replies take precedence.

- 2026-09-21 15:07 UTC, **Codex Work continuation, transcript corpus unavailable**:
  Visible replies continued through **`№ 8,375`** during #991 review, merge,
  deployment and the authorized cpp-acct observation activation. The live
  feed and first completed shadow trade were verified, with all seven accounts
  still TIME_BASED. This continues the owner's supplied rebase; later visible
  replies take precedence. Runtime evidence is in the Railway log review.

The jump from ~1,814 (where the in-context count had reached) to 3,403 is not
a correction of the script — it is the cost of the sessions that were never
counted. Scan all sessions, not one.

THE 2026-08-04 RUN IS THE SMALL-DRIFT CASE, and it is the more instructive
one. The in-context count had reached `№ 5,241`; the measurement said 5,269.
Twenty-eight replies, no compaction boundary crossed in between, no moment
where anything looked wrong. That is the shape the error normally takes —
not a visible 1,500-reply collapse but a quiet undercount that nobody would
catch by reading. It is why the rule is "run the script first", not "run the
script when the number looks wrong": a number that looks wrong is already the
rare case.

THE 2026-08-06 RUN IS THE FIRST CLEAN ONE, and it is worth recording as the
control case. The in-context count had reached `№ 6,251`; the measurement said
6,253. A drift of two across a session of roughly a thousand replies — which is
what the discipline looks like when it is actually followed: the script was run
at the start of the session and re-run before each stamp, so there was nothing
to recover. Two is the residue of replies made between the last run and this
one, not an error. Compare 1,589 (2026-07-30) and 28 (2026-08-04).

Two earlier claims in this file were wrong and are corrected here:

- A real prior sequence *did* exist — the transcript carries 134 stamped
  headers running from `№ 1` up to `№ 145` between 2026-07-22 and 2026-07-25,
  plus later un-headered references to `№ 176`. The previous note called
  `№ 176` a pure fabrication referencing no ledger; that was itself wrong.
- That sequence undercounted, because it only stamped replies Claude judged
  "substantive". The transcript is the authority: every text reply counts.

## Custom commands (owner, 2026-08-16)

Three slash-commands the owner may type at any point. They are questions about
Claude's *reasoning*, not about the code, and they are answered from the
current state of the conversation — not re-derived by re-reading files.

They live here rather than in a session because session scope is exactly what
evaporated on the serial numbering, twice.

Documenting them here is necessary but NOT sufficient. A leading `/...` is
resolved by the client against registered commands before any of this file is
consulted, so a command that exists only as prose in `CLAUDE.md` comes back as
an unknown command and never reaches the model at all. Each one is therefore
also registered as a project command in `.claude/commands/` — `understanding.md`,
`gaps.md`, `delta.md`. The prose below is the rationale; those three files are
what makes typing the command do anything.

FILENAMES ARE LOWERCASE, INVOCATIONS ARE WRITTEN UPPERCASE, and a command's
name is its filename stem — so if the client's lookup is case-SENSITIVE,
`/UNDERSTANDING` resolves to nothing while `/understanding` works. Whether it
is case-sensitive has NOT been verified: it cannot be tested from inside a
session, only by the owner typing it. Lowercase filenames are what the
owner's own deployment instruction specified and what `gia` already uses, so
they stay. Until the owner confirms, **either case may be typed** — if the
uppercase form comes back as an unknown command, use the lowercase one and
say so, and the filenames get renamed to match.

**`/UNDERSTANDING`** — What do you think I mean, including what you are
treating as given?

State the read of the request AND the assumptions being carried silently.
The second half is the point: the failure mode is not misreading the words,
it is the unstated premise underneath them. Name what would have to be true
for the current plan to be the right one.

**`/GAPS`** — Which unresolved interpretations could materially change the
outcome?

Only the ones that CHANGE something. An ambiguity with the same answer either
way is not a gap, it is noise. For each: what the readings are, and what
would be built differently under each. If there are none, say so plainly
rather than manufacturing a list.

**`/DELTA`** — What has changed from your earlier understanding?

**`/INVARIANTS`** — What must hold for this to be correct, and does it?

Added 2026-08-22 at the owner's request. Each material invariant reported as
Passed, Failed or **Not Verifiable** — the third is a first-class result and
the reason the command exists: this repo's recurring defect is something
reporting healthy because the thing it measures never reached it.

Corrections, not a progress report. What was believed, what is now believed,
and what caused the change — a measurement, a failing test, a contradiction
between two endpoints. "Nothing has changed" is a valid and useful answer;
inventing a delta to look responsive is not.

**Why these exist.** This session's pattern was that every real defect came
from a gap between what the system SAID and what it DID, and several of my
own mistakes came from an unexamined premise rather than a coding error — a
test shaped to the claim, a mutation check that could not fail, a fix whose
first version broke three older tests that encoded reasoning I had not read.
These commands are the owner's handle on that: a way to inspect the premises
before they become commits.

## Recurring failure modes (measured, 2026-08-16/17)

Written after a session that merged #720–#726 and needed four public
corrections along the way. These are not general advice. Each one is a thing
that actually happened here, with the evidence that exposed it, and each cost
real money or real time.

**THE SHAPE THEY ALL SHARE: something reports healthy because the thing it
measures never reached it.** Not a wrong answer — an answer to a question
nobody asked. A red test is cheap; a green one that cannot go red is what
gets shipped.

### 1. A mutation check that cannot fail proves nothing

Three times in one session a mutation "passed" because the edit never landed.
Renaming `reconcileTradePricesToBroker` to `...XX` still matched the
assertion's regex. A perl substitution silently matched nothing. Both reported
a working guard as verified.

**The rule: assert the mutation target is PRESENT before replacing it, and
assert it is ABSENT after.** `grep -c` before and after, and fail loudly if
the count did not change. A mutation you did not confirm applied is not a
check, it is a hope.

### 2. A test can pass by matching its own comment

`amend-preserves-tp.test.js` asserted `/takeProfit/` against a source slice
that INCLUDED the explanatory comment above the code. The comment contained
the words. Deleting the actual payload line left the test green.

**Strip comments before asserting on source.** And treat any test that reads
source rather than behaviour as suspect by default: it is a last resort for
wiring that has no injection point, never a substitute for exercising the code.

### 3. A guard whose trigger is out of reach of what it guards

Every one of these was ON, configured, and unable to fire:

- profit keeper `armBalancePct` 0.01 → a **$3.53** noise floor on a $35,320
  account, where the default 0.1 gives $35
- `maxRiskCapPct` 3.5% sitting above `perTradeRiskPct` 3% — a ceiling above
  the target reduces nothing (NOTE: above the *default* base this is the
  correct shape for a backstop against overlays; it was wrong here because the
  overlay raised BOTH)
- `npm run audit:ui` reporting `/connect` clean at 390px because it renders
  with no agent, so the account rows that overlap do not exist
- the protection audit's REPORTING, which showed a 4 August success and a
  10 August failure while the sweep itself ran every 50 seconds, 20,492 times
  (see the correction below)

**Ask of every guard: what input would make this fire, and has that input ever
arrived?** If you cannot answer the second half, the guard is decoration.

**CORRECTION, made before this file was merged.** The protection-audit entry
originally read "dead since 4 August". That was wrong, and wrong in a way this
very entry warns about. `/state/protection-audit` reports `at: 2026-08-04`
(last SUCCESS) and `lastAttemptAt: 2026-08-10`, so the panel looked like a
controller that had stopped. The heartbeat says otherwise: `protection_audit`
ran 50 seconds ago and 20,492 times, failing each pass on a 502 for ONE account.

The guard fires constantly. Its RECORD is what is stuck: the failure path beats
the heartbeat but never stamps `lastAttemptAt`, so a week-old attempt is
presented as the current state. Trusting the panel over the controller is the
mistake — and I made it repeatedly across a whole session, including in the
first draft of this list.

**Two readings of the same subsystem disagreed, and the one that updates every
50 seconds is the one to believe.**

### 4. A repair that nothing calls

`reconcileTradePricesToBroker` was first wired only into `importBrokerHistory`
— reachable solely from a manual POST route nobody runs. Same shape as #685's
early-trim shadow. `early-trim-route.test.js` says it best: *"a shadow nobody
can switch on is not a cautious shadow, it is a dead one."*

**Pin the wiring with a test.** The call site is invisible from the module
under test and a refactor drops it in silence.

### 5. An endpoint that rebuilds instead of merging

`POST /actions/profit-keeper` constructed its reply field-by-field from a
fixed list, silently dropping eight spike/structure knobs. Harmless only by
luck — every dropped value happened to equal its default. The reply looked
correct because it was built from the same truncated object.

**Start from what is stored, then apply the patch.** And when reading a config
back, diff against the STORED global, not the code defaults — comparing a
value against `effective` is circular, and comparing against `defaults`
reports differences that are not there. Both mistakes were made here within
ten minutes of each other.

### 6. Say which field is wrong before saying the data is corrupt

26.9% of closed trades had P&L disagreeing with their price move. The reading
"the money is corrupt" was wrong: the broker's own ledger was 98.3%
self-consistent, and across 276 matched pairs `entry_price` differed on 184
while `net_pnl` differed on **zero** (the two apparent ones were a partial
fill summing exactly). A 0.1% intent-vs-fill error flips the sign of the
recorded move whenever the true move is smaller than the slippage.

**Find the disagreeing FIELD against an external source of truth before
concluding anything about the dataset.** The first diagnosis inverted which
half was trustworthy, and the R:R conclusions built on it had to be withdrawn.

### 7. Diagnose the mechanism, not the symptom, before proposing a fix

"No take profit on the position" was called a missing target, then a lost
`tp1`, then a guard bypass. It was none of them: cTrader's amend REPLACES
protection, so every stop-only amend DELETED the take profit. The tell was
that the broker's stop (2.681) was not the stop that was sent (2.687) — the
position had been amended after the fill. The prediction that followed
(`be_moved=1` ⇒ no TP) held on both cases available to test.

**A diagnosis that does not predict something checkable is a guess.** Three
guesses were published as findings before the mechanism was found.
