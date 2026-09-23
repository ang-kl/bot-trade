# Reasons report scope correction

Authenticated reporting acceptance found the Reasons page stamped every card
with "All accounts". The trade-consistency response actually identified the
selected account, 46130058. Attribution, open-duplicates and exit replay also
support account-specific reads, and phase-audit names its viewed account.
Their numbers could therefore be correct under an incorrect portfolio label.

Cards now use the response's account identity or explicit scope. The five
ledger-wide endpoints retain their portfolio label, and the two optional
account filters treat an explicitly returned null account as all accounts.
Exit-counterfactual now returns the account identity used by its existing
query. It likewise reports null only for an unfiltered population. The two
legacy optional filters now recognise the existing `account=all` view value;
previously they searched for an account literally called "all", returning
an empty population when the user requested a portfolio report.

A failed read or a scoped endpoint lacking identity shows "Scope unavailable
for this read". It cannot acquire an all-account label by default. Browser
view filters, selected trading account, endpoint calculations and scope
selection is unchanged. Tests cover actual two-account route and replay
populations and rendered account, portfolio, failed and missing-scope cases.

Repository gates and authenticated readback remain required. This correction
does not resolve missing P&L, change target policy or activate scanners.
