# Instructions for Claude — bot-trade

<!-- Codex · №12,075 · 2026-10-08; session: confirmed-trail;
codex-footprint: broker-confirmed movement has an owned journal consumer.
After PR1262 merged as a75878df, its automated P1 review correctly identified
that snapshot observations no longer supplied the trail_tightened readers.
Do not restore fictitious moves: native amend_ok can be policy-only stamping.
Carry actual before/after broker account/position/symbol/direction/entry/SL
and read clocks in a bounded v1 movement proof; only strict level improvement
in an existing read/amend/read transaction claims movement. Node retains the
raw receipt and owned journal atomically, with source event time and retry on
write failure. Unknown, proof-less, ambiguous or unbound identities stay raw;
no historic move recovery or universal collector-completeness claim.
Readers compare source clocks and account/trade ownership; late ingestion
cannot reopen a later close or satisfy an earlier/foreign promise.
Five actual Node-path and two native-path regressions fail unchanged source;
four assistant-review episode/lifecycle/source-clock regressions fail the
preceding candidate;
153 focused Node checks passed before the final clock correction; the final
12 receipt/reader regressions and both focused native programs pass.
Full local/exact-head CI, actual review inspection, merge and deployed
ordinary-runtime verification remain pending at 2026-10-08T03:09Z.
Existing trading wire/ratchet acceptance, policies and retention are unchanged.
No broker forcing, credentials, risk/account/strategy/profile/selected-account/
history/region/volume/staging or monitoring-schedule action. Acceptance remains
7verified/19active/6deferred until a complete group passes.
The first full gate failed the routing vocabulary boundary and an unchanged
idle-lag fixture (one probe; isolated11/11 passes, thresholds preserved).
Keep mode/host matching in heartbeat via the existing registered-account
router; the movement reader receives its bound account/host. The existing
heartbeat exact-count allowance changes28 to31 for three routing references;
no new module allowance or trading condition. 94 routing/receipt/heartbeat
checks pass. Preserve the failed gate; refined exact source needs full gate.
-->

<!-- Codex · №12,049 · 2026-10-08; session: collection-retention;
codex-footprint: preserve available observations without inventing actions.
Owner requests investigation/correction of incomplete collectors across the
19 active acceptance groups. Fresh main7b19c649 retains PR1233–1261 and gates.
Nine actual-path regressions fail before correction: native response cursor
race/legacy unseen tails, failed or falsely labelled stop journals, independent
protection reads suppressed/overwritten, and refusal proposal/check splicing.
Ack only durable native sequences; retry failed observation writes; snapshots
are trail_observed, not trail_tightened; retain independent per-position stops
with their own source/time; pair first refusal proposal/checks and latest reason.
Node-only, prospective retention; no financial-history repair or recovery claim
for overwritten/interior native-ring gaps. Existing bounded retention/polling,
equity composition, ratchet/trading policy and owner scope remain intact.
Full local/exact-head CI, actual review inspection, merge and deployed ordinary
runtime verification required. No forced broker event, credentials, risk/account/
strategy/profile/selected-account/region/volume/staging/schedule action. Whole
acceptance remains7verified/19active/6deferred until complete criteria pass.
The first full backend gate caught the new recorder naming policy fields outside
their canonical module. Preserve that source boundary: read-only observation
decoding now lives in stop-policy.js and reuses brokerTrigger/brokerTrailing;
policy writers and thresholds stay unchanged. Initial failed gate retained;
refined exact head requires the full gate before merge.
-->

<!-- Codex · №12,020 · 2026-10-08; session: executed-volume-provenance;
codex-footprint: validated volume provenance pair. Owner ordered PR1259 P2
follow-up after №12,010–12,011. Fresh main9c716b04 retains completed
PR1233–1260/gates. Five actual importer/downstream-reader regressions fail
unchanged main: incomplete rereads downgrade contract1, and an untagged
writer can pair requested lots with the prior validated flag. Preserve
stored executed lots and contract together when replacement proof is absent;
unknown/legacy NULL receipts, identity rollback and native money stay intact.
The first full gate exposed a candidate-only W10 compatibility failure when
API executed units were known but converted lots were NULL. Retain the old
explicit statement closing-lots fallback in that case; preserve already known
executed lots. Initial failed gate retained; refined exact head needs full gate.
No production impact or financial-history repair established. Full local/
exact-head CI, actual review inspection, merge and deployed verification
remain required. No broker forcing, credentials, risk/account/strategy,
registry, region/volume/staging or monitoring schedule changes. Whole-row
acceptance stays7verified/19active/6deferred unless complete criteria pass.
-->

<!-- Codex · №11,968 · 2026-10-08; session: http-read-diagnostics;
codex-footprint: opt-in read failure attribution. Owner authorises full gates,
merge and shared native release, with HTTP_READ_DIAGNOSTICS=1 only on tick and
verifier. Default off; fixed phase/reason/saved errno, byte counts and socket
endpoints only, rate-limited 1/s. No request contents, secret or token values.
Preserve framing/authentication/caps/responses/timeouts and byte-identical shared
HTTP sources in four projects. Five native services rebuild because execution
and accounts share one source project; no trading policy change. Existing
PR1233–1259 releases/gates remain complete. Production failure cause unproven;
full local/exact-head CI, actual review inspection and deployed verification
pending at 2026-10-07T22:11Z. No broker forcing, credentials, risk/account/strategy/
registry/history/region/volume/staging or monitoring schedule operation.
Acceptance stays 7 verified/19 active/6 deferred; zero new whole-row closures.
-->


<!-- Codex · №11,890 · 2026-10-07; session: reversal-lifecycle-guard;
codex-footprint: reversal-lifecycle-guard. Owner-confirmed manual GER40 reversal
supersedes actor uncertainty. Reuse completed PR1233–1257/gates. Actual source
probes and five regressions fail unchanged34d6f51: the broad reader can certify
a mixed close/open reversal, and the exact reader can return complete:true
despite rejecting multiple same-ID episodes in its lifecycle proof. Shared
guard now requires actual filled/closed equality and one balanced nonempty
lifecycle; empty/never-filled/open classifications and signed native costs hold.
Eight real-helper/caller checks pass after correction; full local/exact CI,
review inspection, merge and deployed verification remain pending at verified
2026-10-07T11:27:54Z. No importer historical-lot/price overwrite correction,
manual money/history repair, native source/rebuild, credential/broker/risk/account/
strategy/profile/region/volume/staging or schedule action. Existing importer and
native nominal-volume contract remains separately open; no production GER40
net/volume attribution or whole acceptance row pass. Counts7verified/19active/
6deferred and all owner exclusions remain. Session link/effort unavailable via
this connector; no independent human review claimed. -->

<!-- Codex · №11,791 · 2026-10-07; session: performance-essentials; codex-footprint: performance-essentials.
Owner ordered essential Performance cards first and a metrics/sizing audit.
Forward per-account results now lead capital and recorded management readings;
historical metrics explain currency/population gaps, non-wins and UTC days,
retain undefined no-loss PF and display known zero drawdown. Goal reads reuse
the active report refresh; phone scope remains explicit. Trading/risk/money
writers unchanged. Handover read at pinned f9f0b6e; PR1254 preserved.
Five old-page browser assertions failed; corrected page passed scoped browser
checks. Final combined-source local/exact-head CI and deployed verification
remain pending at 2026-10-07T06:36:42.354514+00:00. No whole acceptance row closed.
-->

<!-- FX startup correction 2026-10-06: owner ordered fix after №11,420.
PR1237 released bounded first-cycle attribution at494c155; do not repeat
its gate. Trace reported3.8s in legVetoDemand, not proof of the earlier47s
block. The unchanged FX sweep reads veto history even with no eligible
quote request. Two actual-DB regressions fail before correction; retain
eligible-leg priority, repeated veto counts, deposit currencies, freshness,
retry delays and quote validation. Skip that read only when eligibility
is empty. No rate invention, money/history edits, broker forcing or config
changes. Full local/exact-head CI and deployed verification required.
Conversation ref: ordered after №11,420; progress №11,448–11,450.
Session link and measured effort unavailable; no independent review claimed.
-->

<!-- Startup-stall investigation 2026-10-06: owner ordered fix after
№11,420; progress №11,421–11,424. Fresh base9e19565 retains completed
PR1233/1234/1235/1236. Scan-only profiling omitted phase handoff writes
and independent callbacks during a measured startup stall. Add one
first-cycle CPU trace, stopped on completion/error or a120s timer
(synchronous blocking can delay the timer), then restore opt-in profiling.
Output only bounded code locations/timings; no SQL, args or credentials.
This corrects diagnostic coverage, not a proven production stall cause.
Trading gates/deadlines/protections and all owner exclusions remain intact.
Full local/exact-head CI and deployed verification still required.
Conversation ref: ordered after №11,420; reported №11,424.
Session link and measured effort unavailable; do not invent.
-->

<!-- Edge-watchdog currency correction 2026-10-06: owner ordered after
№11,382; progress №11,383–11,386. Fresh base2ad23e16/tree667fbf9f retains
completed PR1233/1234/1235 and their gates. Reproduced source-only currency
mixing is not proof of production impact. Rolling edge preserves exact
selection/count/win-rate populations; money requires one account/host-owned
verified currency. Mixed/unknown money cannot retire global/other-account
cells or consume pooled dedupe. Existing full-window/negative-expectancy/PF
bars remain unchanged; verified own-only losing accounts retain their own
protection and dedupe when pooled money is unavailable. Other hand pins hold.
No synthetic FX/history rewrite, manual strategy/risk/credential/order
operation or native production rebuild. Full local/exact-head CI gates,
merge and deployment remain pending at this source stamp. Keep7verified/
25active/zero new whole-row closures and all latest owner exclusions.
Hourly watch remains disabled; unused staging untouched. Session link and
measured effort unavailable; no independent human review claimed. -->

<!-- Bounded morning reporting correction 2026-10-06 00:41 UTC: owner
authorised the morning plan after №11,347 and requested a09:30SGT report.
Fresh main d137b181 and tree a39f558c are unchanged; PR1233/1234 and their
completed gates are reused. A real in-memory DB fixture reproduces the
legacy performance alert pooling verified USD/SGD amounts. Eight new
regressions fail unchanged source and pass the isolated correction: monetary
PF/net/expectancy require one account-owned known currency across the same
last-N ledger rows; mixed/unknown units consume no alert dedupe state.
Homogeneous alert thresholds/window and all trading flags remain unchanged.
This is not forward whole-position performance acceptance. Full local and
exact-head CI gates, merge and deployed identity remain pending at this stamp.
Transport499 corroborates client cancellation, but caller/cause remains
unproven. App read access remains unbound;25 active/7 verified, no new full
closure. Hourly watch remains disabled; staging and all owner exclusions
remain unchanged. Conversation ref: ordered after №11,347; progress
№11,350–11,351. Session link/effort unavailable; no independent human review.
-->

<!-- Auth stability follow-up 2026-10-05 13:22 UTC: lower bound through
№11,249; later visible replies win. Owner ordered resolution of cpp-exec
broker-authentication failures after №11,243. Current base main a0fe36c;
PR1233 precision release and its passed gates remain complete. Temporary
4/4 demo authentication recovered at20:32SGT, then primary invalid-token
errors recurred21:14SGT; independent spot-feed ticks remained fresh.
Actual-source offline probes reproduce stale queued token rollback and
concurrent refresh response overwrites. A bounded correction is being
prepared with required full local/exact-head CI gates and authorised
auto-merge; no new production source release or incident-cause proof yet.
Keep the25 active rows, withdrawals18/31, closed-review gaps17/32/39 and
historical archives11/24/37/41. No credential extraction/manual refresh,
test orders, risk/account/activation/history/region/volume changes or
native rebuild. Conversation ref: ordered after №11,243, investigation
№11,244–11,249. Session link/measured effort unavailable; do not invent.
-->

<!-- Continuation ledger 2026-10-05 03:40 UTC: lower bound through №11,144;
next at least №11,145. Owner explicitly authorised execution of the 17
matching register rows and auto-merge after the full gate. This supersedes
historical publication waits below for this scope. Baseline main9eaa3c0;
all six Railway services online. Preserve existing fixes and failed research.
Two reproduced bounded corrections: retain and validate broker precision for
since-entry specs; scope latency evidence to account/symbol/intent host/tag.
Three regressions red before/green after; focused63 and routing/cost17 pass.
Final local backend7505 pass/4existing skips; frontend1317, lint/build/colour
and syntax pass. Exact-head PR CI pending; no merge/release claimed. Secure read
binding/session/full populations unavailable. All17 acceptance groups remain
open; full queue7done/34outstanding/3inactive/1parked. No risk/history/order/
activation changes or retired observer rebuild. See checkpoint section10.
Actual session link and measured effort unavailable; no independent review
claimed. -->

<!-- Continuation ledger 2026-10-04 07:19 UTC: lower bound through № 11,088.
Direct user request was to read the continuation attachment; implementer also
prepared a local cache correction. Auto-review rejected remote tree creation
because publication was not directly authorised. No remote tree/commit/branch/
PR created; #1228 and production unchanged. No workaround. Local four-file
patch is reviewable; full native gates/new CI have not run. Additional mocked
foreign-host/account/missing-bars checks pass with own-source fetches and zero
broker/DB actions. Publication needs explicit approval; merge/deployment still
requires concrete exact-head scope. See checkpoint section9. -->


<!-- Continuation ledger 2026-10-04 07:12 UTC: cloud partial corpus continues
through at least № 11,084; later replies supersede this lower bound. Morning
auto-approval expired at 10:00 SGT. Main/#1228 unchanged (1afda08/4ea69e1);
#1228 exact-head CI reused, actual automated review action skipped. Fresh
15:10 SGT account reads: 11 protected, no missing SL/TP1; aggregate close
completeness17 and written-off unknown19 remain unjoined, not added. Four
repo statement bytes fail the original manifest; no baseline rerun/certification.
Focused real keeper/ATR/account/book modules with mocked DB and broker I/O
reproduce warm-cache since-entry trail counts [1,0]; local correction [1,1],
one bar read, zero amendments/closes/DB writes. Full bars retained with
host/account provenance; managed fence, book exclusion and risk unchanged.
Distinct cache candidate is stacked on #1228, not a replacement; new full
CI and exact-head verification required. Shell proxy/native dependencies
unavailable; no bypass. Read secret/row exports and original unpublished
Oct1 checkout unavailable. Full performance/Chandelier/V3 acceptance stays
open; no merge, deployment, broker/history/activation/variable mutation.
See appended docs/gtd-2026-10-04-evidence-checkpoint.md. Actual model,
effort/session metadata unavailable; no independent review claimed. -->

