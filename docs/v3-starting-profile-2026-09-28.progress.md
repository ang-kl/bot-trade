# V3 starting-phase profile coverage

Version 1.0 - 28 September 2026

## 00:52 UTC / 08:52 SGT - implementation checkpoint

The owner authorised the remaining performance remedies. This increment
repairs diagnostic coverage only: the loop labels its initial work `starting`
but begins CPU profiling only when it changes to its first named phase. Even
an operator explicitly arming `starting` cannot obtain that phase's profile.
The observed 66,197-ms starting bucket and 58,220-ms starting lag are therefore
not explained by the existing later scan profile.

Historical Railway logs from deployed `41aa2cb` show loop 1 starting at
23:44:56.975 UTC, its cross-side equity seed finishing at 23:44:59.032,
and 64,035-ms scans / 65,180-ms heartbeats requests completing around
23:46:03. The seed did not consume the whole starting bucket. Synchronous
HTTP or ticker work can run while the loop awaits other work; the phase label
does not prove that the loop's own starting operations caused the stall.

Scope: the existing starting phase's profiler lifecycle in `agent/loop.js`,
a focused regression executing its actual phase-accounting code, and this
append-only checkpoint. The shared profiler and sampling interval, default
off behaviour, phase boundaries, persistence shape, trading rules, broker
calls and production settings remain unchanged. Tests must first reproduce
the missing starting capture, then verify real sample attribution, transition
and close cleanup, repeat cycles and no active profiler when unarmed.

Execution has not begun. No production profiling, environment change, push,
merge, deployment or broker action is authorised by this local correction.
Adding coverage cannot be reported as a repair of the measured startup delay.

## 00:56 UTC / 08:56 SGT - local correction and focused verification

The new regression first failed because the actual loop produced no starting
profile under either `starting` or `*`. The lifecycle cases also failed before
the cleanup guard existed. The source now calls the unchanged opt-in profiler
beside the existing starting stamp. An outer `finally` makes its stop
idempotent after normal/backoff close and guarantees cleanup when a state
read/write throws before the main cycle catch. Existing work, awaits, phase
boundaries, error handling and scheduling retain their order.

Six focused lifecycle tests execute the actual phase-accounting and cleanup
code extracted from `loop.js`, using the real V8 inspector and planted work.
They cover initial capture, starting/scan attribution boundaries, another
cycle, default-off and scan-only settings, close-persistence failure, an
initial timestamp-write failure, normal close, early return and thrown work.
An initial boundary fixture reused an already warmed function that V8 inlined
into its caller. Its recorded profile identified that caller correctly; a
separate named burner now makes the attribution assertion stable. No existing
test or assertion was changed.

`node --test agent/loop-starting-profile.test.js
agent/services/cpu-profile.test.js agent/loop-breaker-wiring.test.js
agent/services/momentum-book-out-of-scan.test.js` passed all 63 tests, zero
failures/skips, in 4,244.396 ms. Changed-source ESLint and whitespace checks
passed. The existing npm proxy-configuration warning was non-fatal. No full
suite, commit or external action was performed by this increment.

The root session's read-only production observation at 00:52:55 UTC found
`CPU_PROFILE_PHASES=scan,monitor`. That setting does not arm `starting`.
Capturing the remaining startup gap therefore needs both the source release
and a separately approved diagnostic setting change, for example adding
`starting` to the existing phase list. No setting was changed. The correction
adds the ability to investigate; it does not establish the stall's cause or
production performance improvement.

INVARIANTS REPORT: explicit opt-in/default-off, real startup attribution,
phase separation, repeat-cycle capture and cleanup on the named error/return
paths Passed in the focused tests. Existing breaker and book control-flow
tests Passed. Production starting attribution and the cause/remediation of
the 66,197-ms starting duration remain Not Verifiable. Next: root review and
the combined release gate.
