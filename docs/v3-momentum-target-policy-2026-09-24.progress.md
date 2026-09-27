# Momentum target integration progress

Version 1 - 27 September 2026

## 27 September 2026, 16:24 SGT - continuation checkpoint

Stage 5/6, Execution. Continuation of the owner-authorised T4 option (a) and OD-15 in the 15:12 SGT handover; the owner explicitly requested continuation for Sydney readiness. The original policy contract remains unchanged. The approval conflict for future fresh builds remains deferred.

Implemented locally: open-market HTF limits carry a durable target plan before submission; resting exposure counts toward the existing account cap and margin; a confirmed fill transfers its original plan into deferred binding. Closed-market limits remain refused on the T4 path, and the enabled account list, cap values, volatility sizing and qualification thresholds are unchanged. Scanner observation fixes, gateway mirror diagnostics, session-connect coalescing and the latent armed-cell diagnostic are included in the same continuation.

Evidence so far: 40 proposal/contract/legacy-limit checks and 39 T4/routing/status/exposure checks passed. The full agent gate found the new transport missing from the execution inventory and the host-identity check missing from the routing audit. Both omissions were fixed; the inventory and one-account-model suites passed on rerun. Lint found an obsolete refusal constant in a test; the remaining reference was replaced with the historical refusal string, without relaxing the assertion. A frontend JSON report exposed one 5-second timeout among 1,311 tests; the isolated affected file passed 12/12. Full regression and C++ compilation continue.

Next: finish the required gates, record exact results, push the continuation branch and prepare a draft PR. No independent checker review is claimed. Production remains on the observed main commit cf121d4; nothing has been merged, deployed, restarted or changed at the broker.

Timeline: code work is progressing toward the owner's 28 September 05:00 SGT deadline (derived from the stated 13h10m, not a verified broker opening time). Production readiness remains conditional on review, deployment approval, the scanner feed URL correction and the owner's account-selection decision. Gateway changes/restarts, re-arming, stuck-exit retries, sizing policy changes and OD-24 research remain outside this execution.

## 27 September 2026, 16:27 SGT - enrollment check

Stage 5/6, Execution. Extending the restart/fill test through actual enrollment exposed a real gap: the existing partial-ownership reader accepted only `bot_market_dispatch`. Fixed it to admit `bot_pending_fill` only when the resting-plan ledger, target intent, risk approval, confirmed broker position and book ownership all match. Merely changing the origin label cannot grant authority. The extended limit test and existing ownership/runtime suites passed 27/27.

The first full agent run completed: 7,118 tests in the main group, with 7,112 passing, two failures (the already-corrected inventory/routing registrations) and four skips; isolated latency 30/30 and hygiene 6/6 passed. The private test directory was empty. The latest full frontend JSON report passes 1,311/1,311 with two workers. A clean final backend run follows the ownership correction. C++ full compilation remains in progress. Production and owner-gated decisions are unchanged.