<!-- Continuation ledger 2026-10-04 02:54 UTC: partial corpus remains
unavailable; visible continuation through № 11,064, next at least № 11,065.
The owner's bounded auto-approval expired at 10:00 SGT. Preparation, report
and draft PR continue under "proceed"; a new merge/deployment requires scoped
approval of the concrete candidate. Main remains #1227 1afda08, Railway
087b0a2d-e408-4fb5-9591-58003c6084e4 SUCCESS. Five statements ending Oct1
reconcile 1421 deals and 1382 closed entry-cohort proxies; no certified whole
position/strategy baseline or new forward target achievement is claimed.
Current BTC FVG5 resolves shared default threshold8 (source-derived); one
separate VA_BREAKOUT refusal is recorded for spread15 >8.6255238, gate stop
unit287.51746. SGD FX refuses unusable fresh direct legs; two live accounts
are unfunded; seven S/A/T ON and all11 current positions protected in dated
read-back. Dynamic Chandelier/scanner and natural-fill acceptance remain open.
Live WMT lesson contradicted banked2.95R versus best0.07R and advised Repeat.
Bounded candidate marks future such wins inconclusive, withholds excursion
certification/recommendations, and never rewrites history or changes orders.
Focused postmortems35 passed, frontendUTC1316 passed, lint/build/colour/syntax
passed; initial backend local-zone run had two unchanged fixture failures and
four skips. Complete UTC backend now passed7487 with four existing native skips.
PR#1228 opened3eeab9f. Integration review found positive-net inconclusive
rows incorrectly grouped under Losses. UI correction preserves them in Wins,
with a rendering regression that fails the published UI and passes the fix.
Final frontend1317 and lint/build/colour passed; final-head CI pending.
Claude workflow actual action SKIPPED; manual source review is the evidence.
See docs/gtd-2026-10-04-evidence-checkpoint.md and original carry-forward.
Actual model/effort/session metadata unavailable; none is invented. -->

<!-- Continuation ledger 2026-10-04 01:39 UTC: partial corpus remains
unavailable; visible replies through № 11,039, next at least № 11,040.
Owner authorised bounded GTD corrections, checked merges and resulting
production deployments until 10:00 SGT on 4 October. #1225 bf90e3d and #1226
4342718 merged, exact-head CI passed and Railway SUCCESS. Browser web/agent
4342718 healthy; per-account forward WR75/PF1.68 card shows zero closes and
Not yet assessed on all seven accounts. Numerical achievement not claimed.
W1 resolved: per-account latest20 whole closes after07:35SGT; each completed
SGT day meets its own threshold, min1 close, empty day breaks; reporting only.
Live inspection found the new card's expand body missing. UI-only follow-up
supplies it and an assessment timestamp. Full frontend1316 passes; backend
source unchanged from the7485-pass/four-skip #1226 candidate; CI pending.
Dependabot40-42 fixed, zero open. All seven S/A/T on; no unresolved intents;
11 positions independently protected. Dynamic management, final MAE/MFE,
Chandelier/scanner acceptance and exact current BTC decision remain unverified.
SGD FX entry refusal and two unfunded live accounts persist; no gate lowered.
See docs/performance-targets-2026-10-04.md and original GTD carry-forward.
Actual model/effort/session metadata unavailable. -->

<!-- Continuation ledger 2026-09-24 23:30 UTC: visible replies through
№ 8,977, partial local corpus still not adopted. #1083 deployed d61d84d;
seven-account current money and all-time rows, all-account Desk positions,
crypto quotes and Sessions page were browser-read back. Entry settings
unchanged and protection audit reports 32 protected positions. Follow-up
corrects leftover ledger calendar labels and coordinates concurrent history
reads after observed worker-capacity errors. Its full release gate is running.
Partial-TP cost treatment and 24-hour expiry origin remain pending. The health
badge reports two missing realised-P&L reconciliations; V3 is not accepted. -->

<!-- Continuation ledger 2026-09-24 23:16 UTC: partial corpus, visible replies
through № 8,968; later visible replies win. Owner merged #1081 at 23:13 UTC;
Railway deployed b95975f successfully. Reporting PR #1083 incorporates it.
Before that merge: 5,535 backend checks and 955 frontend checks passed locally.
Final combined-source/CI gates remain required. A stale broker-position source
was identified: active Performance/Desk now share its read-only refresh.
Partial-TP cost-reserve treatment and session-expiry origin remain pending;
new partial execution is inactive and V3 acceptance is still open. -->

<!-- Continuation ledger 2026-09-24 23:09 UTC: partial corpus remains 8,
not adopted. Visible continuation reached № 8,964; later visible replies win.
Local reporting build uses the owner-confirmed local Performance calendar day,
account-owned current money for all seven accounts, read-only Desk overview,
and browser-session/sleep corrections. Full release gates are in progress.
No trading settings or broker positions were changed. P0/P3 remains incomplete;
explicit carry-reserve treatment and 24-hour session-expiry origin await owner
answers. The older #1081 test-clock fixture proposal remains unapplied. -->

<!-- Continuation ledger 2026-09-24 22:10 UTC: partial local corpus (script 8);
visible replies reached № 8,945, next № 8,946. Later visible replies win.
#1082 is deployed ba1b16f; first loop remains 122,773 ms. Fresh authenticated
readback covers seven accounts and 32 positions with SL/TP. #1081 exact-head
CI passed, but the interrupted combined backend run had no final summary;
it is being rerun rather than counted as complete. New partial-policy
production integration remains INCOMPLETE and inactive; V3 is not accepted.
The audit work-product timestamp is request time, not completion: its gap to
the heartbeat does not prove an outbound-notification delay. -->

<!-- Continuation ledger 2026-09-24 17:44 UTC: partial local corpus;
visible replies reached № 8,940, next № 8,941. Later visible replies win.
#1079/#1080 deployed with seven-account settings and 32 protected positions
preserved. #1082 merged ba1b16f after 5,526 backend/943 frontend checks and
exact-head CI; production timing readback is pending. #1081 passed 5,527
backend checks before incorporating #1082; combined-source checks follow.
Current frozen-group evidence is summarized at the top of the closure register.
V3 is not accepted; target-policy producer wiring and operational trials remain. -->

<!-- Continuation ledger 2026-09-24 17:34 UTC: partial local corpus;
visible replies reached № 8,934, next № 8,935. Later visible replies win.
#1079/#1080 merged 4472e91/d878ea9 after full gates. Seven-account entry settings
and 32 broker-protected positions were preserved on #1079. Its first loop took
124,390 ms; performance acceptance remains open. Decision-audit indexed-range
fixtures retain exact report JSON, improving synthetic reads from 257-295 ms
to 2.47-4.48 ms. #1081 corrects misleading target-outcome counts in release.
New target-policy producer wiring remains incomplete; no live activation. -->

<!-- Continuation ledger 2026-09-24 17:28 UTC: partial local corpus;
visible replies reached № 8,931, next № 8,932. Later visible replies win.
#1079 merged 4472e91 after full gates; #1080 final exact-head CI is running.
Both leave new target-policy production integration incomplete and inactive.
Two false target-outcome regressions reproduced, then 171 focused checks
passed. Latest completed first-loop sample 121,886 ms still fails the proposed
60-second goal. V3 acceptance remains open; no live execution was activated. -->

<!-- Continuation ledger 2026-09-24 17:07 UTC: partial local corpus (script 8);
visible replies reached № 8,921, next № 8,922. Later visible replies win.
#1077 merged 8bcb708 and deployed; seven accounts retain 32 protected positions
and unchanged entry configuration. First loop 125,069 ms leaves broader
performance acceptance open. #1078 source passed all local/CI gates; entry
intent/book handover is under build and does not activate partial execution. -->

<!-- Continuation ledger 2026-09-24 16:52 UTC: partial local corpus (script 8);
visible replies reached № 8,914, next № 8,915. Later visible replies win.
#1076 merged 7ea54b6 and deployed. The first independent poll retained fresh
pre-boot readings on all seven accounts; 32 positions held both SL and TP.
First loop 85,657 ms; report 81 ms application / 294 ms browser. Broader load
acceptance remains open. Thirty-nine focused target-policy/manager/adapter
checks pass; producer/entry/fill integration remains unfinished and inactive. -->

<!-- Continuation ledger 2026-09-24 16:18 UTC: partial local corpus (script 8);
visible replies reached № 8,909, next № 8,910. Later visible replies win.
#1075 merged 47a0268 and deployed successfully; current DB init 391.5 ms,
account report 81 ms, protection band 1,633 ms; full loop 133,787 ms remains
outside a closed performance claim. Seven-account broker protection preserved.
Independent-checker reconnect correction is in release; partial TP integration
is not active. V3 acceptance remains open; no live execution was activated. -->

<!-- Continuation ledger 2026-09-24 16:03 UTC: partial local corpus;
visible replies reached № 8,900, next № 8,901. Later visible replies win.
#1074 merged fac2a6d and deployed successfully. Fresh independent readings
cover seven accounts with no missing SL/TP; database startup remains Failed.
Partial-TP work continues separately; no live execution was activated. -->

<!-- Continuation ledger 2026-09-24 15:45 UTC: partial local corpus retained;
visible replies reached № 8,889, next № 8,890. Later visible replies win.
ETHUSD/XRPUSD demo targets acknowledged and broker-read back with existing stops
preserved. Startup-price correction is in release checks; V3 remains open. -->

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

## Conversation reference on every PR (owner, 2026-10-02) — standing rule

Owner, 02-10-2026 (№ 10,424–10,425): *"bake-in the serial numberings of our
dialogue … so that each PR has a reference to the conversation regardless of
LLM"*, and *"Henceforth must include conversation serial numbering, LLM model
and effort for each PR."*

- Every PR body and its squash commit carry a `Conversation ref:` line naming
  the reply that ordered the work and the reply that reported it, e.g.
  `Conversation ref: ordered № 10,337·E·1 · reported № 10,374`, plus the
  session link. Plan items carry the same serials.
- Model and effort. CORRECTED 02-10-2026: the reasoning effort IS readable —
  the session's `get_session` tool returns `effort_level`, and reading it is
  not inferring it (P8). So every PR body carries `Effort: <level>` read from
  that tool at the time. The MODEL is still NOT written: the cloud session's
  own instructions forbid any model identifier in commits, PR text or code,
  and the session link on every PR is what resolves it. (The model can change
  mid-session — the owner's `/model` switch on 02-10 did — which is one more
  reason to read it from the session record, never from memory.) The earlier
  version of this paragraph said effort was not exposed; that was wrong, and
  is recorded here rather than silently replaced. The model half stays an open
  conflict between the owner's order and the environment.
- In the code too (owner, 07-10-2026, after № 11,596: *"include serial
  number (example, Claude · 11,583·D) in the code along with claude-footprint
  (if necessary) as comment"*): the changed lines carry the same reference as
  a comment, e.g. `// Claude · № 11,596·D·1 (ordered № 11,583·D·1;
  claude-builder)`. The session name is the footprint — it is what tells two
  agents building concurrently apart — and it is a name, not a model
  identifier, so the no-model-in-code rule holds. Owner, 07-10-2026 after
  № 11,659: the comment carries the date too, `Claude · № 11,660 07-Oct`, so
  Codex can see which area was modified and when; the lock file lives on
  branch `agent-locks` (`.agent-lock.json`), approved the same day.

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

- 2026-09-22, **Codex Work revision 3 continuation, transcript corpus unavailable**:
  The serial-count script again found no JSONL transcripts. Visible replies
  continued from the recorded 8,356 through **`№ 8,389`** at 16:06 SGT while
  reconciling main, recovering account edits, and implementing separate account,
  calendar, reporting and ownership corrections. This is a continuation of the
  recorded rebase, not a new measured transcript count. Later visible replies
  take precedence; no cumulative agent/token count is inferred.


- 2026-10-01 13:10 UTC, **remote container, PARTIAL corpus** (the §1
  write-back rule; Codex worked 27-09 evening to 01-10 and handed back on
  01-10, `docs/v3-handover-2026-10-01.html`): the highest stamp recorded on
  main is Codex's `№ 10,331` (28-09); Codex's later replies are not recorded
  anywhere readable here, so every number below is a LOWER BOUND. Claude's
  first reply after the hand-back was stamped `№ 10,332` but one unstamped
  line preceded it, so it is at least `№ 10,333`; three unstamped lines
  followed, so the 01-10 20:42 SGT files report (statements, logs, live
  per-account blockers) is at least **`№ 10,337`**. Seventeen unstamped
  status lines followed it while fix A (zero balance), the partial-exit
  wording and fix B (Scan OFF needs the owner) were built, so the last reply
  before this ledger is at least `№ 10,354` and the next stamped reply is at
  least **`№ 10,355`** plus any unstamped line made after this ledger. The
  count is by replies, not by stamps. A later re-measure that reads below
  this line is missing these, not correcting them.
- 2026-10-02 00:10 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule): continuing from the line above (next stamp at least
  `№ 10,355`), the replies ran on by count through the #1176 report
  `№ 10,374`, #1177 `№ 10,380`, the Cocoa/BTC/scanner orders `№ 10,389`, the
  monitor and tampering answer `№ 10,395`, the nightly LOOP HUNG fix #1179
  `№ 10,419` and its merge `№ 10,422`, the check-in `№ 10,424`, the
  conversation-ref rule `№ 10,425` and the E·4/D·3/D·5 read `№ 10,429`. Five
  unstamped status lines followed it while the 429-cause PR was built, so the
  next stamped reply is at least **`№ 10,435`** plus any unstamped line made
  after this ledger. All lower bounds. The count is by replies, not by stamps.
  A later re-measure that reads below this line is missing these, not
  correcting them.
