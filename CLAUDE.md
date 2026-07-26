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
Measurement at 2026-07-26 01:00 UTC on session `ad9d1f6f`: **1,773 reply
turns** (404 owner turns, 10,558 assistant entries in total, 28 compact
events, 172 MB). The count was therefore **rebased to `№ 1,773` as the last
reply**, and the next reply is `№ 1,774`. Continue from there; re-measure
rather than guess if the thread is ever lost.

Two earlier claims in this file were wrong and are corrected here:

- A real prior sequence *did* exist — the transcript carries 134 stamped
  headers running from `№ 1` up to `№ 145` between 2026-07-22 and 2026-07-25,
  plus later un-headered references to `№ 176`. The previous note called
  `№ 176` a pure fabrication referencing no ledger; that was itself wrong.
- That sequence undercounted, because it only stamped replies Claude judged
  "substantive". The transcript is the authority: every text reply counts.
