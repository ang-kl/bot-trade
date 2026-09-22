# P2/P4 tamper handling: account and position identity

The primary loop passes broker credentials with an explicit account to
`restrategizeAfterTamper`. The consumer previously ignored that account when
finding the monitored position, loading its balance and loading risk settings.
A duplicate broker position ID could therefore update another account's ledger
row or derive amendment levels from that row while sending to the supplied
broker account. This is a source-level defect, not a claim that it occurred live.

The lookup now requires the supplied account. Either the linked trade or monitor
may identify a legacy NULL stamp, but both must agree when populated. Wholly
unattributed, foreign, contradictory and duplicate matches are skipped with an
explicit reason before market reads or amendments. Named balance and effective
risk configuration belong to that same account. The existing primary-loop call
already supplies it; no selected/global fallback is added.

Manual SL/TP edits remain audit-only. The existing reversal algorithm, toggle,
numerical defaults, mandatory-target calculation and broker adapter are unchanged.
A missing risk input is reported as an incomplete comparison rather than
"Within your risk limits". No live positions, settings or credentials were changed.

Behaviour tests run the actual consumer with duplicate IDs on two accounts,
different balances/overlays, manual-level edits, scoped reversal calls, conflicting
or absent ownership and duplicate local rows. Amendments are injected test fakes.
Full local/PR gates and the section 18 release boundary still apply.

Local full gate on main `39fd687`: 5,238 Node passes and one existing skip;
911 Vitest passes; zero-warning ESLint, production build, no-green and entrypoint
syntax checks pass. All Node test files ran, with one concurrent file. PR CI
is required separately. No live broker call or Telegram delivery was used.

This is not the complete P4 writer contract. In particular, reversal market-data
freshness/feed resolution, no-read fallback, broker read-back, manual handover and
coordination with other writers remain separate work. No new writer is activated
and no ownership transfer is asserted. Account isolation must precede those changes.
