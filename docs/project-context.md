<!-- Codex · №13,005 · 2026-10-10; codex-footprint: project-context -->
# bot-trade — project context and new-session entry point

Recorded: 10 October 2026, 19:12 SGT. Session: codex-project-context.
Conversation reference: Codex №13,001–13,005; owner requested this documentation PR after №13,004.

## 1. How to use this file

Read this index, current [CLAUDE.md](../CLAUDE.md), the applicable latest handover,
and `.agent-lock.json` on branch `agent-locks` before work. Check fresh GitHub
main and newer owner messages. A new chat does not reliably inherit this
conversation, local files, credentials or repository access; reading this file
must be requested explicitly when the client does not load it automatically.

This index separates owner instructions from dated evidence and proposed work.
It does not authorise new trading or infrastructure actions. The owner's current
explicit request takes precedence over older documents. Historical counts,
balances, observations and test totals are evidence, not standing directives.

## 2. Goals and owner-confirmed boundaries

Protect trading correctness before optimising profit: account-owned broker
execution must agree with durable storage, and profit must mean whole-position
net after costs. Faster execution, passing tests, HTTP success and protection
presence do not alone establish profitable trading or full acceptance.

Preserve the owner's WR75/PF1.68 definitions: official forward boundary
4 October 2026, 07:35 SGT; latest 20 eligible whole closes; completed-SGT-day
WR/PF streaks of 3/8 days with at least one close per day. Empty days break a
streak; today is provisional. Scratches are non-wins; PF is undefined without
losses. Apply signed commission and swap once, in each account's native currency;
do not pool USD/SGD or certify unknown money.

The approved capped momentum hybrid is 50% at 2 price-R, with existing broker
SL and TP retained. It is not an uncapped runner or a profit guarantee. Initial
risk, actual fill, residual and controller ownership require their own evidence.

For the current profit-correction work, entry and stop-loss mechanisms remain
frozen. Preserve TP policy, sizing, thresholds, account isolation, owner
overrides, book exemptions and strategy settings. Necessary reproduced fixes
and auto-merge remain authorised through the applicable required gates and actual
review inspection. A documentation PR is not permission to enable a controller.

Do not request/change credentials, force broker events, rewrite financial
history, change risk/account/strategy/profile settings, regions or volumes,
rebuild unchanged native services, alter unused staging or restart monitoring
schedules. Preserve owner withdrawals, closed reviews and historical archives;
do not reactivate them merely because an old register lists them.

## 3. Shared serial, sections and paragraphs

Follow [CLAUDE.md](../CLAUDE.md)'s serial and paragraph protocol:

- One shared sequence across Codex and Claude. Read the highest visible stamp
  from current conversation, repository ledger and lock notes before choosing
  the next serial.
- Measure the full transcript corpus when available. A missing or partial
  corpus cannot reset the sequence. State when using a recorded lower bound.
- Dated lower bound at this file's creation: **Codex №13,005**. This is not a
  measured full-corpus total, and can become stale as either agent continues.
- Stamp substantive replies with session/agent name, serial and verified SGT
  time. For multiple points use sections `§N·A`, `§N·B`, and paragraphs
  `¶A·1`, `¶A·2` within section A. Example: `Codex №13,005 §13,005·B ¶B·1`.
- Use dated comments where useful:
  `Codex · №N · YYYY-MM-DD; codex-footprint: purpose/session`.
  PRs and release receipts carry conversation references; never invent model,
  effort, session URLs or independent review metadata.
- Record the reached serial and its source in the session handback/ledger.
  Read newer evidence before continuing. Do not update this file after every
  reply or open repetitive documentation PRs just to advance its stamp.

The simplified §1/¶1 example in Codex №13,004 is superseded here by the
repository's existing section/paragraph convention; no duplicate numbering
system is introduced.

## 4. Dated baseline — refresh before acting

Source checked on 10 October 2026, 19:11 SGT:
main `28cf20bb799abd3a853b834bb67f10bccbf92c33`,
tree `f5b9436f0f8b6f214cc6246f31cba30c00a7fa36`.

