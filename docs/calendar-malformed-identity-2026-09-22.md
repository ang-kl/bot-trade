# Calendar follow-up: malformed stored identity

After #1010 merged, a corrupt cached observation with `schemaVersion: 1` and
`identity: null` reproduced a TypeError in the identity normalizer. The promised
unknown state was therefore replaced by an HTTP error. A malformed last-valid
identity could also prevent a valid current observation from being read.

The normalizer now rejects non-object and array inputs before destructuring.
The regression exercises malformed caller, latest and last-valid identities;
latest evidence becomes unknown, while invalid historical evidence is omitted
without concealing a valid current observation. No trading path, threshold,
broker request or evidence timestamp is changed.

The same decoder rebuilt IANA formatters for every holiday on every symbol. A
local in-memory fixture of 50 captures with 100 holidays in the same zone took
352 ms. A bounded cache of at most 32 immutable formatters reduced the same
fixture to 32 ms. This caches formatting machinery only, not calendar status or
observation time; existing DST/holiday/expiry tests exercise the unchanged
semantics. This is local profiling, not a production latency guarantee.

Separately, #1010's review proposed changing `holidayDate` to milliseconds.
The current official [Spotware model reference](https://help.ctrader.com/open-api/model-messages/#protooaholiday)
and its [protocol source](https://github.com/spotware/openapi-proto-messages/blob/main/OpenApiModelMessages.proto)
define that field as days since 1970-01-01, with a multiplication by 86,400,000
to obtain milliseconds. The existing day-based implementation and fixtures
follow that contract. Do not change units on an unsupported review assertion;
real broker fixtures remain part of P2c runtime acceptance.

Implemented on main `f7255df9f77e925462fa23b4b2f14bc34de417b9` plus this
follow-up. Local full gate: 5,232 Node passes and one existing skip, 909 Vitest
passes, zero-warning ESLint, production build, no-green and entrypoint syntax
checks pass. Node used one concurrent test file after this host intermittently
missed an existing strict HTTP latency check during parallel runs; that test
and its threshold are unchanged. PR CI remains part of the merge gate.

Publication is not deployment or runtime acceptance. Revision 3 section 18
continues to govern the main-triggered four-service production rollout.
