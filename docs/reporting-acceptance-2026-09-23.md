# Reporting and history acceptance

The Performance page now exposes the retained first-blocker evidence through
`GET /state/blocker-report`. An explicit registered account or `all`, UTC window
and bounded detail page are required. Totals cover the full retained population;
detail pagination does not change their denominator. Unassigned records are
excluded from individual accounts and counted separately.

Recorded upstream stops, gate refusals, post-approval failures, approvals and
other stops remain separate. A management skip or unknown stage cannot establish
which entry checks ran. Missing checks remain unrecorded and downstream checks
after a known entry stop are not evaluated. Approval does not prove submission
or fill. Repeated refusal counters cover a row's lifetime, not exact attempts in
the selected window; duplicate observations across logs are not unique signals.

Account history requires two comparable observations at different times before
reporting change or sampled drawdown. A single reading remains monetary evidence
without becoming a zero return. Page change explicitly names its observation
span. Older observations are accessible in the UI; incomplete batches do not
claim complete cashflow-adjusted change or drawdown. Browsing older history
freezes the requested time window, and account changes reset the reader. The
Performance local clock names the actual device timezone.

Behavioural acceptance covers the real Express routes against an isolated
SQLite database, complete totals beyond the detail cap, UTC boundary handling,
account isolation, malformed evidence, read-only behaviour, cashflow adjustment,
single and simultaneous observations, and the rendered empty/unavailable and
paginated states. No production credential, account setting or target policy
is changed by these reads.

Production acceptance is not complete: the available browser session is not
connected to the agent. Its unavailable state was observed; authenticated real
account API/UI and mounted retention/cashflow coverage still need readback.
Fixture results must not be represented as production history acceptance.

Post-merge classification review: successful pending, closed-market and HTF
placement receipts are retained as `placement_receipt`, outside risk-approval
totals. A receipt proves recorded placement, not a fill or a second gate
evaluation. JSON boolean checks are parsed structurally. The submission-boundary
`symbol_position_cap` is a post-approval failure; the established
`regime_block`, `evidence_gate` and `producer_retired` stages are upstream.
Fixture regressions cover these cases, account scope, pagination and rendering.

The workspace disconnected during the scanner integration gate on 23 September.
These reporting corrections are therefore published through GitHub and require
the full PR CI gate; no local execution is claimed for this follow-up.
