# V3 watchdog calendar correction

Production observation at 12:45Z showed fresh probes for all five required
services, muted delivery and missing calendars on multiple accounts. No alert,
restart, feed activation or credential change was made.

Three demonstrated code defects are corrected:

* Watchdog and scanner readers expected a flat account symbol map, while the
  actual credential helper persists `{builtAt,map}`. They now use the shared
  account-specific reader. Tests use the real envelope and retain wrong-host,
  wrong-symbol and cross-account rejection.
* The daily symbol-hours refresh only covers the selected account. A separate
  observation-only collector reads existing position/legacy-scanner/native-feed
  identities, up to 512, at most 25 symbols on one account per minute. It runs
  only with fresh enabled watchdog observation. One batch remains in flight;
  failed accounts cool down and others progress. No new feed is subscribed.
* Alphabetic calendar export could exclude held positions after a large universe
  refresh. Active demand now precedes retained cache entries. Invalid broker
  holidays remain unknown and carry their precise validation reason.

The collector retains request/record/unknown counts and errors under
`watchdog_calendar_refresh_json`. It does not treat failed reads as fresh
observations or alter legacy entry-calendar policy. An individual transport
request uses the existing 2-second timeout and transport retry semantics;
non-overlap prevents timeout/retry pileups. This is not a hard broker deadline.

Calendar coverage still requires production readback. This does not establish
Telegram delivery, incident-owner handoff, outage recovery or external observer
acceptance. Those drills remain Not Verifiable until explicitly authorised and
executed. Notification master, credentials and ownership are unchanged.

Release scope: Node only. Observe refresh counters and account/feed calendars
for all existing work, including no-signal/zero-order evidence, before accepting.
Rollback: restore the previous Node deployment; observation data is additive
and old readers ignore it. The former calendar defects then return.

Verification at 13:01Z: full local merge gate passed, including 28 isolated
HTTP-latency tests, all remaining backend tests, 936 frontend tests, ESLint,
production build and no-green. The initial gate caught the new routing helper
missing from the exact-count account-model allowlist; its three host-routing
uses are now documented there. No account eligibility distinction was added.
