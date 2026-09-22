# P2 leverage ownership and evidence

Authority: revision 3 P2b. Base main is
`4dbdc82996b97a7ace526c5e0dade7b4ff5d4c69`, including the owner's #1009/#1010
merges at 15:10:33 and 15:10:47 SGT. Railway reports all four services successful
on that SHA; this is deployment observation, not authenticated acceptance.

## Reproduced defect and bounded behaviour change

An account missing its own leverage used the unowned global leverage stamp.
For example, 1:1000 from another account made a one-lot EURUSD position at 1.10
look like USD 110 of used margin instead of the existing default estimate of
USD 1,100. The main gate, margin pool/permits, fundable-universe and shadow
callers all reach this shared resolver.

Named and selected accounts now read only their own leverage key. Missing,
non-positive or malformed leverage uses the existing `DEFAULT_LEVERAGE = 100`.
The numeric default and risk limits are unchanged; a foreign account's stamped
number can no longer replace that assumption. The no-selected-account legacy
path retains its existing global/default behaviour and names the legacy source.
This correction can change entry eligibility or estimated margin where the old
resolver borrowed a foreign value; it is not an observability-only change.

`getAccountLeverageEvidence` reports account identity, value and one of
`account_stored`, `assumed_default`, `legacy_global`. The old scalar keys lack
timestamp/provenance, so all are explicitly unverified and have no invented
observation time. Entry verdicts, the margin pool, risk-config and watchlist
read models expose the evidence. The numeric getter remains compatible for
the existing consumers. No broker query or state write is added.

Six new behaviour tests cover named/selected isolation, invalid/fractional
inputs, legacy scope, the real margin pool, refused entry verdicts and actual
HTTP consumers. The historical test that expected account B to borrow global
25 was replaced with the approved isolation expectation and assertions that
changing the global value cannot affect B. No test was disabled. Initial test
scaffolding assumed evaluateTrade alone refused a null TP; that was corrected
to use an explicit blocked-symbol refusal. Mandatory TP enforcement in the
submission/protection paths is untouched and remains in the full suite.

Before the main update: 5,211 Node passes and 900 Vitest passes. The full gate
was rerun on current main including #1009/#1010: 5,224 Node tests pass, one
existing skip; 904 Vitest tests pass; ESLint, build, no-green and syntax checks
pass. A concurrent-build run narrowly missed an existing 100-ms health-response
test at 102 ms. The complete suite then passed with one test file at a time,
without changing that threshold or any test. PR CI remains independently required.
Implemented and tested is distinct from merged, deployed and accepted.

Remaining P2 money work is explicit: producers can still stamp native deposit
currency under `_usd`; own stored leverage lacks source-event freshness;
selected-balance legacy fallback and non-USD protection/accounting require a
coherent money contract that preserves existing-position protection. This
package does not change those producers or pretend provenance has been restored.
Do not use the displayed default as verified broker leverage.

Preserved: numerical limits, mandatory TP1, manual ownership, account isolation,
validation thresholds, credentials, modes and writer authority. No activation
or deployment was performed by this continuation. See the prepared
[controlled rollout](controlled-rollout-preparation-2026-09-22.md) for the real
main-to-production coupling and outstanding live acceptance.