- 2026-10-02 02:50 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule): from `№ 10,435` the replies ran on by count through the
  429-cause PR #1181 (merged with the duplicate removal: four phantoms voided,
  five originals reopened, read back clean), the Chandelier PR #1182, the
  MAE/Chandelier verification `№ 10,473`–`№ 10,474`, the cTrader trigger/
  trailing capability answer **`№ 10,492`** (09:43 SGT), and the stop-loss
  policy plan (Opposite trigger, broker-side trailing once the stop locks
  profit; approved 10:2x SGT) with PR-1's build. At least twenty-two unstamped
  status lines followed `№ 10,492`, so the next stamped reply is at least
  **`№ 10,515`** plus any unstamped line made after this ledger. The model
  was switched by the owner mid-session (`/model`); effort read from
  `get_session` is `max`. All lower bounds. The count is by replies, not by
  stamps. A later re-measure that reads below this line is missing these, not
  correcting them.
- 2026-10-02 06:35 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule): from the ledger line above (next stamp at least
  `№ 10,515`), the replies ran on by count through the #1183 PR-1 report
  `№ 10,516`, the deploy read-back `№ 10,520`, the Railway log read
  `№ 10,521`, the PR-2 build and the plan for `№ 10,521·B` `№ 10,522`–
  `№ 10,528` (several unstamped status lines among them), the ask before
  executing `№ 10,529` (14:18 SGT) and the pre-merge fixes `№ 10,530`
  (stamped 14:32 SGT, a guessed time: about 14:25 by the clock);
  `№ 10,531` was stamped 14:55 SGT where the clock read 14:32 (the §2
  failure, corrected in the open at `№ 10,532`, 14:35 SGT). #1183 (stop-loss policy wire) merged 03:09 UTC and read back
  clean; PR-2 (the stop-policy controller) is built and gated and is the PR
  this line rides. The next stamped reply is at least **`№ 10,533`** plus any
  unstamped line made after this ledger. All lower bounds. The count is by
  replies, not by stamps. A later re-measure that reads below this line is
  missing these, not correcting them.
- 2026-10-02 07:30 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule; the session restarted twice in between and plan mode came
  back on each time): from the ledger line above (next stamp at least
  `№ 10,533`), the replies ran on by count through the PR-2 ask `№ 10,534`
  (14:55 SGT) and its explanation `№ 10,535`, the #1184 merge `№ 10,536`
  and the book-row defect `№ 10,537`, `№ 10,538`–`№ 10,539`, and the #1185
  merge and read-back `№ 10,540` (about 15:25 SGT), with unstamped status
  lines between them. **Three stamps used a guessed time and are corrected
  here:** `№ 10,536` and `№ 10,537` read 15:07 and 15:11 SGT where the clock
  said 15:03 and 15:05, and `№ 10,540` read 15:26 where it said about 15:25
  (the §2 failure, third time today; the clock is fetched before every stamp
  from `№ 10,538` on). #1184 (the stop-policy controller) and #1185 (book
  rows are stamped; a read-back mismatch is not a trail) are merged and read
  back: 10 of 17 stops Opposite at 07:25Z and rising, no refusal, no stop
  level moved. This line rides the R1 fix (the closed-market exit hold). The
  next stamped reply is at least **`№ 10,542`** plus any unstamped line made
  after this ledger. All lower bounds. The count is by replies, not by
  stamps. A later re-measure that reads below this line is missing these, not
  correcting them.
- 2026-10-02 07:58 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule): from the ledger line above (next stamp at least
  `№ 10,542`), the replies ran on by count through the R1 read-back
  `№ 10,544` (15:40 SGT: the PG.US hold's first minute clear, not yet proof),
  the notification answer `№ 10,545` and two unstamped status lines while PR-3
  (the integrated stop-loss suite) was built (`№ 10,546`–`№ 10,547`), so the
  next stamped reply is at least **`№ 10,548`** plus any unstamped line made
  after this ledger. #1186 (the closed-market exit hold) was merged by the
  owner and is live; the plan-mode flag was lifted by the owner's "continue
  with PR-3". All lower bounds. The count is by replies, not by stamps. A
  later re-measure that reads below this line is missing these, not
  correcting them.
- 2026-10-02 09:05 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule): from the ledger line above (next stamp at least
  `№ 10,548`), the replies ran on through the #1187 report `№ 10,550`, its
  merge `№ 10,553`, the "what else isn't built" list `№ 10,554`, the owner's
  keep/drop answers `№ 10,555`–`№ 10,556`, the TP1/TP2, 27-09 follow-up and
  broker-order report `№ 10,560`, the 30-09 wrong-account reply report
  `№ 10,561` and the keeper-coverage report `№ 10,562`, with unstamped status
  lines between them. The owner then ordered the identity check at the four
  unguarded reconcile reads (this PR); two unstamped lines followed
  `№ 10,562`, so the next stamped reply is at least **`№ 10,565`** plus any
  unstamped line made after this ledger. #1187 (the integrated stop-loss
  suite) is merged. All lower bounds. The count is by replies, not by stamps.
  A later re-measure that reads below this line is missing these, not
  correcting them.
- 2026-10-02 09:52 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule): from the ledger line above (next stamp at least
  `№ 10,565`), the replies ran on through the #1188 report and merge, the
  XRPUSD / MSFT.US decision and the "what else isn't built" list `№ 10,572`
  (the stamps `№ 10,568` and `№ 10,569` were two behind by count, and were
  `№ 10,570` and `№ 10,571`; disclosed in the open at `№ 10,572·A`), the
  owner's `№ 10,572·C` answers (SGD, scanner alignment, startup stall, the
  1.5R cap and the tick switch-on approved, TP1 numbers left to Claude to
  confirm) and the short status `№ 10,573` (17:33 SGT). Three unstamped
  status lines followed, so the next stamped reply is at least
  **`№ 10,577`** plus any unstamped line made after this ledger. The
  startup-stall fix (this PR) comes from the profiler capture the owner
  approved. All lower bounds. The count is by replies, not by stamps. A later
  re-measure that reads below this line is missing these, not correcting them.
- 2026-10-02 11:34 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule; the container restarted ~10:15 UTC in between; the owner replied ~11:30 UTC): from the
  ledger line above, the report `№ 10,585` (17:58 SGT: the seven §10,572·C
  items answered), #1189 merged and read back (scan phase 67.3 s to 39.5 s,
  first loop 145.9 s to 123.6 s; the profiler restored to scan,monitor), and
  `№ 10,586` (18:22 SGT). The owner's "confirm the slippage figures" followed;
  this PR carries it. The next stamped reply is at least **`№ 10,590`** plus
  any unstamped line made after this ledger. All lower bounds. The count is by
  replies, not by stamps. A later re-measure that reads below this line is
  missing these, not correcting them.
- 2026-10-02 14:10 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule): from the ledger line above (next stamp at least
  `№ 10,590`), the replies ran on by count through #1190 and #1191 (the
  measured TP1 slippage, with the Codex review fix), the owner's "4R" and the
  seven book targets moved (`№ 10,601`, broker-confirmed by the verifier),
  the Telegram answers `№ 10,604`, `№ 10,606`, `№ 10,608`, the US-open check
  `№ 10,612`, the alert-rate trace `№ 10,614`, the correction that stopped
  that build `№ 10,617`, and the C·2 ask `№ 10,619`–`№ 10,621`. The owner's
  "route" followed; this PR carries the read-only scanner snapshot route. The
  next stamped reply is at least **`№ 10,626`** plus any unstamped line made
  after this ledger. All lower bounds. The count is by replies, not by stamps.
  A later re-measure that reads below this line is missing these, not
  correcting them.
- 2026-10-02 16:26 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule): from the ledger line above (next stamp at least
  `№ 10,626`), the replies ran on by count through the C·2 snapshot route
  (#1192, merged), the status `№ 10,645`, the C·2 payload report `№ 10,646`
  (nothing applied; awaiting the owner's "apply"), the build-order advice
  `№ 10,647`, the Chandelier status `№ 10,648` and the since-entry diagnosis
  `№ 10,649`. The owner then ordered the since-entry fix ("no excuse like
  incomplete"); this PR carries it. The next stamped reply is at least
  **`№ 10,651`** plus any unstamped line made after this ledger. All lower
  bounds. The count is by replies, not by stamps. A later re-measure that
  reads below this line is missing these, not correcting them.
- 2026-10-02 17:30 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule): from the ledger line above (next stamp at least
  `№ 10,651`), the replies ran on through #1193 (the since-entry fix, merged
  and deployed; `№ 10,650`, `№ 10,652`, `№ 10,653`), the C·2 apply (the
  registry at revision `5bd5533f`, 902 profiles; bridge off then on, two Node
  restarts; `№ 10,654`, 00:58 SGT) and the owner's order to build the
  closed-position cleanup; this PR carries it. The next stamped reply is at
  least **`№ 10,656`** plus any unstamped line made after this ledger. All
  lower bounds. The count is by replies, not by stamps. A later re-measure
  that reads below this line is missing these, not correcting them.
- 2026-10-02 18:09 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule): from the ledger line above (next stamp at least
  `№ 10,656`), the replies ran on through the #1194 report `№ 10,656`
  (the closed-position cleanup, merged and read back), the "nothing open to
  merge" answer `№ 10,657` and the owner's "C·1 currency in SGD"; this PR
  (labels and provenance only, no value changed) carries it. The next stamped
  reply is at least **`№ 10,659`** plus any unstamped line made after this
  ledger. All lower bounds. The count is by replies, not by stamps. A later
  re-measure that reads below this line is missing these, not correcting them.
- 2026-10-02 18:43 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule): from the ledger line above (next stamp at least
  `№ 10,659`), the replies ran on through the outstanding list `№ 10,659`,
  the #1195 CI fix `№ 10,660` (the owner then merged #1195 at 18:24Z, as a
  merge commit) and the C·1/C·2/C·6 report `№ 10,661` (the tick shadow on
  profile 967c1def measured at PF 0.29–0.34; the owner's "research"
  followed). This PR (named segments for the replay research) carries it.
  The next stamped reply is at least **`№ 10,662`** plus any unstamped line
  made after this ledger. All lower bounds. The count is by replies, not by
  stamps. A later re-measure that reads below this line is missing these,
  not correcting them.
- 2026-10-02 19:04 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule): from the ledger line above (next stamp at least
  `№ 10,662`), the replies ran on through the #1196 report `№ 10,662`, the
  C·3 measurement `№ 10,664` (the verifier would send 344 alerts an hour
  against a 240 ceiling; muted since 27-09 with 512 held items; the
  dispose route not built), the #1196 merge `№ 10,667` (3f05ba2e, read back
  live) and three unstamped status lines. This PR carries Codex's two
  findings on #1196. The next stamped reply is at least **`№ 10,671`** plus
  any unstamped line made after this ledger. All lower bounds. The count is
  by replies, not by stamps. A later re-measure that reads below this line
  is missing these, not correcting them.
- 2026-10-02 19:23 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule): from the ledger line above (next stamp at least
  `№ 10,671`), the replies ran on through #1197 (Codex's two findings on
  #1196, merged 96ec17ce) and the C·3 verifier change this PR carries (quote
  liveness judged per feed; the dispose of the held backlog left to the
  owner), with unstamped status lines between. The next stamped reply is at
  least **`№ 10,676`** plus any unstamped line made after this ledger. All
  lower bounds. The count is by replies, not by stamps. A later re-measure
  that reads below this line is missing these, not correcting them.
- 2026-10-02 19:51 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule): from the ledger line above (next stamp at least
  `№ 10,676`), the C·3 report `№ 10,676`, #1198 merged (ec1f83dd) and read
  back `№ 10,681` (the verifier redeployed; two feed-level urgent incidents
  on the demo tick feeds, the per-stream flaps now warnings), and Codex's
  P1/P2 on #1198 carried by this PR, with unstamped status lines between.
  The next stamped reply is at least **`№ 10,686`** plus any unstamped line
  made after this ledger. All lower bounds. The count is by replies, not by
  stamps. A later re-measure that reads below this line is missing these,
  not correcting them.
- 2026-10-02 23:50 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule): from the ledger line above (next stamp at least
  `№ 10,686`), the replies ran on through the #1199 report `№ 10,686`, the
  C·3 rate after the change `№ 10,688` (8 would-send an hour, 0 urgent), the
  research job start `№ 10,691`, the C·6 job 1 result `№ 10,692` (636
  trials, no candidate, 19 stops per target), the #1179 read-back `№ 10,694`,
  the outstanding list `№ 10,695` (the owner switched the model to Sonnet
  for that reply and back after it) and the owner's sequence order; this PR
  carries the 03-10 plan. The next stamped reply is at least **`№ 10,698`**
  plus any unstamped line made after this ledger. All lower bounds. The
  count is by replies, not by stamps. A later re-measure that reads below
  this line is missing these, not correcting them.
- 2026-10-03 00:16 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule): from the ledger line above (next stamp at least
  `№ 10,698`), the 03-10 plan report `№ 10,698` (#1200, merged 00:11 UTC as
  81e181fa with the Saturday measurements), the owner's urgent order on the
  gateways' 429 `ingress_busy` / `recovered` pairs and its diagnosis
  `№ 10,701` (the scanner's try-lock held over the whole ingest, two
  gateways colliding on it). Five unstamped status lines followed while this
  PR was built (the tests, the TSan finding that moved the bound from a
  timed mutex to a condition variable, the three mutations, the #1200 merge,
  the gate), so the next stamped reply is at least **`№ 10,707`** plus any
  unstamped line made after this ledger. All lower bounds. The count is by
  replies, not by stamps. A later re-measure that reads below this line is
  missing these, not correcting them.
