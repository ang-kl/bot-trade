# P5a Controllers grouping and work evidence

The Desk groups all 33 active heartbeat definitions into the six groups in
revision 3 section 13. The retired `pending_orders` entry remains in a separate
history section with its explanation. Failures remain visible above the groups;
new unmapped entries are shown explicitly rather than dropped. Gateway aliases
identify the actual services: `cpp_exec` is cpp-acct; `cpp_exec_demo` is cpp-exec.
The eight asset settings are labelled management profiles; their values,
configuration precedence and permissions are unchanged.

Every detailed row distinguishes heartbeat activity from an explicit completion
receipt. Missing completion evidence stays unobserved. A busy tick says it
skipped overlap and did not complete work. Previous resolved errors remain
history; current errors remain faults. P4 position receipts, when present, are
shown alongside account/service status with next due time, evaluation state and
reported amendment outcome. They are not a claim of exclusive writer ownership
or independent broker read-back. There are no new switches or broker reads.

Full local gate: 5,245 Node tests pass with one existing skip; 912 Vitest tests
pass; ESLint zero warnings, production build, no-green and syntax checks pass.
Coverage asserts the complete 34-entry crosswalk and rendered busy/retired/error
semantics. The prior source-only Desk error-label test now renders the extracted
component and verifies resolved/current/absent-flag behaviour.

Browser acceptance is still unavailable in this environment (production Agent
not connected; local browser URL rejected). SSR/component checks are not visual
or authenticated acceptance. Independent alerts, effective configuration and
completion receipts for the remaining jobs still need their own P5a packages.
This grouping alone does not complete P5a. No deployment or activation performed.
