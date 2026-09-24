# P0/P3: coordinate rank exits with the partial manager

Intent: continue the approved partial-target build by ensuring a book rank exit
and its partial close cannot both claim the same position. This is software
construction and fixture verification; it does not activate a producer or
submit a production financial action.

Scope: a shared rank-exit service, both momentum book/account close call sites,
their focused tests, the partial-plan status read and this evidence contract.
Existing entries without a partial plan keep their prior close behavior.

Invariant: before a rank exit awaits broker state, it must atomically reserve
the exact account/trade/position plan from ARMED or CONFIRMED. A partial that
already owns SENDING/AMBIGUOUS/RECEIVED prevents the rank close. A rank claim
prevents the partial manager from sending. Full volume must be freshly read
from this plan's broker account/host/instrument and match its expected initial
or residual quantity, with sole current book ownership. No local-volume
fallback is permitted for a new partial plan.

The rank attempt becomes durable before sending. A timeout, crash or invalid
receipt does not authorize a retry. A valid, matching filled closing deal and
a fresh account-scoped absence read are required to confirm completion. A
late original receipt may recover the attempt without sending again. Before
any submission, a failed read can release its reservation; a prior process's
reservation can be replaced only with a different compare-and-set token, so
its delayed continuation can no longer send.

Required evidence: both race orders; initial and residual volumes; invalid
identity, stale read and changed ownership; malformed/foreign receipts;
timeout/late receipt/restart; no-plan legacy behavior; both actual book call
sites use the shared coordinator. This closes rank-versus-partial coordination
only. Producer wiring, other automatic/manual close paths, resting-fill
lineage and natural acceptance remain explicit separate checks.

## Focused evidence and preceding release

The original row-cursor call site sent a competing close in the new behavioral
test. After routing both actual book paths through the coordinator, 124 combined
rank-exit, partial-manager, momentum-account and momentum-book checks passed.
Three additional cases then passed for token replacement, an ambiguous foreign
receipt surviving a disk backup/reopen, and readback recovery without resend.
All existing book assertions are unchanged. Full repository/CI checks remain
required. The new coordinator is reached only for an already-registered partial
plan; this build does not create such plans or activate an entry producer.

#1078 merged as `dbd390f` and deployed successfully as
`c0c9e5ae-e1f2-4c9e-896f-0d63cd11298d`. At 17:18:08Z, the two report scopes
retained their prior rows and statistics exactly; the only JSON differences
were the time-driven pending-bar estimate/countdown advancing five minutes.
The first all-account lesson report took 1,078 ms in the application / 1,280 ms
in the browser; the scoped report took 73 / 396 ms. Account engineering took
83 / 397 ms. DB initialization was 452.32 ms. At 17:19:55Z, a new post-boot
protection pass had completed in 1,682 ms without overruns/skipped bands, and
all seven fresh broker readings covered 32 positions with both SL and TP.
Entry configuration and account phases matched preflight. These are routine
passing observations, not a percentile/load or whole-V3 acceptance claim.