- 2026-10-03 01:12 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule): from the ledger line above (next stamp at least
  `№ 10,707`), eight unstamped status lines ran through #1201's CI, merge
  (4fced3ec, 00:23 UTC) and scanner deploy, so the read-back report was
  stamped **`№ 10,715`** (08:29 SGT); the owner's "investigate the code 28
  transport timeouts on cpp-acct" followed, nine unstamped status lines
  carried the flow-log measurements, and the diagnosis was stamped
  **`№ 10,725`** (08:51 SGT: every delivery's IPv6 attempt refused by the
  IPv4-only listener, fresh A+AAAA lookups per request, the three timeouts
  held 1.56 s inside an idle scanner). The owner's "build §10,725·C"
  followed; three unstamped lines preceded this ledger (the two-PR plan, the
  route wiring, the TSan re-run after my own sequencing error), so the next
  stamped reply is at least **`№ 10,729`** plus any unstamped line made
  after this ledger. This PR carries C·1 (the scanner's ingest timing).
  All lower bounds. The count is by replies, not by stamps. A later
  re-measure that reads below this line is missing these, not correcting
  them.
- 2026-10-03 01:31 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule): from the ledger line above (next stamp at least
  `№ 10,729`), ten unstamped status lines ran through #1202's build, gate
  and CI (the sandbox's missing IPv6, the gate re-run from the root, the
  second PR's drafts and their mutation checks, the Expect-header
  hypothesis measured and discarded), so the #1201 hour read-back and the
  §10,725·C status were stamped **`№ 10,739`** (09:29 SGT: zero 429 lines
  on either gateway in the hour; three new code-56 resets on cpp-acct,
  cause open). #1202 (C·1, the scanner's ingest timing) merged 01:30 UTC
  as 2d250d71. This PR carries C·2 and C·3 and restarts both gateways,
  cpp-verify and both scanners on the owner's "build §10,725·C". The next
  stamped reply is at least **`№ 10,740`** plus any unstamped line made
  after this ledger. All lower bounds. The count is by replies, not by
  stamps. A later re-measure that reads below this line is missing these,
  not correcting them.
- 2026-10-03 02:26 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule): from the ledger line above (next stamp at least
  `№ 10,707`), the replies ran on through the #1201 report and its 429
  read-back `№ 10,739` (zero 429 on both gateways in the hour after the
  deploy), the code-28 diagnosis `№ 10,725` and the owner's "build
  §10,725·C", #1202 (C·1 scanner ingest timing) and #1203 (C·2 curl handle
  reuse + phase timings, C·3 dual-stack listener) merged on "merge when green
  and read back the gateways", `№ 10,740`, and sixteen unstamped status
  lines (the gates, the merges, the five deploy read-backs, the HTTP 400
  finding on cpp-acct and this PR's build), so the next stamped reply is at
  least **`№ 10,757`** plus any unstamped line made after this ledger. One
  working-tree mistake in this run is recorded: a mutation loop restored
  `scanner.cpp` with `git checkout`, which also erased the uncommitted edit;
  it was re-applied and the loop re-run from a saved copy. All lower bounds.
  The count is by replies, not by stamps. A later re-measure that reads below
  this line is missing these, not correcting them.
- 2026-10-03 05:53 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule): from the ledger line above (next stamp at least
  `№ 10,757`), the replies ran on by count through the #1203 read-back
  `№ 10,757`, #1204 (the scanner names an invalid feed batch) `№ 10,761`,
  #1205 (Codex's P2 on it) `№ 10,770`, the outstanding list `№ 10,772`, the
  build sequence `№ 10,773`, the 03:41Z check-in `№ 10,774`, the step-1 reads
  and the owner's eight answers `№ 10,777`, the grid start and the 1.5R
  finding (all four rows already closed) `№ 10,784`, and the grid result and
  the refused retire apply `№ 10,790` (the exits grid: nine points, 477
  trials, none pass; the compare-and-set on the scanner registry was refused
  to the agent by the permission classifier, the bridge restored, the payload
  left in docs/ for the owner). Unstamped status lines between them are in the
  count. This PR (#1206, the Sunday bundle: §4-D/§5/§6 horizon, C·1 PR-2 FX
  rate table, the #101 fixes, the P5b row route, the docs catch-up) was built
  by four lane agents in worktrees and integrated by cherry-pick; gate green
  on the integrated tree. The next stamped reply is at least **`№ 10,798`**
  plus any unstamped line made after this ledger. All lower bounds. The count
  is by replies, not by stamps. A later re-measure that reads below this line
  is missing these, not correcting them.
- 2026-10-03 07:15 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule): from the ledger line above (next stamp at least
  `№ 10,798`), the replies ran on by count through the #1206 merge and
  read-back `№ 10,818` (14:25 SGT: horizon backfill 52 rows, SGD FX on
  …3489/…7342 verified), the queue answer `№ 10,820`, and the owner's
  "remove all three and fix the JNJ row, then draw the architecture
  diagram" (14:3x SGT). This PR carries it: the breaker's auto-disarm
  removed, the MAE/Chandelier observer removed, cpp-verify's Telegram
  delivery channel removed (the watchdog is a record), the P&L rule that
  a verdict is about one close (#1489 JNJ.US …0058 is reset at boot and
  settled from the deal history), and `docs/architecture-2026-10-03.html`
  (published as an Artifact). Built by three lane agents in worktrees,
  cherry-picked, gated on the integrated tree. Three unstamped status
  lines followed `№ 10,820` by this ledger, so the next stamped reply is
  at least **`№ 10,824`** plus any unstamped line made after this ledger.
  All lower bounds. The count is by replies, not by stamps. A later
  re-measure that reads below this line is missing these, not correcting
  them.
- 2026-10-03 09:13 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule): from the ledger line above (next stamp at least
  `№ 10,824`), the #1207 merge and read-back `№ 10,824` (15:46 SGT: JNJ
  #1489 settled at −63.58, the observer route 404, the breaker config
  without auto-disarm, the verifier's channel none), the live-gateway
  diagnosis `№ 10,826` (15:58 SGT: payload-2164 account-disconnect events
  at 07:30Z, the session kept "connected" with no reconcile; broker side
  recovered ~07:45Z), #1208 (Codex P1 on the supersede query) merged under
  the standing policy, the owner's "restart cpp-acct and build it" (the
  restart at 08:07:58Z, authenticated 3/3 at 08:09:08Z, heartbeat ok at
  08:11:00Z) and this PR. One commit mistake is recorded: 93d12a53 was cut
  while a mutation check had its first mutation applied to the working tree,
  so it carried the mutated line; d9da9061 restored it and the gate ran on
  the restored tree. Unstamped status lines between the stamps are in the
  count, so the next stamped reply is at least **`№ 10,836`** plus any
  unstamped line made after this ledger. All lower bounds. The count is by
  replies, not by stamps. A later re-measure that reads below this line is
  missing these, not correcting them.
- 2026-10-03 10:20 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule): from the ledger line above (next stamp at least
  `№ 10,836`), the replies ran on by count through the #1209 CI wait, the
  architecture-page correction `№ 10,842` (the page said the code default,
  5 min; production runs the Tune setting, 1 min; corrected and republished),
  the #1209 merge (f539ff0a, 09:31Z) and read-back `№ 10,848` (cpp-acct
  authenticated 3/3 at 09:33:16Z; the demo broker refused every demo session
  with CANT_ROUTE_REQUEST from 09:32:01Z to 09:41:13Z, seen by the unchanged
  verifier too, so broker-side), and the Codex P1 on #1209 `№ 10,851` (the
  reconcile sweep discarded a secondary account's refusal), which this PR
  carries. Unstamped status lines between them are in the count, so the next
  stamped reply is at least **`№ 10,858`** plus any unstamped line made after
  this ledger. All lower bounds. The count is by replies, not by stamps. A
  later re-measure that reads below this line is missing these, not
  correcting them.
- 2026-10-03 12:50 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule): from the ledger line above (next stamp at least
  `№ 10,858`), the replies ran on by count through the #1210 merge and
  read-back `№ 10,864`, the three architecture-page docs PRs #1211–#1213
  (`№ 10,866`, `№ 10,871`, `№ 10,873`, `№ 10,876`, `№ 10,878`, `№ 10,881`;
  Codex's three findings each fixed in the next PR), the outstanding-items
  investigation `№ 10,884` (production measured read-only: PF 0.78 over 294
  closes in 30 days, 79% of losses from initial stops, longs PF 0.47 against
  shorts 1.77, the bad_rr<3 gate refusing setups that would have paid; no
  outstanding engineering item moves profit), the owner's questions answered
  at `№ 10,885` (V3 built, not accepted; 10 Oct with one live account; the
  front login; the README moved to docs/1st_README.md in #1214), and the
  owner's "yes to the four replays and the login gate, go ahead". This PR
  carries the login gate. Unstamped status lines between the stamps are in
  the count, so the next stamped reply is at least **`№ 10,891`** plus any
  unstamped line made after this ledger. All lower bounds. The count is by
  replies, not by stamps. A later re-measure that reads below this line is
  missing these, not correcting them.
- 2026-10-03 13:22 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule): from the ledger line above (next stamp at least
  `№ 10,891`), the replies ran on by count through the replays report
  `№ 10,902` (21:07 SGT: D1 no support for a wider stop, D2 not measurable,
  D3 the gate's own rr admits none at 3.0 and real money says do not lower
  it, D4 three strategies OFF pooled; five record defects R1–R5), #1216
  merged (5ebe5514, a merge commit, not a squash: the API was asked for
  squash and GitHub recorded a merge; the Conversation ref lives in the PR
  body and in 9f5ed09c) and read back clean (icon 200, the sign-in page
  with no app shell, the bearer model intact, 43 controllers ok), and the
  owner's "merge when green and read back, then build R1 and R2". R2 was
  traced read-only before anything was built: every one of the seven
  "bypass" cells was hand-pinned when its trades opened and unpinned
  afterwards by the edge watchdog or the breaker (arming log), and the
  stage matrix refuses those cells upstream of the evidence gate, so the
  zero was structural, not a bypass. This PR carries R1 (the ledger replays
  the gate's stop and records the unit; the goal reads known-unit rows) and
  R2 (the evidence-gate report shows a shadow cell's upstream skips, its
  last pin change and `whyZero`). Fourteen unstamped status lines followed
  `№ 10,902`, so the next stamped reply is at least **`№ 10,917`** plus any
  unstamped line made after this ledger. All lower bounds. The count is by
  replies, not by stamps. A later re-measure that reads below this line is
  missing these, not correcting them.
- 2026-10-03 13:50 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule): from the ledger line above (next stamp at least
  `№ 10,917`), the replies ran on by count through #1217's gate, merge
  (bf22bc06, squashed) and read-back, and the R1/R2 report **`№ 10,930`**
  (21:34 SGT: all 756 scored refusals of the week now read as legacy, the
  goal not measurable until rows score in the gate's unit; the 14 shadow
  cells read 11 refused upstream and 3 unpinned recently). The owner's
  "build R3, R4 and R5, merge when green and read back" followed; this PR
  carries them: R3 the pooled money guard reads the broker-verified deposit
  currency (the registry's base_currency is NULL on every account) and a pool
  with no known unit publishes no money figure; R4 one helper
  (`trendReadingFor`) stamps the trend reading on every entry path; R5 the
  2m and 10m horizons. Seven mutations, each red on a named test. One
  unstamped status line followed `№ 10,930`, so the next stamped reply is at
  least **`№ 10,932`** plus any unstamped line made after this ledger. All
  lower bounds. The count is by replies, not by stamps. A later re-measure
  that reads below this line is missing these, not correcting them.
- 2026-10-03 14:50 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule): from the ledger line above (next stamp at least
  `№ 10,932`), the replies ran on by count through the R3/R4/R5 merge and
  read-back (#1218) and the three Railway logs assessment `№ 10,944`
  (22:24 SGT: the "errors" are #1203's slow-request line plus known broker
  refusals; cpp-verify's `/watchdog-status` is the heaviest request, 9.6 s
  worst against Node's 10 s abort; the incident record at 1,686 of 2,048).
  The owner's "build D1 and D3, merge when green and read back" followed; two
  unstamped status lines preceded this ledger, so the next stamped reply is at
  least **`№ 10,948`** plus any unstamped line made after it. This PR carries
  D1 (a slim `/watchdog-status`, `stateBytes` from the last persist) and D3
  (resolved incidents evicted at the bound, `no_orders` closed after a day and
  kept 7, an occupancy beat at 80%). All lower bounds. The count is by
  replies, not by stamps. A later re-measure that reads below this line is
  missing these, not correcting them.
- 2026-10-03 15:20 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule): `№ 10,949` (PR #1219 open) and `№ 10,950` (#1219 merged as
  1e0ed7ec; the verifier deploy a6314c81 SUCCESS) are right by count. The
  read-back found two flaws in my own D3, corrected in the next PR: the beat
  judged the TOTAL record (1,682 kept, 9 active, so red for no reason) where it
  should judge ACTIVE incidents, and a no_orders notice's retention clock
  restarted at its close instead of its opening. The relayed reply is 16 KB
  (was about 1 MB). Four unstamped status lines preceded this ledger, so the
  next stamped reply is at least **`№ 10,955`** plus any unstamped line made
  after it. All lower bounds. The count is by replies, not by stamps. A later
  re-measure that reads below this line is missing these, not correcting them.
- 2026-10-03 21:45 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule): `№ 10,955` (#1220 open) is right by count; the #1220 merge
  and read-back report was `№ 10,956` (23:41 SGT: Node half confirmed, verifier
  build still running), the verifier read-back `№ 10,957` (23:53 SGT: total
  1,682 to 1,655, 9 active, heartbeat ok), the slow-request booking `№ 10,958`
  (its stamp read "05:30 SGT 04-10", the clock then read 21:30 UTC, which is
  05:30 SGT: right), the slow-request read `№ 10,959` (`/watchdog-status` worst
  655 ms against 9.6 s) and the outstanding list `№ 10,960`. The owner then
  ordered this handover (`docs/handover-2026-10-04.md`); the next stamped
  reply is at least **`№ 10,962`** plus any unstamped line made after this
  ledger. All lower bounds. The count is by replies, not by stamps. A later
  re-measure that reads below this line is missing these, not correcting them.
- 2026-10-06 22:10 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule; the container restarted in between and came back without
  node_modules): from the ledger line above (next stamp at least `№ 10,962`),
  the replies ran on by count through the handover #1221, the MAE/Chandelier
  confirmation `№ 10,965` (wrong on one point and corrected in the addendum
  #1223: `mae_r`/`mfe_r` are still persisted every loop and fast tick), the
  owner's rebase **"Now the number is № 11,571 · 7 October 05:05 SGT"**
  (adopted as a supplied rebase, the way the 8,325 line was), the three-cpp
  investigation `№ 11,573` (every error-level line is #1203's slow-request
  diagnostic; two silent demo tick feeds; position 1722's management
  stalled), the Codex-coordination answers and the stop-loss verification
  **`№ 11,583`** (05:38 SGT 07-10: Opposite trigger Passed on all 7, MAE/MFE
  Passed on every managed row, the Chandelier since-entry trail FAILED
  outside the selected account …0949, the engine-side spec Not Verifiable).
  **Two agents counted one sequence**: Codex stamped its own `№ 11,582` and
  `№ 11,583` at 05:38 SGT from the same rebase, so 11,572–11,583 were used
  twice; by replies made the dialogue was at least `№ 11,595`, the next stamp
  was taken as **`№ 11,596`** (05:40 SGT), and from then on each agent
  ratchets on the highest stamp it can see, the session name on the stamp.
  This PR carries ¶11,583·D·1 (the guardian sweeps every enabled registered
  account on both sides with one trail-config union per side, and a backstop
  sweep) and `GET /state/trail-status` (the engine-side read). Two unstamped
  status lines followed `№ 11,596`, so the next stamped reply is at least
  **`№ 11,599`** plus any unstamped line made after this ledger. All lower
  bounds. The count is by replies, not by stamps. A later re-measure that
  reads below this line is missing these, not correcting them.
- 2026-10-06 22:40 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule): from the ledger line above (next stamp at least
  `№ 11,599`), the replies ran on by count through the interim report
  `№ 11,602` (06:02 SGT: built, not merged), the gate report `№ 11,609`
  (06:16 SGT), the owner's "merge when green" and "continue with next fix",
  #1243 merged (31ad4b14, 22:22Z) and read back `№ 11,614` (06:37 SGT: the
  sweep covers every demo account with positions, one union per side; the
  demo gateway refuses every union and `/state/trail-status` reads
  `enabled:false` there, so `TRAIL_TICK_ENABLED` is not the literal `true`
  in the running demo gateway and the engine-side Chandelier has not been
  active on it; the live side pushes nothing, holding nothing). Unstamped
  status lines between the stamps are in the count. This PR (#1245) carries
  F·1 (the shared sidecar HTTP server's slow-request line to stdout, stderr
  only past 5 s, four byte-identical copies) and the named `/trail-config`
  refusal (recorded, logged, read back); it redeploys both gateways and
  waits for the owner's word. The next stamped reply is at least
  **`№ 11,615`** plus any unstamped line made after this ledger. All lower
  bounds. The count is by replies, not by stamps. A later re-measure that
  reads below this line is missing these, not correcting them.
- 2026-10-07 00:35 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule): from the ledger line above, the replies ran on by count
  through the #1245 gate report `№ 11,623`, the owner's "merge when green",
  Codex's P1 on #1245 (the keeper never throws: `trailSpecsComplete`), #1245
  merged (62276a2c, 00:10Z) and read back: all six services up, and the
  named refusal measured `TRAIL_TICK_ENABLED not set` on the demo gateway
  (`№ 11,659`, 08:18 SGT). **Codex's stamps ran ahead again** (its #1244
  commit reads № 11,656), so the ratchet took `№ 11,657` for the decisions
  answer. The owner's answers: remove the gate (this PR: the TrailEngine on
  by default, explicit false opts out), no live-account decision yet, the
  `agent-locks` branch yes, fix the goal-tracker flake (this PR), EXEC_SECRET
  explained. The next stamped reply is at least **`№ 11,661`** plus any
  unstamped line made after this ledger. All lower bounds. The count is by
  replies, not by stamps. A later re-measure that reads below this line is
  missing these, not correcting them.
