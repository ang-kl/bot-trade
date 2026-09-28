# V3 scanner remedy progress

Version 1 - 28 September 2026. Append-only execution record.

## 2026-09-28 - Stage 1-4 checkpoint

The owner instructed the next planned local performance and scanner work.
This record covers preparation of an explicit scanner configuration proposal,
not permission to apply it. The existing 902-profile tick-only proposal cannot
resolve the selected-account timeframe mismatch. A replacement proposal will
preserve the original 106 tick profiles, add current-feed tick registrations,
and replace the old-account timeframe cohort using unique exact names through
both account-owned maps. It never changes the selected account, enables an
account, creates aliases, changes strategy parameters, or rewrites evidence.

Scope: `scripts/prepare-scanner-alignment.mjs`,
`agent/services/scanner-alignment-proposal.test.js`, and this progress record.
Tests will exercise mismatched identities, stale inputs, immutable rollback,
actual registry validation, bounds and native capacity. Actual account payloads
remain private outside git. Production writes, publication and deployment are
outside this local execution authority.

The native timeframe table holds 1024 cells. Replaced registrations do not
delete native cells: only idle cells unoffered for one hour can be evicted on
new admission. The proposal must report free plus stale capacity explicitly;
unknown or insufficient capacity is an application preflight blocker.

No executable `/flow-check` is installed. This is the manual stage checkpoint:
Intent and Interpretation met for the owner-requested local remedy;
Assumptions and Invariants met for exact map identity and no trading changes;
Execution follows tests first. Fresh production inputs remain an evidence
requirement. Timeline remains within the current local implementation task.

## 2026-09-28 - Stage 5 tests-first checkpoint

The six operational regression groups were written before the builder. The
focused command failed with `ERR_MODULE_NOT_FOUND` for the absent builder,
as expected. No existing test was changed. The fixtures deliberately assign
different numeric IDs to the same exact name on two accounts and give an old
ID to a different target instrument. This checks that copying an account ID
onto an existing profile cannot pass as an identity-preserving migration.

The existing production cohort contains 690 timeframe profiles across 46
symbols, three strategies and five timeframes. This remedy preserves that
population; adding strategy coverage is outside this identity correction.

## 2026-09-28 - Stage 6 local builder evidence

Seven proposal test groups pass with zero failures/skips. The existing four
registry tests also passed alongside the first six groups. Syntax, changed-file
lint, explicit JavaScript lint for the `.mjs` source, and whitespace checks
pass. A first implementation run exposed the order of two equivalent host
refusals; the implementation now checks the observed tick host before refusing
a cross-host move. The regression assertion was retained, and a separate
correctly observed cross-host move is also refused.

The actual production registration function is exercised only against an
in-memory database. It accepts the proposed identities, rejects stale CAS and
bridge-on changes, and restores the exact original revision. Account rows,
non-registry settings (including selected-account and autotrade sentinels),
entry-intent count and trade count match before/after apply and rollback.
The builder performs no network request and has no production database or
account-selection operation. CLI files use exclusive creation and mode 0600.

The evidence separates unresolved declared names from mapped names that lack
profiles in the preserved cohort. Neither class is silently converted into an
alias, extra symbol, strategy or timeframe. The existing 56-name universe's
SPX500/USOIL/UKOIL require explicit instrument decisions; broker catalogue
candidates are evidence for a decision, not permission to substitute them.

Use a fresh non-secret JSON snapshot containing `readAt`, `revision`,
`profiles`, `accounts` (account_id and is_live), `maps` (accountId, builtAt,
map), `selected`, `tickFeeds` (accountId, host, profileHash, observedAt),
`universe`, and `nativeTimeframe` (observedAt, cells count/capacity/stale,
pending). The explicit plan contains `expectedRevision`,
`selectedAccountId`, `tickMoves` and `timeframeMove`; every move names
`fromAccountId` and `toAccountId`. Source and feed observations must be
no older than five minutes and not future-dated. Map builtAt is reported
separately from the fresh read time.

```
node scripts/prepare-scanner-alignment.mjs --snapshot PRIVATE_SNAPSHOT.json --plan PRIVATE_PLAN.json --out-dir EXISTING_PRIVATE_DIR
```

This emits compact proposal, exact rollback and review evidence. Unknown or
insufficient native capacity remains an explicit application blocker. The
operator must freshly recheck registry revision, selected account, feed
anchors, maps and native capacity after the approved bridge pause. Never use
an old review package as proof that these preconditions still hold. Applying
the payload and bridge restart/restore still requires scoped owner approval.

