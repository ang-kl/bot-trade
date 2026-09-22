# Hourly openings: provenance and clock skew

This addresses #1011 review comments 4069347594 and 4069347596. It does not
change trading, risk limits, ownership, credentials or the journal's P&L logic.

Unknown-time rows now retain separate legacy-account and reconciler-adoption
counts. Report-level provenance includes those undated rows; hourly counts
still contain only rows with an opening timestamp in that hour. The UI names
that distinction. Its validator checks provenance totals against both
populations, including the case where every adopted row lacks a valid time.

The request keeps the browser's exact 24-hour window. A boundary up to two
minutes ahead of the server is accepted, but the SQL query stops at the
server's current time. `observedThrough` records that cutoff. An unelapsed
newest window displays a lower bound or `unknown`, never a complete zero.
The same label is used in copied text. Older completed windows retain their
recorded counts. The UI explains the clock difference.

The browser reader also tolerates a server clock up to two minutes ahead;
larger differences, malformed stamps and evidence aged two minutes or more
remain unavailable. This is a bounded reporting-clock tolerance, not a change
to broker snapshot freshness, protection deadlines or validation thresholds.
It cannot prove broker completeness or correct an arbitrarily wrong clock.

Regression evidence covers unknown-time account isolation and adoption,
both clock directions, exact tolerance boundaries, exclusion of future rows,
real HTTP consumption, incomplete-zero labels and corrupt summary rejection.
Local full gate on main `f7255df`: 5,233 Node passes, one existing skip;
911 Vitest passes; zero-warning ESLint, production build, no-green and
entrypoint syntax checks pass. The Node run includes every test file with
one concurrent file. PR CI remains part of the merge gate. Deployment and
authenticated UI/runtime acceptance remain separate; revision 3 section 18
governs the four services that automatically deploy from main.