- 2026-10-07 02:55 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule): from the ledger line above (next stamp at least
  `№ 11,661`), the replies ran on by count through #1246 (the TrailEngine on
  by default, the goal-tracker test hardened, the Card ⇲ overlay portalled to
  document.body; merged a1a2f679 on "merge when green", 01:18Z) and its
  read-back **`№ 11,688`** (09:24 SGT): the demo gateway now refuses with
  `TRAIL_TICK_ENABLED=false`, so the variable is SET to the literal `false`
  on both gateways (Railway lists it on cpp-exec and cpp-acct; values
  redacted here) and the engine is still off — a gateway config change,
  ask-first under P7, not touched. The stamp "№ 11,670" was `№ 11,680` by
  count and the merge commit's "reported № 11,671" is behind; recorded, not
  carried. Codex P1 on #1246 (two stop writers, the keeper's amend sent
  blind against its pass's snapshot) is what this PR carries: the keeper's
  and the trade guard's stop amends are ratchet transactions on the sidecar
  (`ratchetOnly`, direction and symbol identity; the broker's stop re-read
  under the position's lock the TrailEngine's amends take; `unchanged` is
  counted, not announced, and the row takes the broker's confirmed stop),
  and a ratchet amend has no JS fallback. Six mutations, each red on a named
  test. The next stamped reply is at least **`№ 11,694`** plus any unstamped
  line made after this ledger. All lower bounds. The count is by replies, not
  by stamps. A later re-measure that reads below this line is missing these,
  not correcting them.
- 2026-10-07 03:58 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule): from the ledger line above (next stamp at least
  `№ 11,694`), the replies ran on by count through the #1248 report
  `№ 11,694` (10:54 SGT), the next-things list `№ 11,704`, #1248 merged
  0aca9fca (11:52 SGT, gate green on the merged tree, main had moved under
  it by Codex's #1247) and the owner's four orders: ¶B·1 and ¶B·2 (the
  TrailEngine variable on both gateways), ¶C·1 (the two silent demo tick
  feeds) and ¶C·2. The Railway MCP has no variable delete, so
  `TRAIL_TICK_ENABLED` was SET to the literal `true` on cpp-exec (03:54Z,
  redeployed, "tick-level trail engine started") and then on cpp-acct
  (03:57Z): the demo side read `enabled: true`, `lastPushRefusal: null`,
  5 tracked across three demo accounts, and the Node log's first
  `pushed for the demo side (accepted)` at 03:55:02Z — the first accepted
  union since 02-10. Codex P1 on #1248 (the trade guard's identity symbol
  from the shared map, not the account's snapshot) is what this PR
  carries; mutation M7 red. The next stamped reply is at least
  **`№ 11,713`** plus any unstamped line made after this ledger. All lower
  bounds. The count is by replies, not by stamps. A later re-measure that
  reads below this line is missing these, not correcting them.
- 2026-10-07 04:50 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule): from the ledger line above (next stamp at least
  `№ 11,713`), the replies ran on by count through the four-order report
  `№ 11,724` (12:11 SGT: ¶B·1/¶B·2 live; ¶C·1 diagnosed — the registry
  anchors 796 profiles on accounts the gateways do not stream from — and
  the re-anchor payload built, 902→796, revision a8a740a9; the classifier
  refused the compare-and-set flow after `SCANNER_BRIDGE_ENABLED=0` had
  gone through), the owner's deletion of `TRAIL_TICK_ENABLED` on both
  gateways read back `№ 11,728` (both sides `enabled: true`), the bridge
  answer `№ 11,734` (set it back to 1, which the owner did), the refused
  POST and the note to Codex `№ 11,736` (on `agent-locks` and #1249), and
  #1249 merged a626227d (12:31 SGT) under the standing policy. Codex P1 on
  #1249 (the guard's quote and pip metadata still read with the shared
  map's id; the identity fix alone would let a wrong-instrument stop land
  on a non-selected account) is what this PR carries; mutation M8 red. The
  registry POST remains the owner's. The next stamped reply is at least
  **`№ 11,746`** plus any unstamped line made after this ledger. All lower
  bounds. The count is by replies, not by stamps. A later re-measure that
  reads below this line is missing these, not correcting them.
- 2026-10-07 06:00 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule): from the ledger line above (next stamp at least
  `№ 11,746`), the replies ran on by count through the #1250 report
  `№ 11,749` (12:49 SGT), #1250 merged 18cacd4e (13:00 SGT, `№ 11,755`),
  the "any more?" list `№ 11,758` (13:47 SGT: the registry still at
  5bd5533f with 902 profiles — the re-anchor POST not run; push cadence cap,
  position 1722, the ⇲ check and the ledger tail named) and the owner's
  "¶B·1 Run, ¶C·1 Push cadence cap". The POST was refused to the agent
  twice by its permission classifier (04:04Z and 04:30Z) with the
  instruction not to pursue the same outcome again, so it was NOT
  re-attempted; it is the owner's. This PR carries ¶C·1: a side's
  trail-config union is pushed when its digest changed (set, distance,
  digits, direction, symbol, target, entry; not currentSl or peakPrice,
  which the engine keeps itself) or when 60 s passed since the last
  accepted push; a refused push is retried on the next sweep; the sweeps
  themselves run as before. Mutations M9–M11 red. The CLAUDE.md tail
  carries two Codex continuation blocks after this ledger block; left as
  written by Codex. The next stamped reply is at least **`№ 11,762`** plus
  any unstamped line made after this ledger. All lower bounds. The count is
  by replies, not by stamps. A later re-measure that reads below this line
  is missing these, not correcting them.
