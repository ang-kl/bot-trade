# V3 startup price lookup correction

Intent: implement the owner's directive to continue startup/protection and
account-report corrections through the frozen V3 acceptance register.

Interpretation: the #1073 production profile attributed 36,672.2 ms to
`lastScanPrice` native reads. Its timestamp index requires sorting retained
symbol history to select the greatest positive-price insertion id. Add a partial
covering index for that exact query. Do not alter fundability policy or quotes.

Scope: `agent/db.js`, `agent/services/fundable-price-history.test.js`,
`scripts/benchmark-fundable-price.mjs`, this evidence and the closure/serial
ledgers. This follows the owner's existing build instruction and standing merge
gate. No flow-kit hook installation or approval record is represented here.

Assumptions: production storage/index creation cost remains unmeasured until
release; local benchmark timing is synthetic, never the protection SLA. These
limits cannot be converted to passed acceptance.

Invariants:

- Exact symbol and greatest positive-price id, including out-of-order timestamps,
  null/zero/negative prices and missing symbols: named price-history test.
- Seek without sorting retained history: actual query plan from the exported
  `lastScanPrice` function; regression fails on baseline.
- Retain every scan across migration and repeated restart; retain WAL/FULL:
  upgrade test and benchmark row digest.
- Account routing, volume, order authority, risk limits and report semantics:
  unchanged by the index; existing full repository gate before merge.
- Production startup protection and report deadlines: fresh runtime evidence
  required; later recovery does not erase any cold-start failure.

Execution: both new regressions failed before the correction; 11 focused checks
passed after it. The index's first creation scans retained scans once and adds
write/retention maintenance. Production initialization cost must be retained.

The remaining frozen groups stay open until their own evidence passes.

[Synthetic evidence](evidence/v3-fundable-price-query-2026-09-24.json): 250,000
scans, two populated symbols and one missing symbol; five reads fell from
143–187 ms to 0.053–0.125 ms. Reopen including index creation took 234 ms,
adding 6,553,600 allocated bytes. All row digests and chosen prices matched;
the second reopen was idempotent. These timings are not production latency.
