# Native default strategy coverage

The shared timeframe worker now contains closed-bar reference ports for all
12 per-symbol strategies. This change adds cup_handle, inv_cup_handle,
ema_pullback, rsi_meanrev, vp_value, va_breakout and fvg_retrace to the five
previously supported profiles. The cross-sectional tsmom_long registration
is not a per-symbol strategy and is not substituted here.

The existing JavaScript calculations generate 154 frozen cases with every
permitted direction and explicit no-signal/warm-up outcomes. Native tests
compare economic fields, direction reasons, EMA stop treatment and nested
cup/FVG provenance. The real authenticated HTTP feed, collector and comparison
path also matches the current JavaScript results without creating entry
intents. Diagnostic prose remains with the reference implementation.

New York sessions use the system IANA transition table, installed explicitly
as tzdata in the scanner image. Nine hundred frozen hour boundaries cover
winter/summer and both DST changes under the pre-2007 and current rules.
Twenty-four profile cases check session partitioning, previous-session value
area, low-volume nodes and VPOC migration. Dates outside the explicit table
are refused before queueing; no future DST rule is guessed. Unix-epoch through
2037 coverage is sufficient for current receipts but is an explicit limit.

The observer checks effective options before advertising a default profile.
Changed cup VWAP filters, EMA pending/stack/stop/time-cap settings, RSI floors,
volume-profile/structure overrides and FVG age/environment thresholds retain
the reference owner. FVG compatibility uses the constants actually captured
by the reference at module load. Native requests still reject nonempty options.
Fib remains its separately labelled FX-default, no-filter baseline.

This is calculation and contract coverage, not activation acceptance. Scanners
remain inactive; no deployment topology, account risk, target, enabled-strategy
setting or order authority changes. Non-default/pending parity, representative
peak-load and protection-latency acceptance, watchdog readiness and the explicit
scanner activation decision remain outstanding. Full repository gates and final
review are required before merge. Rollback owner: Adrian Ang.
