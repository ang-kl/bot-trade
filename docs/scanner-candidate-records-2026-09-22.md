# Scanner comparison records — P5c

`scanner-candidates.js` provides a durable mirror observation ledger and a
bounded read collector for the two new scanner services. It never issues a
permit or creates an entry intent. `scannerMirrorAdmission()` always refuses
mirror candidates. Existing strategy, account admission, risk/sizing and
one-use intent owners remain unchanged.

Every candidate must match the registered account's broker host and its own
symbol map, an explicit comparison profile/configuration and candidate TTL.
The candidate's stable ID is recomputed from the C++ identity tuple. Source,
receipt, evaluation and expiry times are checked separately; an unavailable
source timestamp remains null. Expired observations remain visible as expired.
A duplicate ID with changed economics is a conflict, not an overwrite.

The collector persists each scanner's process instance ID and cursor. A new
instance forces a read from zero even if its new cursor is already larger than
the previous process's cursor. Gaps, restarts, rejected contracts and verified
no-signal outcomes remain visible. Candidate records and outcome telemetry
retain seven days, bounded at 100,000 rows each; these are observation records,
not extra independent research samples or complete trading histories.

`GET /state/scanner-mirrors` is a no-store read through the existing read-tier
authentication. It reports observation timestamps, gaps, rejection reasons and
retained counts. Reading it never queries a scanner or creates the tables.
An absent observation is unavailable rather than zero activity.

The one-pass `scripts/scanner-mirror-poll.mjs` runs outside the protection/event
loop and requires an explicit `SCANNER_MIRROR_DB_PATH` naming an existing
database. It does not run application startup migrations or install a timer.
Each scanner read has a two-second deadline, a 256 KiB response bound and no
redirects. A failed read does not erase previous observations. Configuration:

- `SCANNER_TICK_URL` / `SCANNER_TIMEFRAME_URL`: service base URLs.
- `SCANNER_TICK_SECRET` / `SCANNER_TIMEFRAME_SECRET`: scanner-only credentials;
  never execution or Node write credentials.
- `scanner_mirror_profiles_json`: explicit array of source, feed identity,
  strategy, timeframe where applicable, configVersion, profileHash and
  candidateTtlMs matching the comparison run.

Absent profiles/endpoints leave collection unconfigured. No configuration,
credentials, scheduling, deployment or candidate ownership was activated here.
Live comparison against the existing producer and any future ownership transfer
must establish strategy parity and the revision-3 safety/readiness gates.
This mirror ledger is not proof that the scanner admission handoff is complete.
