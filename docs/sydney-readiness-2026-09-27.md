# Sydney readiness continuation

Version 1 - 27 September 2026

## Outcome and authority

This branch continues the owner's T4 option (a), OD-15 and four diagnosed code defects from the 27 September 15:12 SGT handover. The main baseline is `cf121d4f2e58ba7b480f4b371e8fe4eff3934b4f`. The updated handover draft was read at `9f33c7d72981fd919fb7d4ad4a33f06a9d54a710` (PR #1169); it is newer than main's handover text. The old `claude/w2-t4` branch has no unmerged continuation to recover.

The requested deadline is 28 September 05:00 SGT, derived from the owner's message. This is a readiness deadline, not a broker-calendar assertion.

## Six-stage reassessment

1. Intent: complete this continuation before moving to the owner's earlier review findings. A reviewable change and passing required checks are the code done-check; production readiness additionally requires approved deployment and live readback.
2. Interpretation: open-market higher-timeframe limits may resume with the target plan after OD-15. Closed-market momentum orders remain refused. This is distinct from the unresolved choice to reduce volatility sizing or add a 1.5% ceiling.
3. Assumptions: the approved account list and numerical caps remain authoritative. The proposed `/feed` correction is an inference from the 404 evidence; gateway variable values were not read. No scanner-account selection is inferred from the user's login.
4. Invariants: account isolation; mandatory native protection; durable plan before send; broker-confirmed fill before binding; no duplicate submission on uncertainty; resting capacity and margin reservation; unchanged sizing, thresholds, scope and scanner order authority.
5. Execution: local code changes listed below. No runtime settings or broker operations have been performed.
6. Evidence: the completed full local gate recorded 7,152 backend passes, three skips and zero failures; 1,311 frontend passes; 40 C++ test binaries and the production compile passed; the changed mirror test passed ThreadSanitizer. Subsequent exposure corrections passed eight targeted checks and require final-head regression and CI. Independent review, PR CI and production readback are separate gates; see the progress log and [PR #1170](https://github.com/ang-kl/bot-trade/pull/1170) for their current recorded state.

## File changes

| Files | Change and purpose |
|---|---|
| `agent/services/momentum-limit-entry.js` | Open-market HTF transport. Reads owned fresh evidence, uses the existing sizing gate, and atomically rechecks risk and records the permit, pending order, TP1 plan and USD margin before sending. |
| `agent/services/momentum-limit-entry.test.js` | Pre-send persistence, account/market refusal, atomic rollback, concurrent capacity loss, accepted-versus-filled distinction, restart recovery and deferred plan enrollment. |
| `agent/services/momentum-target-proposal.js`, `.test.js` | Limit entry is distinct from the fresh quote; retains price-grid, identity, freshness and cost checks. |
| `agent/services/momentum-entry-producer.js` | Reuses target formulas at the approved limit price and reads broker maximum volume. Market defaults are preserved. |
| `agent/services/momentum-entry-contract.js` | Stores immutable resting plans against entry intents; transfers only an unambiguous account/position-linked confirmed fill; status reports both wired entry paths. |
| `agent/services/momentum-partial-ownership.js` | Admits a resting fill only with matching immutable plan, approved entry intent, confirmed position and book ownership; an origin label alone grants nothing. |
| `agent/services/momentum-partial-runtime.js` | Recovers a fill transfer after restart or delayed ledger reconciliation before running the existing deferred binder. Per-row failures are visible. |
| `agent/loop.js` | Routes the existing open-market HTF branch through the new momentum transport for already-enabled accounts only. |
| `agent/services/momentum-entry-t4.test.js`, `agent/routes/momentum-target-status.test.js` | Checks the revised authorised routing and producer-status declarations. Closed-market and unlisted-account protections remain covered. |
| `agent/services/resting-exposure.js`, `.test.js` | Account-scoped order union, correct lots-versus-units interpretation, broker/local deduplication and fully filled adopted-position replacement. Partial fills retain a conservative reserve; distinct broker order IDs cannot borrow another order's fill or margin proof. Includes manual broker entry orders. |
| `agent/services/risk.js` | Adds working entry orders to existing position caps and adds explicit resting-margin reservation to used margin. Unknown pending margin blocks new margin allocation. |
| `agent/services/closed-market-limits.js` | Protects T4 reservations from clock-only expiry or missing broker snapshots; ledger evidence settles terminal exposure. |
| `agent/db.js` | Adds an index for account/order lineage lookups used in resting exposure. No destructive migration. |
| `agent/lib/entry-producers.js`, `agent/lib/one-account-model.test.js` | Inventories the new transport and explicitly audits its account-host identity check. It receives no independent producer authority. |
| `agent/config/momentum-entries.json` | Updates the explanatory note only. The switch and account list are unchanged. |
| `agent/services/scanner-collector.js`, `.test.js` | Starts the comparison-drain budget after mirror polling so a slow mirror read cannot starve page one. |
| `agent/services/scanner-feed.js`, `agent/services/scanner-bridge-start.test.js` | Reports account/profile mismatch, rate-limits repeat warnings and preserves profile identities. |
| `src/components/ControllerRuntime.jsx`, `src/components/controller-groups.test.jsx` | Displays the mismatch warning outside the collapsed scanner details. |
| `agent/lib/exec-engine.js`, `agent/lib/exec-session-concurrency.test.js` | Serialises same-gateway session connects, coalesces equivalent requests, preserves account additions and honours forced resends. Separate gateways progress independently. |
| `cpp-exec/src/scanner_mirror.hpp`, `.cpp`, `cpp-exec/src/tests/test_scanner_mirror.cpp` | Logs bounded rejection/recovery diagnostics, including a `/feed` hint on 404, without logging URLs, credentials or quote payloads. Retry semantics are unchanged. |
| `agent/services/armed-cell-reachability.js`, `.test.js` | Labels unsupported armed timeframes as latent while scan dispatch is retired. No arming changes. |

## Production decisions and readback

- Deployment is not included in the current execution. The uploaded CODEX-adapted instructions require explicit approval for production deployments. Main is connected to automatic deployments, so merging would itself be a production action.
- Correct the tick mirror endpoint on both gateways only after the owner approves the scoped variable change and restarts. Verify 202 responses and increasing tick-comparison cursors afterward. Local code cannot cure an external 404 by itself.
- The owner must choose whether scanning returns to account ending 0058 or profiles are registered for account ending 9908. The warning deliberately makes neither choice.
- Preserve the account's existing five-position cap and the book cap. If six positions remain on the account, the new path must refuse entry until capacity returns.
- Existing uncertain orders retain reservations until broker evidence resolves them. This can reduce available capacity; it must not be cleared merely to create room.
- Pending margin is a conservative additional reserve. Some brokers may already include it in used margin, so the estimate can double-reserve that component; no unproven overlap is subtracted.
- Partial or off-grid fills still use the existing strict binder. If exact volume and bracket evidence cannot be proved, the partial plan waits; native broker protection remains. No claim of all broker fill variants being supported is made.
- No live performance trace, production fill/partial-close proof or independent checker review is claimed by local unit results. Tests cannot establish the target win rate or profit factor 1.71.
- The three stuck exits, sizing-policy choice and OD-24 remain owner decisions. The earlier two review threads follow this continuation, as requested.