No production action, git commit, push or deployment was performed by this
work stream. Exact current production payload generation awaits the parent's
fresh non-secret snapshot; full combined release gates are parent-owned.

## 2026-09-28 - Map freshness defect checkpoint

Parent review identified a real preflight omission: a newly read snapshot
could contain account maps older than the runtime's 24-hour K2 freshness
policy. The existing builder reported `builtAt` but did not refuse stale
contents. A tests-first regression failed because a missing map timestamp
was accepted. Cases also cover invalid, future, exactly-expired and older
timestamps on both source and target accounts. This remains inside the
approved identity remedy; it does not change the production freshness policy.

The repair uses the shared `ACCOUNT_SYMBOL_MAP_TTL_MS` constant and requires
a valid nonfuture `builtAt` strictly younger than its 24-hour limit. A bounded
map extraction remains acceptable for this explicit profile population only
when extraction retained every alias for the selected symbol IDs, so collision
detection is preserved. Such inputs are not complete broker catalogues;
`complete` and `sourceCount` are retained in the evidence alongside the
extracted count and digest. No absent alias is inferred from a partial map.

The repaired builder passes all eight proposal test groups with zero
failures/skips. The freshness regression exercises both account directions,
accepts the final millisecond inside the shared TTL, and retains bounded-map
provenance. Test-file lint, explicit `.mjs` JavaScript lint, syntax and
whitespace checks pass. The scanner source is frozen again for the combined
release gate; this evidence does not apply or refresh a production map.

## 2026-09-28 - Native rollback preflight correction

Independent review identified an operational limit not covered by the exact
SQLite round-trip: installing 690 replacement native cells in the 1024-cell
table can evict 356 previous cells. An immediate registry rollback can then
leave 690 new cells fresh and ineligible for eviction. Restoring the database
registry alone therefore does not prove native observation recovery.

A focused tests-first assertion failed because the evidence lacked an
explicit database-only round-trip scope and separate native rollback gate.
The metadata will require a fresh capacity preflight after pausing the bridge
for rollback too. If capacity is insufficient, wait until unwanted cells are
idle and stale, or obtain a separately scoped native restart approval. The
builder must never restart a service automatically or claim native rollback
was executed by its in-memory validation.

The rollback metadata correction passes all eight proposal groups, lint,
syntax and whitespace checks. A second review found that CLI payload files
ended with a newline while their recorded hashes and byte counts described
the compact JSON alone. A new real-CLI test reproduced the one-byte mismatch
(2,667 file bytes versus 2,666 recorded bytes). Payload files will now contain
the exact compact bytes; the separate evidence JSON can retain its newline.

Final targeted scanner validation passes nine groups with zero failures or
skips, including SHA256 and byte-length checks of both files produced by a
real CLI subprocess. Lint, syntax and whitespace checks pass. Only evidence
metadata, payload-file serialisation and their focused tests changed after
the parent started the combined backend gate. Registry contents, proposal
revision, profile remapping and production runtime code remain unchanged.
Source is frozen after this correction; no broader test gate was rerun here.

## 2026-09-28 - One-account-model routing correction

The parent's combined backend gate found the new script's four unlisted
`is_live` tokens. The isolated one-account-model test reproduced the failure.
One token duplicated the host-choice branch; the others validate the snapshot
schema and seed the offline memory database. The parent authorised using the
existing `registeredCalendarAccounts` routing helper and adding an exact
three-token routing/storage entry to the one-account-model allowlist. This
does not permit eligibility or risk-policy branching.

The builder now obtains registered hosts from its actual in-memory database
through that shared helper. No artificial database adapter, renamed token,
string concatenation or weakened assertion was introduced. The three explicit
uses remain the import SQL, imported column value and strict 0/1 validation.
All account/strategy rules remain identical on both broker hosts.

The accepted path still creates one memory database, performs one additional
bounded account SELECT, and uses that same database for registration and
rollback validation. Some invalid-input fixtures now create the memory
database before their later identity refusal; no production runtime path
changes. Five account-model tests plus ten scanner groups pass (15 total),
including malformed flags and foreign hosts on both account kinds. Changed
file lint, explicit `.mjs` lint, syntax and whitespace checks pass. The parent
owns the next complete backend gate. Source is frozen again.