- [PR1300](https://github.com/ang-kl/bot-trade/pull/1300) merged as
  `38d0233fc7d826ed8feaf58a968215f498e30edc`: corrected general-partial
  reconciliation units and added bounded account-owned evidence capture.
  Exact-head and main CI passed; deployment and ordinary runtime checks were
  verified in its dated release receipt. Do not repeat completed gates.
- [PR1301](https://github.com/ang-kl/bot-trade/pull/1301) and
  [PR1302](https://github.com/ang-kl/bot-trade/pull/1302) merged afterwards.
  They cover Scoreboard/phone reads/Pre-order and follow-up reporting fixes.
  Consult their actual receipts; PR1300's runtime check does not certify a
  later deployment.
- Completed earlier releases, including PR1233–1299, are carried forward where
  relevant source and evidence are unchanged. Recheck only a relevant change,
  failure or contradiction; this is not a claim that every acceptance group
  passed.

No whole acceptance closure or profit improvement follows from this document.

## 5. Next bounded work — proposal, not completed release

Codex №13,001 reproduced two mechanisms; №13,002 supplied the branch-out prompt.
Check fresh source for a later correction before editing:

1. Optional `agent/services/profit-keeper.js` scale-out treats acceptance-only
   or empty close responses as success, latches `scaled_out` and journals
   requested quantity. An actual keeper/SQLite controlled-boundary probe
   reproduced this. Default scale-out fraction is zero; production activation,
   occurrence and financial impact remain unverified. Preserve legitimate
   external/manual keeper scope. Validate actual owned fill and residual,
   durable uncertainty/restart handling and atomic successful bookkeeping.
   Reproduce the adjacent full-close exposure before including a correction.
2. Bounded collector detail can exhaust the output budget before essential
   summaries. The PR1300 capture retained explicit dropped/omitted counts;
   missing summaries do not prove missing database records. Reproduce emitter
   starvation, prioritise compact mandatory summaries and retain caps,
   redaction, expiry and durable once-only claims.

The owner said “merge when green” for the proposed correction. Creation of this
context file does not mean either defect has been corrected or released.

Separate remaining evidence: historical startup/watchdog function/SQL/writer
attribution; current account-owned readiness where retained fields are absent;
actual eligible hybrid trigger → fill → residual → journal; complete
whole-position after-cost populations. Do not wait indefinitely, enlarge risk,
enable optional scale-out or manufacture events to satisfy these checks.

## 6. Evidence and coordination index

- [Owner principles](owner-principles-plan-2026-09-11.md).
- [7 October handover](handover-2026-10-07-claude.md): useful dated contracts;
  scanner payloads and operational observations must be refreshed before use.
- [Historical outstanding register](2026.1004/outstanding-register.md): dated
  4 October, not the authoritative current scope or queue.
- [Contamination-debt assessment](assessment-2026-10-08-contamination-debt.md):
  exposure counts are not counts of proven defects.
- `agent-locks/.agent-lock.json` means file `.agent-lock.json` on branch
  `agent-locks`, not a directory on main. Read all notes, claim affected paths,
  check locks before modification, coordinate overlap and release after merge.
- Previous local receipt directory, only if it persists:
  `/workspace/bot-trade-consolidated-followup-evidence-2026-10-10/`.
  Relevant files: `release-handback.md`, `core-diagnostic-audit-1657.md`,
  `core-profit-keeper-probe-1657.json`. Their absence in a new workspace is
  unavailable evidence, not permission to invent prior outcomes.

## 7. Completion and exit

Separate engineering completion, operational verification, financial outcome,
administrative deferral and whole acceptance closure. Close a source defect
after reproduced correction, meaningful integrated validation, applicable local
and exact-head CI gates, actual review inspection, merge and deployment checks.
An operational claim needs its actual execution evidence; a profit claim needs
the eligible whole-position population.

Report baseline, reproduction, correction, validation, release, runtime
verification, exit and smallest next work. Mark inapplicable stages for read-only
tasks. State exact dependencies, preserve evidence and stop the bounded task.
Do not create another monitoring schedule.
