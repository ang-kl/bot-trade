# Disconnected reporting acceptance follow-up

After #1031 deployed successfully, the secure browser connection request was
interrupted. A fresh production readback still showed Agent not connected.
No credential request was repeated and no authenticated acceptance is claimed.

The disconnected Performance page exposed a separate display failure: a correct
top-level unavailable warning coexisted with lower panels claiming no open
positions, nothing closed, zero target counts and an unarmed equity stop.
The legacy cashflow panel also incorrectly said ingestion was not built, and
the Data Feed panel treated the page-load clock as fresh market-data evidence.

Position and journal responses now need a well-formed array and the exact
requested account identity before an empty result can be presented as observed.
Failed reads and scope switches remain unavailable. The position groups,
quadrant cards, journal sample, debrief, data-feed counts and their expanded
views preserve that distinction. Journal emptiness refers only to its retained
sample, not the full period. Missing risk configuration stays unverified. The
legacy cashflow panel directs readers to the account-history coverage without
claiming zero transfers, reconstructed balances or absent ingestion. A page
refresh is not shown as a market-data receipt; unverified money has no invented
USD prefix. These changes affect presentation only, not trading decisions.

Acceptance includes a full disconnected-page render, exact-account/malformed
response checks, observed-empty versus unavailable components and a populated
journal observation. Production disconnected readback follows the full merge
gate. Real account history/cashflow acceptance remains blocked on a secure
connection. Scanner activation, target policy, remaining timeframe strategy
ports, peak-load acceptance and actual alert delivery remain separate work.
