# P1: preserve a healthy independent checker across Node restart

Intent: a Node-only restart must not reset an already healthy independent
protection session. This is within the owner's continuing startup/protection
build authorization; it does not change a trading permission or broker order.

Observed on #1074 and #1075: native verifier deployment unchanged, fresh
seven-account readings before release, then every reading absent after Node
restart until a new verifier cycle. Node's makeIndependentProtectionPoll keeps
credential fingerprints only in process memory. It always POSTs /connect on
its first poll because that map is empty. cpp-verify's protection connect
replaces the session and its observations. The read-only status already reports
open authenticated sessions, their account roster and timestamped broker checks.

Correction: on the first poll only, reuse an open session whose exact account
roster and fresh, valid independent readings match this host. Adopt the current
credential fingerprint locally. Later credential changes still reconnect;
missing sessions, roster mismatch or absent/stale/invalid first readings still
provision normally. No status-only session may prove protection.

Scope: independent-protection service/tests, this evidence and closure/serial
records. No native service or credential/configuration changes.

Invariants: existing fresh broker timestamps survive Node startup; stale/invalid
or mismatched evidence cannot justify reuse; credential/roster changes and a
verifier restart reconnect; all registered accounts remain covered; no secrets
enter diagnostic output; failed reads remain unverified. Tests must reproduce
the needless reconnect before correction and exercise each refusal condition.
Production acceptance requires a fresh deployment and seven-account readback.

## Local verification — 24 September 16:18 UTC

The restart regression failed before the correction (one unwanted connect),
then all seven focused tests passed. Full backend gate: 5,460 passed (28
isolated plus 5,432 other), four existing native skips; frontend: 943 passed
with two workers. Full ESLint, production build, colour check, control inventory
and whitespace checks passed. No existing assertions or thresholds changed.
First-poll reuse does not claim that the native process uses the newly read
credential bytes; it proves an open, exact-roster authenticated read session
with fresh broker observations. Subsequent credential changes in this Node
process force reconnection. No credential material is persisted or logged.
