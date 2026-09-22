# P2 selected-account balance isolation

`getAccountBalance(db, id)` already refused another account's global balance.
The omitted-id path resolved the selected account but then fell back to that
global for a missing, invalid or zero scoped input. This put a prior account's
budget into the risk summary and sizing preview after a switch, and could turn
an unfunded account into a positive balance.

Named and selected accounts now share the existing scoped behaviour: valid
nonnegative own value, otherwise null. A selected zero stays zero. The legacy
positive global value is retained only when no account is selected or named.
There is no new freshness claim or currency conversion.

The existing missing-balance behaviour is retained: sizing preview reports
unavailable; `/state/risk-config` identifies the resolved account, leaves its
percentage-derived amounts unavailable and displays the existing flat-cap
fallback. The named-account risk/admission path already used this policy;
this change removes the inconsistent selected-account exception. It does not
change risk numbers, mandatory TP1, account modes, broker writes or manual
ownership. A missing balance is not proof that percentage protection passed.

Regression evidence covers named/selected parity, zero, missing/invalid values,
and the actual cached HTTP consumer after account switching and balance writes.
The Watchlist sizing preview is exercised with a real scan price to prove it
does not size from the foreign balance. Full repository and PR gates are
required. Release/runtime acceptance remain separate under revision 3 section 18.

Local gate on `f7255df`: 5,233 Node passes, one existing skip, 909 Vitest
passes, zero-warning ESLint, production build, no-green and syntax checks pass.
The historical test which explicitly preserved the selected/global fallback
now asserts isolation; its named-account cap behaviour is retained. The first
full run also hit this host's intermittent existing 100-ms HTTP latency test;
the complete rerun passed with the test and threshold unchanged. PR CI must
also validate integration with the subsequently merged calendar/hourly fixes.

## Remaining money contract and scope findings

Native-currency producers still write values under USD-named state/column
names: account-equity, the primary loop, boot self-link, account selection and
nightly equity snapshots. Clearing those values without replacement can remove
percentage-based protection caps (`effectiveCapUsd`, equity-stop fallback).
P2 must therefore specify conversion evidence and explicit missing/stale-money
behaviour for both admission and existing-position management before replacing
these inputs. Do not introduce an unreviewed fail-open/fail-closed change or
invent an FX conversion rate merely to satisfy a currency label.

Source inspection also found no-id balance calls in P&L alerts and the tamper
risk audit, plus a position-ID-only tamper lookup. Their passed broker account
and position ownership have separate P2/P4 follow-up branches and call-site
tests; this narrow lookup change does not claim those paths are account-safe.
