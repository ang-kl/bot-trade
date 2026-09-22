# P2 account-edit follow-up: preserve untouched broker inputs

Authority: revision 3, P2; base main `f06030f9ebb1fb11a64bdb06709577d6d522d8d2`.

#1008 was merged by `ang-kl` at 14:40:15 SGT on 22 September 2026.
Both PR checks passed. Railway subsequently reports all four production services
successfully deployed from that SHA. This records the owner's merge and the
observed deployments; the continuation did not request or execute a deployment.
Authenticated UI acceptance remains unverified.

The post-merge review found a real stale-write race: the form posted both values
even when only one was edited. A broker refresh between load and save could
therefore be overwritten by an untouched input. This follow-up records edits
per field and posts only those fields with the displayed account identity.
Reload/account changes reset that set; failed saves retain it. The form is
disabled during a load/save so edits cannot be lost during acknowledgement.
An empty edited field reaches normal validation rather than becoming zero.

Regression evidence includes an actual HTTP load, an intervening broker-style
state update, and a one-field save, in both directions. Zero balance, account
isolation and invalid-request atomicity remain covered. No risk limits, broker
writers, ownership, credentials, modes or validation thresholds are changed.

Local gate: 5,206 Node tests pass, one existing skip; 904 Vitest tests pass;
ESLint, production build and no-green check pass. The generated control inventory
was refreshed. PR CI is separately required; publication is not a merge or a
deployment. Browser acceptance remains blocked as recorded in
[the continuation record](revision-3-progress-2026-09-22.md).

Release boundary remains revision 3 section 18: all services follow `main`, so
even this UI-only merge triggers gateway restarts. The owner's #1008 merge does
not by itself supply ongoing rollout scope/preflight for subsequent changes.
