# Instructions for Claude — bot-trade

@CLAUDE-protocol.md

The line above imports the project-neutral reply protocol (serial, time,
paragraph numbering, agent/token counts, the mental model, the custom
commands, and protocol points P1–P8). It is the same file in every repo;
everything below is bot-trade-specific and does not exist in the neutral
copy. Where this file and the protocol touch the same subject, the local
text is the one carrying the measured history and wins on specifics — see
"P7 — local scope" below, and note that §10 of the protocol only NAMES the
three commands; the rationale for why prose alone is insufficient is local.

## P7 — local scope (owner-confirmed, 2026-08-22)

The imported protocol's P7 is the generic rule: ask before any external,
destructive, financial, legal, personnel-related or otherwise consequential
action. THIS is what P7 means in bot-trade, and it does not live in the
neutral file because it names this repo's merge policy and this repo's risk
limits:

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

This section exists because the de-duplication that introduced the import
DELETED it — one commit after the owner confirmed it — on the false claim
that the import supplied what was removed. It did not: the neutral P7 is the
bare rule. Owner-confirmed text is the last thing a tidying pass may drop.

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
now live in `CLAUDE-protocol.md` (§1–§3), imported at the top of this file.
They are identical across repos, so they are not restated here. What is
bot-trade-specific — and what the protocol deliberately does NOT carry — is
the measured history below: this repo's rebases, what each one cost, and why
the rule is "run the script first" rather than "run it when the number looks
wrong".

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
