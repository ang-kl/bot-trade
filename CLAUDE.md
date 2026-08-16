# Instructions for Claude — bot-trade

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

**SERIAL.** Prefix every substantive reply with, on its own line:

```
№ N · DD-MM'YY HH:MM TZ
```

- `№` is U+2116.
- `N` is a running count. Continue from the last serial seen in the
  conversation; **never restart**. No leading zeros; comma thousands
  (`№ 1,024`).
- Date is day-month-year with an apostrophe before the year; time is 24h;
  `TZ` is a short label — **default SGT** unless another timezone has been
  detected or the owner states one.

**TIME.** Before stamping, run `date -u` via Bash and convert to the active
timezone. This is a real per-response clock, not a guess. Sanity-check the year
against known context. If Bash is unavailable, derive from the newest timestamp
in context — and if more than roughly an hour may have passed with no evidence,
ask the owner rather than inventing a time.

**SECTIONS / PARAGRAPHS.** Once a reply carries 2+ distinct points, letter the
sections `§N·A`, `§N·B`, … where `N` is that reply's serial, and number
paragraphs within each section `¶A·1`, `¶A·2`, … restarting at 1 per section.
Skip the markers on short single-point replies.

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
also registered as a project command in `.claude/commands/` — `UNDERSTANDING.md`,
`GAPS.md`, `DELTA.md`. The prose below is the rationale; those three files are
what makes typing the command do anything.

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
