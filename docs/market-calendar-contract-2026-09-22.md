# P2c shared calendar evidence: first implementation slice

Authority: revision 3 sections 12, 15 and 17. Base main is
`f06030f9ebb1fb11a64bdb06709577d6d522d8d2` after the owner's #1008 merge.
This is an observation/read-model contract, not completion of P2c or a new
entry gate. The old trading-hours consumers remain on their existing behaviour.

## Identity and evidence

The conservative identity is provider + broker host + registered account ID +
broker instrument ID. Accounts do not share feeds merely because ticker strings
match. IDs preserve decimal precision; unsafe numeric IDs, missing identities
and unexpected providers/hosts are rejected. Credentials are never persisted.

The existing symbol-hours request records its full-symbol response into an
identified side channel without another broker request. Only a requested
instrument from the requested account is captured. Failed refreshes do not
advance observation time. A later invalid calendar does not turn an older good
calendar into current evidence. Last-valid evidence is retained for diagnosis.

Each record carries schema, source, receipt time, version, expiry and raw
calendar fields. `sourceTimestamp` is null because the symbol message does not
supply a calendar event time. The 24-hour maximum age is an explicit advisory
read-model limit aligned with the existing daily metadata refresh; it is not
a changed trading threshold. Restart does not renew evidence.

Weekly intervals use the symbol's IANA zone. Holidays use their own date/zone,
recurrence and explicit intraday boundaries. These fields follow the official
[Spotware model reference](https://help.ctrader.com/open-api/model-messages/#protooaholiday)
and [interval reference](https://help.ctrader.com/open-api/model-messages/#protooainterval).
The reference does not establish the business meaning of omitted optional
holiday bounds, nor of the `startSecond: 0, endSecond: 0` pair production sends
on its full-day "Closed" rows (measured 26-09: every unresolved row), so a
current or future such row keeps the calendar unknown until the owner decides
its meaning (K3). V3 K1b: a non-recurring such row dated three or more UTC days
before its observation lies behind every evaluation window and is skipped — kept
in the stored payload (version unchanged), never evaluated, and listed as
`holiday_expired_ignored` (`expiredHolidays` on the identity and coverage
reads). Missing,
malformed, stale, future-dated, mismatched or unversioned evidence returns
`MARKET_STATUS_UNKNOWN`, never a permissive inferred open state. Calendar
OPEN/CLOSED is distinct from the symbol's trading mode and account admission.

`GET /state/market-calendar?account=<registered-id>&symbolId=<broker-id>` exposes
the contract without broker I/O. It requires explicit account identity, resolves
the broker host from that account's registry and bypasses the response cache so
an old OPEN response cannot conceal expiry or newly invalid evidence. The
one-account-model allowlist adds exactly two registry-host routing references;
there is no new policy distinction between account environments.

## Verification and remaining dependencies

Twelve new behaviour tests cover isolation, precision, provenance, malformed
inputs, exact expiry, failed refresh, restart, DST, week wrap, intraday breaks,
holiday recurrence/early close, trading modes and the real refresh/HTTP paths.
The existing ten symbol-hours tests remain unchanged. Full gate results are
recorded on the PR; C++ source and broker writers are unchanged.

This branch is implemented/tested locally, not merged, deployed or verified on
runtime inputs. #1008 is independently merged and Railway reports successful
deployments. Its later account-edit race review is addressed in a separate
follow-up, keeping that correction reviewable.

Remaining P2c work: reconcile the intended account roster; collect identified
metadata for every intended feed using a bounded refresh schedule; confirm real
holiday payload variants; define shared quote/bar/source-age contracts; then
wire watchdog and scanner consumers. The initial capture sees only accounts
already visited by the current refresher. No missing account is reported healthy.
Do not promote this advisory endpoint into admission before that acceptance.

Fresh read-only protection evidence after #1008: checks at 14:49:39-40 SGT,
relayed at 14:49:49 SGT, report 39 positions across seven accounts, zero missing
SL and two missing TP1 (demo suffixes 9908 and 0949). This remains unresolved,
dated account-level evidence. No target price or broker amendment is inferred.

Preserved: numerical risk limits, mandatory TP1, manual ownership, account
isolation, validation thresholds, mode settings and P1 protection reserve.
Rollout still requires the controlled restart boundary in revision 3 section 18;
no deployment is performed by publishing this implementation.
