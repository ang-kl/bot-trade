# RSI option parity — observation only

P5c continuation from merged #1045 (`761bf3810851aa757636c94fa1d56ecd451bd236`).
The native timeframe worker now mirrors the existing RSI mean-reversion
`minRr` option. The JavaScript decision owner, live default of 1.5, account
settings, risk gate and strategy configuration are unchanged. This is an
observation calculation; it cannot submit orders or change admission policy.

The effective finite, nonnegative numeric floor is carried through the existing
bounded publisher. An exact single-key option schema and IEEE-754 profile hash
bind the worker request, result and comparison to that floor. Strings, booleans,
negative/nonfinite/unsafe values, extra keys and mismatched hashes are refused.
Null/omitted reference options retain the unchanged default profile. Zero is a
supported observation value; it does not lower the live risk gate. The native
comparison uses the reference's rounded R:R before applying the floor, including
acceptance at equality. The other trend, target and warm-up gates remain intact.

76 frozen fixtures are generated from the actual JavaScript function across
both directions, warm-up/cross refusals, zero/fractional/maximum safe floors,
exact equality and just-above boundaries. Two bar series refused at the default
floor produce candidates at a lower observation floor, making the option's
behavior observable. These fixtures and the existing 186 default/EMA cases
pass native evaluation and the real local HTTP publisher/collector comparison
path: 262 matched records, zero entry intents. The generator never uses native
output as expected evidence.

The native reference, input-refusal and session/volume tests pass. The complete local
gate passed with Node 22 and TZ=UTC: 28 isolated plus 5,336 other backend tests
(5,364 total), no failures/skips; 935 frontend tests; zero-warning lint; build;
no-green; entry-point syntax; and UI inventory (119 wired sites, 97 state
reads, no half/decorative controls). All 11 local HTTP tests passed. Binary
symbol inspection found no broker execution/order-amendment symbols. PR CI
remains a separate gate recorded in the accompanying pull request.
This is fixture parity, not representative market-load or production-feed
acceptance. Remaining Fibonacci/filter/volume/FVG options are not declared
supported. No validation threshold or production setting changes.

## Deployment observation and boundary

At 17:25 SGT on 23 September, GitHub confirmed #1045 merged and Railway reported
all six services successfully deployed that commit. Node still had no scanner
bridge/feed variable names, both new scanners had only PORT/SCANNER_SECRET,
and neither scanner had a public domain or broker credentials. Connector values
are redacted. No activation or variable write was performed.

The existing main tracking also restarted both broker gateways. Returned service
configs still have no watch filters. This follow-up is prepared for review;
manual release remains governed by `v3-release-readiness-2026-09-23.md`.
No fresh position-level broker audit was available in this continuation, so the
15:16 protection counts in the progress document remain dated evidence.
Rollback owner: Adrian Ang. Version 3 remains incomplete.