- 2026-10-07 06:12 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule): the line above was WRITTEN at 05:52 UTC and stamped
  "06:00" (a guessed time, the §2 failure; disclosed at № 11,768·C). From
  it (next stamp at least `№ 11,762`), the replies ran on by count through
  the ¶B·1/¶C·1 report `№ 11,768` (13:54 SGT: the registry POST refused
  to the agent twice and not re-attempted; #1253 built; main merged in
  after Codex's #1251 replaced the #1250 fallback with a refusal), #1253
  merged f0d5764a (14:06 SGT) and read back (06:09:26Z: "accepted; 5
  unchanged sweep(s) since the last push" — from every 4–8 s to about one
  push a minute, the distance's ATR refresh being the change), the "merge
  once green" and "what else" answers `№ 11,779`–`№ 11,782`. Codex P1 on
  #1253 (a spec built before the keeper's own stop amend carries no stop;
  the engine arms only on a push with a real stop; the digest withheld
  that push for up to 60 s) is what this PR carries: whether a stop is
  known joins the digest, its value still does not; mutation M12 red. The
  registry still reads 5bd5533f / 902 — the POST is the owner's. The next
  stamped reply is at least **`№ 11,784`** plus any unstamped line made
  after this ledger. All lower bounds. The count is by replies, not by
  stamps. A later re-measure that reads below this line is missing these,
  not correcting them.
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

### Continuation ledger — 22 September 2026

- 2026-09-24 14:27 UTC, **Codex desktop, PARTIAL corpus**: the count script
  still reports 8, below the established rebase. Visible replies continued
  through **№ 8,862** while #1072 passed, merged and was observed in production,
  the supplied flow-kit source was recovered, and the bounded P1/P4 history
  query correction passed focused tests and synthetic migration/report checks.
  The next reply is **№ 8,863**. This is the carried transcript ratchet, not a
  complete-corpus measurement. Later visible replies take precedence.

The Work Mode corpus remains partial. Continued from the recorded rebase and
visible replies through **`№ 8,424`**, 19:27 SGT, during revision-3 P0–P5 work.
The next substantive reply is `№ 8,425`. No full-corpus or token count is claimed.

- 2026-09-22 11:53 UTC, continuation executor, partial transcript corpus:
  last visible reply **№ 8,429**; next reply **№ 8,430**. Continued from the
  recorded rebase and visible replies; not a full-corpus measurement.

- 2026-09-22 12:25 UTC, continuation executor with partial transcript corpus:
  last visible reply **№ 8,438**; next **№ 8,439**. The recorded rebase plus
  visible continuation replies was used, not an unavailable full-corpus reading.

- 2026-09-22 17:32 UTC, Work Mode continuation with partial transcript corpus:
  continued from the recorded 8,438 and visible replies through **№ 8,464**;
  next **№ 8,465**. Full-corpus measurement remains unavailable.

- 2026-09-22 23:02 UTC, Work Mode continuation with partial transcript corpus:
  visible continuation replies through **№ 8,490**; next **№ 8,491**.
  No full-corpus count is claimed.

- 2026-09-22 23:50 UTC, Work Mode continuation with partial transcript corpus:
  visible replies through **№ 8,503**; next **№ 8,504**. Workspace is offline;
  this follows the recorded rebase and visible replies, not a full-corpus count.

- 2026-09-23 01:56 UTC, Work Mode continuation with partial transcript corpus:
  visible replies through **№ 8,548**; next **№ 8,549**. Continued from the
  recorded rebase and visible replies, not a full-corpus measurement. #1030,
  #1031 and #1032 are merged and all four deployments verified. Authenticated
  acceptance remains blocked after the secure connection was interrupted.

- 2026-09-23 02:53 UTC, Work Mode continuation with partial transcript corpus:
  visible replies through **№ 8,563**; next **№ 8,564**. The owner completed
  sign-in; authenticated scope acceptance found and verified the #1033 fix.
  Count follows the recorded rebase and visible replies, not a full-corpus read.

- 2026-09-23 03:05 UTC, Work Mode continuation with partial transcript corpus:
  visible replies through **№ 8,570**; next **№ 8,571**. #1033 and #1034 merged
  and deployed; authenticated reporting behavior passed with explicit remaining
  cashflow/P&L data gaps. Count follows visible replies, not a full-corpus read.

- 2026-09-23 04:27 UTC, Work Mode continuation with partial transcript corpus:
  visible replies through **№ 8,598**; next **№ 8,599**. The #1037 local gate
  and unchanged-commit CI retry passed; native parity work continues. Count
  follows the recorded rebase and visible replies, not a full-corpus reading.

- 2026-09-23 07:29 UTC, Work Mode continuation with partial transcript corpus:
  checkpoint through **№ 8,647**; next **№ 8,648**. This records the visible
  continuation sequence, not an unavailable full-corpus measurement. #1042 is
  prepared and updated; native default coverage is under final integrated gate.

- 2026-09-23 04:57 UTC, Work Mode continuation with partial transcript corpus:
  visible replies through **№ 8,609**; next **№ 8,610**. #1037 cashflow
  readback passed on seven accounts; #1038 is merged and deploying. Count
  follows the recorded rebase and visible replies, not a full-corpus reading.

- 2026-09-23 08:59 UTC, fresh Work Mode continuation with no accessible
  transcript corpus: the counting script found no JSONL files. The owner supplied
  checkpoint 8,636; visible continuation replies have reached **8,645**. This is
  that supplied rebase plus visible replies, not a full-corpus measurement.
  Later visible replies take precedence. No agent/token totals are inferred.


- 2026-09-23, Work Mode continuation, PARTIAL corpus: the counting script
  found no JSONL transcripts. Continued the supplied rebase through replies
  **№ 8,655–8,658**, including the initial unstamped continuation update.
  This records visible replies, not a new full-corpus measurement.

- 2026-09-23 17:12 UTC, Work Mode partial-corpus continuation: visible prior
  checkpoint was **№ 8,709**; the current merge continuation reached **№ 8,720**,
  next **№ 8,721**. No transcript corpus or agent/token totals are inferred.
  #1046 and #1049–#1052 are merged after review corrections and green gates.
  #1048 remains held: the newly demonstrated caller-retry correction additionally
  restarts both broker gateways and needs the scoped release approval. Scanner
  feeds, trading activation, credentials and notification permission are unchanged.

- 2026-09-23 23:19 UTC, Work Mode partial-corpus handover: visible replies
  reached **№ 8,752**, next **№ 8,753**. No JSONL corpus was available; this
  follows the recorded checkpoint and visible continuation, not a full-corpus
  measurement. #1053 and #1054 are merged. Main is `391d5a2`; its Node
  deployment succeeded, but production acceptance remains unfinished. The
  handover records newly attributed synchronous report stalls and current
  independent coverage. No agent/token totals are inferred.

- 2026-09-24, Codex desktop continuation, PARTIAL corpus: the repository
  counting script returned 8, below the recorded rebase, and was not adopted.
  The owner-supplied attachment starts at **№ 8,774**. Counting this task's
  recorded assistant text replies continued through **№ 8,800** at 20:38 SGT;
  later visible replies take precedence. This is supplied rebase plus local
  continuation, not a full-corpus measurement. The owner froze the eight V3
  closure groups, selected partial TP1 plus runner (numerical policy still
  outstanding), and confirmed seven connected accounts/four demo/three live.
  No total agent/token count is inferred. `.claude/rules/flow.md` was absent
  from current main and searched local copies; its location was requested.

- 2026-09-24 12:57 UTC, Codex desktop partial-corpus continuation: the local
  task transcript contains 34 assistant text messages after the supplied 8,774
  rebase. The latest visible stamp is **№ 8,809**: one display serial was
  skipped after the unstamped **№ 8,806** acknowledgement. Preserve the display
  ratchet at **№ 8,810** next; later visible replies take precedence. This
  records the discrepancy, not a fabricated full-corpus count. The owner
  approved continued building; numeric partial-TP1 policy values and fresh
  authenticated release preflight remain outstanding.

- 2026-09-24 13:27 UTC, Codex desktop partial-corpus continuation: visible
  replies reached **№ 8,830**, next **№ 8,831**; later replies take precedence.
  The owner restored browser authentication and merged #1070 (`80945cb`).
  Node deployment and bounded recovery were verified separately. Authenticated
  account acceptance demonstrated the P2 entry-control identity defect now
  under correction. Numerical partial-TP1 policy remains outstanding. This
  follows the recorded rebase and visible replies, not a full-corpus count.

- 2026-09-24 13:41 UTC, Codex desktop partial-corpus continuation: visible
  replies continued through **№ 8,839**; the closing report is **№ 8,840**,
  next **№ 8,841**; later visible replies take precedence. #1071 passed its
  full gate, was merged under standing approval as `e60064c`, and deployed.
  Production controls and protection/configuration preservation were checked;
  startup latency failure remains open despite subsequent normal recovery.
  The eight V3 groups remain frozen and numerical partial-TP1 policy is still
  outstanding. This local ledger write-back is intentionally uncommitted to
  avoid a documentation-only Node restart. It is not a full-corpus recount.

- 2026-09-24 14:02 UTC, Codex desktop resumed continuation: visible replies
  reached **№ 8,844**, next **№ 8,845**; later visible replies take precedence.
  The first resumed reply, № 8,841, carried the prior 21:42 display time;
  the fresh clock read was 13:57:52 UTC (21:57 SGT). Subsequent stamps use it.
  The owner asked to continue toward tonight's V3 closure. The demonstrated
  61.7-second synchronous account report is under correction within P1/P4;
  target-policy values remain requested, not invented. The previous local
  ledger write-back is carried with this source change, not a separate restart.

- 2026-09-24 14:47 UTC, Codex desktop partial-corpus continuation: visible
  replies reached **№ 8,880**; the closing report is **№ 8,881**, next
  **№ 8,882**. The script still reads 8, so this follows the established
  transcript ratchet, not a complete-corpus measurement. #1072 and #1073
  passed their gates, merged and deployed. Final #1073 readback at 14:46:11Z
  preserves seven-account protection/configuration and five native deployments;
  startup performance remains Failed despite later routine recovery. The
  supplied flow-kit source was read in the requested order and recovered;
  no installer, permissions, hooks or approval records were changed. The eight
  groups and pending partial-TP1 policy values remain unchanged. This local
  write-back is for the next code PR, not a documentation-only Node restart.

- 2026-09-25 03:40 UTC (11:40 SGT), **Codex → Claude Code takeover**, remote
  container, PARTIAL corpus. Owner: *"record this date and time that codex
  runs out of token to build. claude code to take over the complete the latest
  assessment plan. the goal of parallel scanners both tick and time should be
  active now"*. Codex's last visible reply was **№ 9,006** (25-09 08:40 SGT);
  its dual-entry build was local and unpushed and is not on any remote ref at
  the 03:40 UTC fetch, so Claude rebuilds it from `origin/main` `83c94e6` and
  assumes nothing from it. Claude's replies in this container continued from
  **№ 9,007** to **№ 9,033** (the takeover acknowledgement; two unstamped status lines, № 9,031–9,032, preceded it); the next reply is
  `№ 9,034`. Claude Code is now the single implementation session. The record
  is `docs/claude-takeover-2026-09-25.md`; the plan it completes is
  `docs/dual-environment-plan-2026-09-25.md`. A later re-measure that reads
  below this line is missing these, not correcting them.

- 2026-09-25 08:24 UTC, **same remote container, PARTIAL corpus**: from the
  takeover line above, the replies ran on by count through the 13:10 SGT daily
  report `№ 9,041`, the status/flags reply `№ 9,048`, the cancel-and-continue
  reply `№ 9,052`, the 15-minute update `№ 9,054` and the #1085 read-back
  `№ 9,059` (the unstamped status lines between them counted by replies). #1085
  (dual admission, WP-A) was merged by the owner at 08:21 UTC and read back:
  `1b54c1f` live, all 7 accounts TIME_BASED/STABLE/bar, 0 errors, 32 positions
  protected. The owner cancelled CADJPY and GBPJPY on …0058 (gone 07:47:42 UTC).
  The next reply is `№ 9,060`. A later re-measure that reads below this line is
  missing these, not correcting them.

- 2026-09-25 23:19 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule): the script reads this container's transcript only and was
  refused as a reading. From `№ 9,060` the replies ran on by count to the
  reply stamped **`№ 9,232`** (14:31 UTC). The container restarted ~15:50 UTC;
  the transcript here then captures **187** text replies after `№ 9,232`, all
  unstamped status lines of the owner's overnight order (25-09 21:30 SGT:
  auto-merge on green, flags only, report at 08:00 SGT): the harvest of the
  stopped lanes, the X1 window (22:35 UTC: cpp-acct volume, gateway variables,
  GW-CAP, X1, scanner activation with 796 profiles), and the merges #1107–#1125
  (I2, T1b, the veto-boundary fixture, I3, CV-1, GW-CAP, X1, L1c, WEB-3, V1, T2,
  WEB-9b, WEB-1, B1, L2b, WEB-5, M2b, WEB-4, L2a). The last reply before this
  ledger is **`№ 9,420`**, so the next stamped reply is **`№ 9,421`** plus any
  unstamped line made after it. The count is by replies, not by stamps. A
  later re-measure that reads below this line is missing these, not correcting
  them.

- 2026-09-25 13:21 UTC, **same remote container, PARTIAL corpus**: from
  `№ 9,060` the replies ran on by count through the V3 build waves, the
  roadmap v1 (20:37 SGT), the 8,989-A verification, the "are you certain?"
  answer `№ 9,172`, the roadmap v2 with planned vs actual `№ 9,184` and the
  L1 read-back `№ 9,186` (21:13 SGT); #1089–#1095 merged (M2, A1, T1, Q1, B3,
  Q4b, L1 — L1 by the owner at 13:09 UTC with its three checker blockers
  open, fixed by this PR). The context was then compacted; the transcript
  captures twelve text replies after `№ 9,186`, so the next stamped reply is
  **`№ 9,199`** plus any unstamped line made after this ledger. The count is
  by replies, not by stamps. A later re-measure that reads below this line is
  missing these, not correcting them.

- 2026-09-26 01:20 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule): the script reads this container's transcript only and was
  refused as a reading. The 08:00 SGT report was stamped `№ 9,440` and the
  owner-request analysis (sidebar, Reasons, AI page) `№ 9,477` (08:20 SGT
  26-09). The transcript captures 38 text replies after it, all unstamped
  status lines: K1b #1138 merged and read back (every demanded calendar
  resolved), WEB-8 #1139 and B4 #1140 checked, fixed, merged and read back,
  the K1c lane and its fix round, and the owner's request 2 (Performance
  cards, strategy review, historical data) with its plan workflow launched.
  So the last reply before this ledger is **`№ 9,515`** and the next stamped
  reply is **`№ 9,516`** plus any unstamped line made after this ledger. The
  count is by replies, not by stamps. A later re-measure that reads below this
  line is missing these, not correcting them.

