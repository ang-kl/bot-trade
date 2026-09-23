# EMA option parity - observation only

Continuation of P5c on top of #1043. The native timeframe scanner now mirrors
the existing EMA pending-entry calculation, optional EMA200 stacking, stop
floor/ceiling and optional time cap. The original JavaScript implementation
remains the decision owner. No strategy defaults or account settings change.

The evaluation callback carries the effective observation options to the
existing bounded publisher. Each option set has its own profile hash, so
default and customised calculations cannot share candidate or comparison
identity. Numeric hash components use IEEE-754 bits instead of language-specific
decimal formatting; null time caps remain distinct from zero. The scanner and
publisher reject malformed or mismatched option profiles. Other unsupported
strategy options continue to retain the reference owner.

32 frozen cases come from the actual JavaScript EMA function. They cover long
and short pending entries, optional stacking with a genuinely unstacked trend,
floor widening, ceiling refusal, zero/fractional inputs and time-cap semantics.
The existing floor-above-ceiling behaviour is preserved exactly rather than
silently introducing a different strategy policy. Native tests compare economic
fields and provenance; the real authenticated local HTTP publisher/collector
path compares these cases alongside the 154 default fixtures with no intents.

This proves the named finite numeric/boolean option subset on these fixtures.
It does not claim all possible inputs, full Fibonacci/filter/volume-profile/FVG
option parity, representative peak-load performance or production acceptance.
Legacy non-boolean/coerced numeric options are not newly supported. Existing
default hashes are unchanged. Warm-up remains 450 bars and R:R semantics remain
the reference's existing rules.

## Release boundary

This package is stacked on #1043, itself on #1042. Do not merge the stack into
main until the controlled rollout is approved. Fresh Railway configuration on
23 September still has no service watch filters; a main merge can restart the
broker gateways. See `v3-release-readiness-2026-09-23.md` for the scoped proposal.
No Railway settings, scanner feeds, trading activation, targets, credentials,
notification recipients or broker positions were changed in this continuation.

Rollback owner: Adrian Ang. The remaining programme acceptance is tracked in
`revision-3-progress-2026-09-22.md`; V3 remains incomplete.

## Validation environment

Use Node 22 and UTC, matching CI. The workspace initially supplied Node 24 and
Asia/Ho_Chi_Minh, which prevented the first dependency build and caused existing
SQLite-UTC/local-Date tests to fail. Dependencies were installed with Node 22;
the complete gate is rerun with TZ=UTC. No test assertion or threshold was
weakened. Native executables are built so integration checks cannot skip them.

Completed local gate: 28 isolated latency tests plus 5,334 other agent tests
(5,362 total), zero failures/skips; 935 frontend tests; zero-warning ESLint;
production build; no-green; entry-point syntax; UI control inventory (119
wired action sites, 97 state reads, no half/decorative controls). The native
reference/options, scanner refusal and session/volume suites pass, including
32 added option cases, 154 existing reference cases, 900 session boundaries
and 24 volume cases. Local HTTP integration passed all 11 tests. Binary symbol
inspection found no broker execution/order-amendment symbols in the changed
timeframe executable. These are local test observations, not live acceptance.
