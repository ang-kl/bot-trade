# P1/P4: narrow decision-audit history reads without changing results

Intent (directive): continue the approved startup/report performance work.
The #1079 first loop took 124,390 ms: scan 47,118 ms, the post-scan bucket
63,914 ms and monitoring 12,105 ms. That post-scan bucket includes the decision
report and other work, so attributing the whole delay to one query is not yet
proven. The decision report has a 60-second deadline and prior timeout evidence.

Confirmed code issue: its REPLACE(created_at, 'T', ' ') timestamp predicates
cannot use the existing raw created_at indexes to seek the current FX day.
No new index or startup migration is required: retain every normalized filter
and add the necessary raw lower bound. Replacing T with a space only lowers a
text value lexicographically; if the normalized value meets the day boundary,
the original value necessarily meets that same lower bound. Earlier ISO times
from the same date remain excluded by the original normalized filter.

Scope: agent/services/decision-audit.js, a focused decision-audit range test,
this contract and the CLAUDE.md continuation ledger. No risk rules, history
writes, time boundaries, account/legacy-null semantics, report classifications,
timeouts or broker actions change. Existing tests remain intact.

Invariants: identical report values on mixed ISO/SQLite dates and account/null
scopes; no future/legacy rows silently dropped; indexed range access for the
actual executed decision and gate aggregates; original lineage and quiet-time
semantics retained. A before/after synthetic report comparison must agree,
with measured query timing stated as synthetic, separate from deployed timing.

Verification: reproduce non-seeking query plans before the correction, then
pass the real audit behavioral and query-plan cases; run all repository gates
and exact-head CI. After deployment measure the first full loop and preserve
seven-account protection/settings. A faster fixture alone cannot close V3 or
the production first-loop performance condition.

Focused evidence: the new real-query test first reproduced full table scans,
then all 30 decision-audit tests passed with indexed range searches. A separate
file-backed comparison loaded the unchanged main implementation and the new
one against 100,000 historical plus 300 recent rows in EACH of decision_log
and risk_events. Full JSON reports matched for all accounts and each of two
individual account scopes (including legacy NULL-account rows). Synthetic
times were 295.26 -> 4.48 ms (all), 257.01 -> 2.87 ms (account 11), and
259.31 -> 2.47 ms (account 22). No new indexes or migrations are added.

The #1079 deployment d914e61a successfully booted commit 4472e91. Database
initialization was 652.35 ms; HTTP listening began 7.49 seconds after BOOT.
The all-account target diagnostic explicitly returned zero recorded plans,
INCOMPLETE runtime integration and executionAuthorized=false. Fresh independent
broker readings at 17:29:40-41Z covered all seven accounts with 32 protected
positions. Entry-mode settings and account phases matched the preflight.
#1080 merged d878ea9 after all local gates and exact-head CI; its main merge
changed ancestry only, with identical tested source. The new policy remains
inactive. First-loop performance and wider V3 acceptance remain open.