- 2026-09-26 07:05 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule; the container restarted ~04:49 UTC in between): the script
  reads this container's transcript only and was refused as a reading. From
  `№ 9,516` the replies ran on by count through K1c #1141, WEB-8b #1142, B4b
  #1144 and B4c #1145 (merged and read back), the owner-request plan (#1143,
  merged by the owner at 04:46 UTC), the "150 bars is ours, not cTrader's"
  correction `№ 9,572`, the integrated plan's draft `№ 9,596`, the model and
  budget answer `№ 9,602`, the 13:10 SGT daily report `№ 9,614`, the Wave 1
  start `№ 9,619` (the owner: "I thought the plan is approved"), the report of
  the diverted first Wave 1 run `№ 9,625`, and the inventory `walk()` fix
  `№ 9,636` (14:40 SGT). One reply is not in the transcript as text: `№ 9,628`
  (the 14:29 SGT interval report, sent beside a tool call); it is counted by
  replies made, not by what the file captured. Two unstamped lines followed
  `№ 9,636` (W1.1's PR prepared; its stale index restored), so the last reply
  before this ledger is **`№ 9,638`** and the next stamped reply is
  **`№ 9,639`** plus any unstamped line made after this ledger. The count is
  by replies, not by stamps. A later re-measure that reads below this line is
  missing these, not correcting them.

- 2026-09-26 09:22 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule): the script reads this container's transcript only and was
  refused as a reading. From `№ 9,639` the replies ran on by count through the
  Wave 1 merges #1147–#1153 (W1.1, W1.2, W1.6, W1.4, W1.7, the history-check
  follow-up #1152, W1.3), the 20-minute reports `№ 9,667`, `№ 9,690`,
  `№ 9,704` and `№ 9,715`, and the BTCUSD history answers `№ 9,686` and
  `№ 9,699` (the monthly series starts with the July 2010 bar; the "weekly
  history starts 2018" reading was a false positive, fixed in #1152). The
  transcript captures 20 text replies after `№ 9,715`; three more were made
  but not captured as text (the W1.3 conflict note, the W1.5 checker's
  verdict, the reply to the stop hook's untracked-files notice), so the last
  reply before this ledger is **`№ 9,739`** and the next stamped reply is
  **`№ 9,740`** plus any unstamped line made after this ledger. The count is
  by replies, not by stamps. A later re-measure that reads below this line is
  missing these, not correcting them.

- 2026-09-27 00:50 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule): the script reads this container's transcript only and was
  refused as a reading. From `№ 9,740` the replies ran on by count through
  W1-FU #1157 and the plan/roadmap update #1160, the 21:30 SGT report
  `№ 9,798` (buried under status lines, re-sent as `№ 9,819`), the owner's
  C8 "yes", the Wave 2 adversarial pass, the handover order `№ 9,841`, the
  session pause 26-09 23:33 → 27-09 05:34 SGT, and then 27-09: the
  "can I merge them" answer `№ 9,862`, the owner's merges of #1156, #1162,
  #1158 and #1161 read back at `№ 9,867`, `№ 9,873` and `№ 9,888`, the
  broker-holiday interject `№ 9,869`, the M7 and CV-2 fix-first reports
  `№ 9,883` and `№ 9,885`, the handover additions order and `№ 9,895`. The
  container restarted about 00:1xZ; the restart report was stamped
  `№ 9,897` (08:30 SGT). One stamp in this run used a guessed time:
  `№ 9,821` read 22:23 SGT where the clock said about 22:18 (corrected at
  `№ 9,822`); another, `№ 9,892`, was written "08:0x" (corrected to 08:02 at
  `№ 9,894`). Five unstamped lines followed `№ 9,897` (the relaunch, the
  wait note, the M7 round-4 report, the agent-count check, the vet fixes),
  so the last reply before this ledger is **`№ 9,902`** and the next stamped
  reply is **`№ 9,903`** plus any unstamped line made after this ledger. The
  count is by replies, not by stamps. A later re-measure that reads below
  this line is missing these, not correcting them.

- 2026-09-27 07:05 UTC, **same remote container, PARTIAL corpus** (the §1
  write-back rule): the script reads **287** here and was refused as a
  reading. From `№ 9,903` the replies ran on through the handover merge
  (#1165), the 18-decision list `№ 9,919`, the owner's twelve decisions
  (27-09 ~12:30 SGT), the merges of M7 #1159, CV-2 #1155, S-8 #1163, T4
  #1168, #1164, #1166 and #1167 (27-09 13:43–14:27 SGT) and the "why nothing
  trades" answer `№ 9,959`. **The stamps had run behind by count since 26-09
  evening, and an independent check found it.** Five windows hold more
  replies than their stamp gap allows (`№ 9,767`→`9,768`,
  `№ 9,768`→`9,790`, `№ 9,790`→`9,791`, `№ 9,888`→`9,894`,
  `№ 9,915`→`9,918`). Anchored at `№ 9,767` (the stamp giving the highest
  bound) and counting every captured reply plus the thirteen known
  uncaptured ones (`№ 9,780`, `9,869`, `9,892`, `9,897`, `9,999` and eight
  unstamped lines), the stamps from 26-09 19:33 SGT to 27-09 14:59 SGT ran 1
  to 7 behind: `№ 9,983` (the first numbering answer) is at least `№ 9,988`,
  `№ 9,993` at least `9,996`, `№ 9,999` at least `10,000`. **`№ 10,003`
  (15:02 SGT) is the first stamp back in line.** The serial moved forward,
  never back. Three unstamped lines followed it by this ledger, so the next
  stamped reply is **`№ 10,007`** plus any unstamped line made after this
  ledger. The per-stamp table is `docs/handover-2026-09-27.md` §17. The count
  is by replies, not by stamps; it is a lower bound, because a reply neither
  captured nor known cannot be counted. A later re-measure that reads below
  this line is missing these, not correcting them.

- **27-09-2026 CODEX continuation, partial corpus rebase:** the owner supplied
  Claude Code's last reply as `№ 10,009` at 15:12 SGT and requested continuation
  of T4 option (a), OD-15 and the four diagnosed blockages for Sydney readiness.
  CODEX continued that shared count; the latest reply before this checkpoint
  is **`№ 10,023`**, 16:32 SGT. Subsequent visible replies take precedence.
  Work is on `codex/sydney-readiness-20260927`, based on `cf121d4`.
  Scope, evidence, corrections and remaining owner decisions are recorded in
  `docs/sydney-readiness-2026-09-27.md` and
  `docs/v3-momentum-target-policy-2026-09-24.progress.md`.
  No deployment, gateway variable change/restart, account selection, re-arming,
  exit retry or sizing-policy change was performed. The uploaded instructions'
  explicit production approval requirement is retained; the separate conflict
  about future fresh builds remains deferred by the owner.

- **27-09-2026 16:37 SGT, CODEX local gate complete:** draft PR #1170 is open;
  latest reply before this checkpoint is **`№ 10,026`**. Backend 7,152 passed,
  three skipped; frontend 1,311 passed; 40 C++ test binaries, production
  compilation and the changed mirror's ThreadSanitizer test passed. Production
  remains unchanged. The automated review step was skipped and is not checker
  evidence. PR CI, independent review and scoped production approval remain
  distinct gates; follow the PR checks and append-only progress log.

- **27-09-2026 20:08 SGT, CODEX gateway recovery checkpoint, partial corpus:**
  the shared count continues from the owner's supplied rebase and visible
  replies, not a new full-corpus measurement. Latest reply before this
  checkpoint is **`№ 10,083`**; subsequent visible replies take precedence.
  The owner-approved `/feed` correction and sequential restarts of cpp-exec
  and cpp-acct are complete. Seven accounts recovered; fresh independent
  broker readback found 26 positions with SL and TP. Native tick processing
  reached 3658 observations across 106 streams. Current feed anchors differ
  from registered profile accounts, and Node comparison acceptance remains
  open. The collector fix is still in undeployed draft PR #1170. No account
  selection, profile registration, broker-order, sizing or cap change was
  performed by this operation. The chosen return to account ending 0058
  remains unapplied. Detailed evidence and limitations are recorded in
  `docs/v3-momentum-target-policy-2026-09-24.progress.md`.

- **27-09-2026 21:16 SGT, CODEX review checkpoint, partial corpus:**
  latest visible reply before this checkpoint is **`№ 10,097`**; later visible
  replies take precedence. Owner paragraph 10087.3 authorised review, scanner
  alignment investigation and performance assessment. Source fixes cover
  exposure reservation, failed-connect coalescing and account-roster IDs.
  Focused checks passed; the full backend gate has a recorded 109-ms latency
  failure requiring rerun, and current CI remains pending. Six warm browser
  readiness observations and a private screenshot were captured; full
  DevTools traces are unavailable. No further production mutation occurred.
  PR #1170 remains draft and undeployed. See the dated review/readback and
  append-only progress documents for exact evidence and unresolved gates.

- **27-09-2026 21:36 SGT, CODEX final review evidence, partial corpus:**
  latest completed visible reply before this checkpoint is **`№ 10,112`**;
  the next reply is **`№ 10,113`**, and later visible replies take precedence.
  Code commit `281318d` passed application, scanner and execution CI. The
  local full run retained one 109-ms latency failure; the isolated rerun
  passed 30/30 with the same limit. Main group 7,124 passed/three skipped,
  hygiene six passed, private TMPDIR empty. The final follow-up changes
  documentation only. Runtime source remains the reviewed commit. PR #1170
  stays draft; no new production action occurred. Tick identity alignment,
  full performance traces, final-partial-fill acceptance and V3 outcome
  evidence remain open. The dated review/readback and append-only progress
  log carry the details; no skipped automated review is counted as review.

- **28-09-2026 05:24 SGT, CODEX exit-evidence checkpoint, partial corpus:**
  latest visible reply before this checkpoint is **`№ 10,148`**; later visible
  replies take precedence. The owner ordered exit-attribution correction,
  costed candidate replay with unchanged risk, and V3 continuation. The local
  increment passed a frozen-source backend gate (7,176 passed, three skipped),
  1,311 frontend tests, lint, build, colour and whitespace checks. Broker cause
  evidence is account/order/deal scoped; the false open-book trailing-stop
  inference is removed. Replay remains censored and does not qualify PF 1.71.
  An exact private 902-profile scanner proposal and rollback pass the actual
  registry locally but remain unapplied. Main is cf121d4; remote draft #1170 is
  aa59db0. No push, deployment, production record/profile/account mutation or
  broker action occurred in this increment. The 05:00 target was missed.
  Full V3 production, partial-fill, trace and empirical acceptance remain open.
  See docs/exit-attribution-replay-2026-09-28.md and its append-only progress
  record. Explicit push/production approval remains required by the uploaded
  instructions; the separate fresh-build-rule conflict remains deferred.

- **28-09-2026 07:20 SGT, CODEX authorised release and V3 checkpoint, partial corpus:**
  latest visible reply before this checkpoint is **`№ 10,207`**; the next
  handover reply is **`№ 10,208`**, and later visible replies take precedence.
  The owner's explicit approval covered resolving and merging #1169/#1170
  after CI and their resulting deployments. Both merged as `4f8cbac` and
  `1a0d344`. Final-head CI passed; skipped automated review is not independent
  verification. Node, demo gateway and live gateway deployments succeeded.
  Fresh post-boot receipts covered seven accounts and 26 protected positions;
  both native feeds recorded in shadow mode with tick placement false.
  Scanner alignment remains failed. The separate final-partial-fill follow-up
  is local and unpublished on `codex/v3-final-partialfill-20260928`, based on
  `1a0d344`. Final backend: 7,184 passed, four native-dependent skips, zero
  failures; 19 focused lifecycle checks, 1,311 frontend checks, lint, build,
  colour and whitespace gates passed with the scopes in the progress log.
  Full browser traces, natural final-fill execution and later-session/empirical
  acceptance remain open. Bounded read-only session checks are scheduled;
  they do not replace the continuous harness or owner-visible tabs.
  See `docs/v3-final-partial-fill-2026-09-28.progress.md` and
  `docs/v3-production-readback-2026-09-28.md`. No scanner/account/risk/credential
  change or broker order was performed. New push/deployment approval is
  separate from the completed named release. The original checkout's two
  uncommitted documentation edits remain preserved.

- **28-09-2026 07:49 SGT, CODEX #1171 release checkpoint, partial corpus:**
  latest visible reply is **`№ 10,220`**; the next handover reply is
  **`№ 10,221`**, with later visible replies taking precedence. The owner
  approved publication of `ed142c3`, then instructed "merge if ready".
  GitHub publication `e6688d5` and squash `41aa2cb` have the identical approved
  tree. PR #1171 CI 36359325227 passed all gates; optional reviewer execution
  was skipped for an absent key and is not independent review. Node deployment
  e6106ccd-3c1f-4705-8d88-4cdb61a9fcc5 succeeded; the five native services kept
  their existing successful deployments. Fresh post-boot receipts at 07:47 SGT
  cover seven accounts and 26 positions, all with SL/TP; 40 controllers are
  healthy, one retired and one idle. The 144-second first loop and temporary
  startup warnings are preserved as evidence. Scanner alignment, natural new
  partial-fill execution, full traces and graded session/empirical V3 gates
  remain open. See the append-only final-partial-fill progress record and
  PR #1171's release checkpoint. No settings, credentials or broker operation
  was added. Original checkout edits remain intact. This checkpoint is local
  so the deployed approved tree is not changed by a documentation-only release.

- **28-09-2026 08:22 SGT, CODEX V3 verification correction checkpoint, partial corpus:**
  latest visible reply is **`№ 10,235`**; next handover is **`№ 10,236`**;
  later visible replies take precedence. The owner's reported Astra Ultra
  setting and "proceed" resumed authorised local V3 fixes and read-only
  verification. A realistic later partial opening fill was reproduced and
  fixed with exact same-order deal-prefix proof and atomic trade/book/monitor
  refresh before TP1/reservation settlement. A separate narrow partial index
  reduces the legacy NULL-risk-row count without changing list results or
  tied ordering. Full backend 7,191 passed/four native-dependent skips,
  frontend 1,311 passed, full lint/build/colour/whitespace gates passed.
  Local branch: codex/v3-verification-fixes-20260928. No push or deployment.
  Production remains #1171/41aa2cb; all six deployments successful. Natural
  partial plans remain unobserved. Scanner796 revision unchanged; actual
  feed anchors differ and three of56 configured names remain unresolved per
  feed. Registry/account changes remain unapplied. The persisted startup
  144,370-ms first loop, 58,220-ms lag maximum, two HTTP5xx and budget overruns
  remain failed evidence despite later recovery. Continuous session evidence,
  full browser traces, natural partial execution and empirical V3 closure
  remain open. See docs/v3-verification-followup-2026-09-28.md and the appended
  partial-fill progress checkpoint. New publication requires scoped approval
  under the uploaded CLAUDE.md. Original checkout edits remain intact.

- **28-09-2026 09:24 SGT, CODEX performance/scanner implementation checkpoint, partial corpus:**
  latest visible reply is **`№ 10,258`**; later visible replies take precedence.
  The owner's continuation order completed the local retained-history query
  remedies, opt-in starting profiler lifecycle and guarded offline scanner
  alignment builder. Final frozen-source backend: 7,221 passed, zero failures
  or skips; frontend 1,311/136 files; full/explicit-script lint, build, colour,
  whitespace and temporary-file hygiene passed. Three unchanged native
  production targets built and all four previously skipped native checks ran.
  The initial account-routing inventory failure was fixed through the existing
  routing helper and a documented exact schema/import inventory entry; its
  policy assertions remain intact. The earlier f185389 partial-fill and risk
  correction is inherited. New performance benchmarks are synthetic evidence,
  not measured Railway recovery. The scanner plan preserves 106 tick profiles,
  adds 106 current-feed profiles and remaps 690 timeframe profiles without an
  account selection. Fresh executable payloads remain pending: authenticated
  browser reads timed out and native capacity was not established. Missing
  SPX500/USOIL/UKOIL identities are not aliased. Registry rollback does not
  prove immediate native cell recovery. Production remains main 41aa2cb with
  six successful deployments; no new push/deploy/configuration/broker action.
  See docs/v3-performance-scanner-remedies-2026-09-28.md, its append-only
  progress record and machine-readable gate JSON. Local candidate publication
  needs scoped approval under the uploaded CLAUDE.md; production configuration
  has its own exact-payload approval. Owner-observed acceptance follows
  implementation handover. V3 is not production-complete. Original checkout
  documentation edits remain preserved.

<!-- Continuation ledger 2026-10-03 22:36 UTC: owner supplied lower bound
№ 10,964; visible Codex continuation has reached № 10,972, next at least
№ 10,973. The partial-container count is not adopted. Security work ordered
after № 10,966: Dependabot #40/#41/#42 affect development-only brace-expansion
1.1.18 through ESLint/minimatch; candidate updates the root lockfile to 1.1.21.
Base is main 8b4b360 (#1221), source tree verified byte-for-byte. Independent
diff review found no blockers; full gates are running. No deployment approval
for this security change has been recorded; no trading settings changed. -->


- 2026-10-05 10:42 UTC, Codex continuation in a partial cloud corpus: lower bound
  through №11,226, next at least №11,227; later main-thread replies win.
  The owner said continue after the6PM handback. Fresh main09b5a708 and
  all source blobs remain pinned. Seven verified complete/25active,45tracked;
 18/31withdrawn,17/32/39closed-review-with-gaps,11/24/37/41historicalarchives
  remain excluded and are not technicalpasses. The deadline sprint ended.
  Necessary reproduced stability fixes and exact-head gated auto-merge
  remain authorised; no new routine approval request is required.
  PR1232post-merge Codex automated P1 review revealed an upstream precision
  bypass: getVolumeMeta normalised missing/blank/boolean broker digits
  before the since-entry validator. Four new realadapter/keeper regressions
  fail before and the65-check focused suite passes after the bounded fix.
  Preserve raw brokerDigits alongside legacy sizing digits, use only raw
  precision at both since-entry lookup paths and remove ledger/position
  fallback; actual0andnumeric3 remain valid, invalid/unavailable values
  withhold the spec. Existing keeper actions,ATR,account/host,managed/book
  fences,TP,risk and cached sizing defaults remain unchanged. Native code
  and all broker/risk/history/account/activation/region/storage controls
  are untouched. Full local/CI gate and release are pending at this stamp;
  no merge/deployment or whole-row13 acceptance is claimed. Read access
  remains unbound; source fixes do not establish trailing or WR/PF.
  Actual session link/effort metadata unavailable; no human independent
  review is claimed. Source and focused evidence live in
  /workspace/bot-trade-raw-precision-evidence-2026-10-05 when available.

- 2026-10-07, Codex · №11,667 (codex-footprint: signals-ui-2026-10-07):
  owner said continue after the Signals/storage explanation at №11,664.
  Fresh main62276a2 retains Claude PR1245 and completed prior fixes.
  Actual Trade-page fixture reproduces blocked scans labelled active and
  shown as candidates' peers. Present candidate, blocked and exact linked
  entry counts separately; hide blocked observations behind an explicit
  read-only inspection control, preserve current-batch/account ownership,
  refresh and one leading disclosure. No scan/history storage or trading
  permission is changed. Local/exact-head gate, review, merge and deployed
  identity remain pending at this source stamp; no acceptance closure.
  Actual session link/effort metadata unavailable; no human review claimed.


### Codex · №11,806 · 2026-10-07 — indexed opportunity sighting lookup

codex-footprint: indexed-opportunity-lookback. Based on main264fd708, preserving
PR1255 and the Claude handover. A production startup profile sampled49.892s in
nextOpportunityKey; the public health client timed out and watchdog requests
aborted in that startup window. A real-source SQLite fixture reproduced a
full risk_events scan and temporary sort. Add the matching latest-sighting
expression index after last_at migration; use equal-or-both-NULL IS binding.
Account isolation, case folding, latest repeat sightings, opportunity gap and
missing-column fallback remain; no financial rows, monetary thresholds, broker
policy, scanner registration, selected account, credential or native change.
Regression/local/exact-head CI and deployed profile verification pending.
This is a reproduced query defect, not proof of every stall's sole cause.

## Codex · №11,864 · 2026-10-07 — stop-policy convergence

codex-footprint: stop-policy-convergence; consolidated trading-critical closure.
A current own-account broker trigger that contradicts a previously confirmed
policy may retry after the existing five-minute RETRY_MS, instead of waiting
six hours. Unknown trigger fields and refused/cooldown/mismatch/unreadable
outcomes retain RECHECK_MS. Policy-only amends carry ratchetOnly, row direction
and validated symbol identity from this account's reconcile; no Node stop/TP
levels or selected-account symbol fallback. The shared brokerTrigger reader
keeps malformed/boolean/blank fields unknown and recognises real enums.
Canary/hold, owner pauses/opt-out, momentum-book rules, one-call/account, deadline
and single-flight protections remain. This does not establish the origin of
GER40's observed trigger drift, a broker outcome, or whole acceptance. No TrailSpec
ingest field changes: guardian digest contract remains unchanged.
<!-- Codex · №11,923 · 2026-10-07; codex-footprint: executed-volume-contract.
Owner11915/11916 continuation: prospective executed-volume correction on fresh
22d6216f, reusing completed PR1233–1258 and gates. Actual adapter regressions
reproduce nominal closing quantities/weights and automatic legacy rewrites.
New broker receipts use validated filledVolume/closedVolume, preserving the
requested quantity separately. Legacy broker rows remain untagged and retain
their financial facts; a once-only DB trade-ID watermark prevents new price/
volume correction from recalculating existing trade/history rows. Missing or
mixed-reversal quantities remain unknown. No original GER40 row is repaired.
Native read-only verifier contract4 uses actual quantities and requires one
complete supported lifecycle; no guessed FX or cost allocation. Node/native
versions stay equal. Shared transport and execution/account gateways unchanged.
At this stamp217focusedNodechecks pass; native red-before29 assertions fail on
unchanged judge, focused actual judge/loopback decoder green; full local/exact
CI and merge/deployed verification pending, not claimed. No broker/credential/
risk/account/profile/strategy/region/volume/staging/schedule operation.
Acceptance stays7verified/19active/6owner-deferred, zero whole-row closures.
-->


## 2026-10-08 — Codex · №12,109: default native movement journal routing

codex-footprint: default-trail-binding. Fresh base03fba5c (PR1263), tree d5114563. Automated review https://github.com/ang-kl/bot-trade/pull/1263#discussion_r4214373707 identified the documented collapsed-route gap after merge: execSidesToProbe returns isLive:null and the boolean-only journal binding leaves confirmed receipts raw. Current production uses separate live/demo routes; no production impact from this default-route gap is established.

For the actual collapsed endpoint only, retain the existing current-route host when its primary account is registered, its registered host agrees with the current route assembler and the health/pull native boot agrees. A registered receipt account must share that host. Split routes retain their original side comparison. Unknown primary, conflicting host/mode, foreign endpoint, missing/contradictory side or mismatched boot stays raw. Existing account/symbol/direction/entry/episode/strict movement and atomic journal/cursor checks remain required; no selected-account move, credential/OAuth write, account activation or native/trading policy change.

Two positive actual ingestion regressions fail unchanged main; fourteen controls pass. Five new cases cover demo/live-short/default secondary ownership and grouped mismatch controls. Final focused routing/receipt/heartbeat suite99/99 passes. Heartbeat remains the existing routing owner; its exact isLive reference allowance31->32 corresponds to the one collapsed-route discriminator, with no new module exception or relaxed audit. Required local/exact-head Node gates and fresh actual review precede release; no new native source gate/rebuild is needed for this Node-only follow-up. Prior PR1263 native/TSan/delegator gate remains completed on unchanged native hashes. No universal provenance, retrospective history reconstruction, full trailing/WR/PF acceptance or independent human review is claimed.

Owner accounting stays7 verified/19 active/6 deferred; unverified overlay25=19+6,45 total; zero whole-group closures. All exclusions, unused staging, registry-owner boundary and disabled monitoring schedule are preserved. Dated release/deployment results are recorded append-only in the session receipts rather than inferred from this implementation note.

## 2026-10-08 — Codex · №12,130: LossGuardian naked-stop ratchet

codex-footprint: loss-guardian-ratchet. Owner orders the narrowly scoped correction on fresh main923491521d971ded3cca0cabbe4fd795a72b354e, reusing completed PR1233–1265. Actual runLossGuardian plus in-memory production database and controlled broker boundary reproduce long/short intervening-stop widening and false unchanged movement; thirteen initial regressions fail unchanged source. A further native-policy-stamp regression fails the first correction: unchanged:false with confirmed stopMoved:false is also not a stop installation. Both non-movement outcomes now leave the stop value, movement journal, notice and success count untouched.

The naked-stop transaction carries ratchetOnly:true and expectedDirection/expectedSymbolId from this account's own broker snapshot. Missing/malformed account, position, symbol or direction and conflicting ledger/broker direction or explicit broker account refuse before action. Numeric and protobuf enum directions are accepted without guessing; normalised long/short ledger labels use the matching broker direction. Quote/sizing remain on the own snapshot symbol. Native ratchet re-reads under its existing position lock, preserves the fresh broker TP, and has no JS fallback in cpp mode. Existing TP payload, stop-policy augmentation, thresholds, owner overrides and momentum-book exemption are unchanged. Existing js-mode transport is unchanged; the atomic guarantee depends on the native cpp ratchet path, not a newly implemented WS transaction.

Production occurrence and trading impact remain unproven. Required full local/exact-head CI, actual review inspection, authorised merge and deployed ordinary execution/reconciliation/advancing quotes/protection verification must complete before release closure. No unchanged native build, forced broker event, credential, risk/account/strategy/profile/selected-account/history/region/volume/staging change or monitoring schedule. Node lag/watchdog causality remains separate. Engineering closure is distinct from whole acceptance: retain7verified/19active/6deferred and unverified overlay25 unless an entire group passes. Conversation ref: owner LossGuardian prompt after№12,126–12,127; implementation/report№12,128–12,132; session loss-guardian-ratchet, ChatGPT (no external session URL or effort metadata available).

Codex · №12,140 · 2026-10-08 — actual automated P1 review on PR1266 head044aa82 caught an introduced non-movement classification bug BEFORE merge. Native confirmedMovementProof requires a positive before-stop, so genuine first installation also returns stopMoved:false. The initial 7,718-backend/1,350-frontend full local gate and exact CI37736646422 passed but the simplified controlled response omitted that native field. An offline probe calls the unchanged actual native confirmedProtection helper for long/short first installations and policy-only stamps; no service rebuild or broker request. Actual-shape guardian/database regressions now reproduce the P1. The correction retains confirmed null-before/positive-after installations while unchanged and existing-stop policy-only outcomes remain non-movements. Initial gate/review/red receipts are preserved; refined source needs the full local and exact-head gate and fresh review inspection before merge. No released defect or production occurrence is claimed.

## 2026-10-08 — Codex · №12,172: account-owned symbol callers

codex-footprint: account-symbol-ownership. Owner orders the current shared-map caller audit and necessary reproduced corrections on fresh main42be9c086cd712437eda2e2a732e565e13424efb, reusing PR1233–1266. Assessment A3's seventeen references measure exposure, not seventeen proven defects. Real caller/database regressions reproduce targetless TP structure fetched with another account's symbol ID, the shared-map helper returning the selected account's list for another account, an explicitly foreign reply falling through to a primary-account shared ID, and foreign/unstamped stored maps treated as verified. Actual selection-route and overlapping list-read regressions cover the account-switch window and late mirror overwrite.

TP structure now uses the positive integer symbol ID on THIS account's supplied broker-position snapshot; absent/malformed identity never borrows a name map. An explicitly foreign-account snapshot refuses. Existing direction, HVN/R:R-floor rules and TP amendment behavior remain unchanged. Account symbol readers require the writer's matching account stamp. Linked selected-account lookups use that owned list rather than assuming that selection proves the legacy mirror's origin. The self-heal reads perAccount:true through the existing owned writer; an awaited completion mirrors only the still-selected account. Selection/config changes retire the previous mirror; a manual map must match the selected account's verified broker list. Broker callers retaining an account snapshot pass it to the map getter. Existing unlinked legacy fixture reads are retained; they are not certified broker identity or production occurrence.

No threshold, owner override, hand pin, book exemption, risk/account/strategy/profile activation, credential, forced broker event, financial-history, region/volume/staging or schedule change. LossGuardian's completed correction is preserved. Full local and exact-head CI, actual reviews, authorised merge and ordinary deployed execution/reconciliation/advancing quotes/protection must pass before engineering release closure. Current broker populations and complete acceptance remain unverified where authorised receipts are unavailable. Counts stay7verified/19active/6deferred; unverified overlay25. Remaining raw legacy-map readers and the one bounded watchdog case are recorded separately in local audit evidence. Conversation ref: owner account-owned symbol audit prompt after№12,166; audit/correction№12,167–12,172; session account-symbol-ownership, ChatGPT (no external session URL or effort metadata available).


Codex · №12,212 · 2026-10-08 — keeper-volume-peak (owner ordered after №12,204–12,207). Fresh main fdffd1be retains PR1233–1267. Four real keeper/SQLite regressions reproduce a false full close after a half-volume readback at unchanged price, in adaptive/fixed long/short paths. The initial adaptive fixture accidentally exercised the no-ATR fixed fallback; its corrected fresh-main control reproduces both modes and all earlier receipts are retained. A separate durable keeper_peak_state records the owned position/symbol/side/entry, broker quantity and decision peak; a reduced quantity scales that peak before existing policy arithmetic. Increased quantity or changed identity/entry starts a current-observation basis. Legacy monetary peaks have no proven quantity: never guess or reconstruct it. peak_profit_usd remains the observed high-water mark; no realised money/history is rewritten. Persist the basis before actions, retain existing tighter broker stops/TP, thresholds, scopes, managed/book fences and ratchet contracts. No hybrid/exit policy activation or evaluation-goal choice. Full local/exact-head CI, actual reviews, merge and ordinary deployed identity/execution/reconciliation/quotes/protection must pass before engineering closure. Whole acceptance remains7verified/19active/6deferred, unverified overlay25 unless an entire group passes; production occurrence and owned natural partial outcome remain unverified. No credential/broker forcing, risk/account/strategy/profile/region/volume/staging/schedule change or unchanged native rebuild. Conversation ref: owner peak/partial-volume correction prompt after№12,207; implementation/reproduction№12,208–12,212; session keeper-volume-peak, ChatGPT (no external session URL or effort metadata available).

Codex · №12,223 · 2026-10-08 — actual automated P1 review on PR1268 headbed0647 caught an introduced enum-compatibility refusal BEFORE merge. Broker tradeSide supports BUY/SELL as well as numeric1/2 and numeric strings; Number(BUY) rejected otherwise valid keeper positions. Initial full local7,743backend/4existing skips,1,350frontend/allgates and exactCI37764320524 passed but lacked named-side coverage. Two actual keeper/SQLite named-side regressions fail that candidate. Normalize the supported broker forms exactly as LossGuardian does; unknown/conflicting forms remain refused. Initial gate/review/red receipts remain immutable; refined source requires full local/exact-head CI and fresh actual review inspection before merge. No released defect or production occurrence claimed.
