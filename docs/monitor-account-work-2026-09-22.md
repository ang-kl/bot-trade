# P4 fast-monitor account routing and completion receipts

The fallback broker quote and relative-volume read previously used the selected
account's session and global symbol map for every position. A position on a
different account could therefore be evaluated using another instrument.
Fallback reads now use the held account's map and registered host. Missing
identity is visible and does not fall back to another account. Existing primary
account/legacy handling is retained. Volume/spike/frozen-quote caches are scoped
by host, account and instrument. Crossed, non-finite and future sidecar quotes
cannot establish a completed evaluation. The existing quote age and all risk,
strategy and cadence values are unchanged.

`fast_monitor_position_work_json` records each active, unpaused position's
evaluation state, last completion, next due time, quote source and action
outcome. It replaces the previous population on each completed pass, retaining
last completion on an unsuccessful attempt. It is bounded at 2,048 rows with
explicit incomplete coverage above that limit. A HOLD is completed work. An
error or unavailable quote is not. Reported action success is labelled as such;
it is not a new independent broker-confirmation claim. External positions remain
observe-only. Busy ticker receipts explicitly say `completed: false`, preserving
the overlap guard without presenting its timer as a finished pass.

Full local gate: 5,245 Node passes, one existing skip; 911 Vitest passes;
ESLint zero warnings, build, no-green and syntax checks. Existing tests that
asserted the incorrect primary-account fallback IDs now assert the held
account's IDs. New integration checks exercise both broker hosts, missing maps,
malformed/future quotes and actual completion receipts.

Implemented and locally tested; PR CI/merge/deployment/runtime acceptance are
separate. No mode, credential, live position or numerical limit changed. This
does not complete P4: exclusive writer transfer, account configuration/source
age, broker read-back across all writers and percentile latency acceptance
remain. Receipt timestamps are evidence for that work, not permission to
activate tick management. Gateway restart/rollout remains subject to revision 3
section 18; rollback owner is Adrian Ang.
