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

## 27 September 2026, 16:37 SGT - local evidence and draft handover

Stage 6/6, Evidence. Local code gate met; independent review and production gate remain open. Final backend command `node scripts/run-agent-tests.mjs` exited 0: 30/30 isolated latency, 6/6 isolated hygiene, and 7,116/7,119 in the main group with three skips and zero failures. Total: 7,152 passed, three skipped. The private TMPDIR was empty. Full frontend JSON output: 1,311/1,311 passed, zero failures. ESLint, Vite production build, no-green check and `git diff --check` passed. All 40 C++ execution test binaries and the production binary compiled and passed; the changed scanner-mirror test also passed ThreadSanitizer. One initial native output was an empty generated binary; it was removed and rebuilt, then the full native gate passed. No test threshold or timeout was relaxed.

Draft PR: https://github.com/ang-kl/bot-trade/pull/1170. The connected GitHub plugin transferred the source because shell Git lacked write credentials. The remote tree matched the locally committed tree exactly. The code commit is `9fa2cb3852d5a3902a063a2b87370aa4e4387861`; this checkpoint changes documentation only. CI on the PR is running as this entry is written. The PR body and checks provide the subsequent result without treating a prior commit's check as the new head's check.

The automated review job's actual code-review step was measured as skipped. It is not independent review evidence. No checker agent, live scanner recovery, production fill or partial-close proof is claimed. The owner must explicitly approve any merge/deployment under the uploaded production rule; the separate mirror URL/restart and account-selection decisions remain outstanding. The change is not presented as Sydney-ready in production or as proof of win-rate/profit-factor improvement.

Final invariant disposition: account isolation, native protection, durable plan before send, accepted-versus-filled separation, restart recovery, sole partial ownership, resting cap/margin reservation, unchanged policy values, observational scanners and bounded credential/mirror behaviour passed their named tests. Production recovery, independent review and realised profitability are Not Verifiable from this build. Next: finish PR CI, obtain independent review and the owner's scoped production decisions, then deploy/read back only within those approvals. Earlier review threads remain queued behind this continuation.

## 27 September 2026, 16:44 SGT - lost-reply exposure correction

Stage 5/6, Execution within the same OD-15 invariant. A lost reply can leave `pending_orders.order_id` empty even though the ledger already knows the broker order id. The exposure union used different keys for those records and over-counted one order. The extended restart regression failed before the correction. The union now uses the ledger's exact broker order id when the local row lacks it; two distinct broker ids still count twice even if they carry the same intent tag. Targeted limit/exposure checks pass 8/8. Full backend and final-head CI are rerun for this correction; frontend and native source are unchanged. The earlier successful results remain evidence for their recorded revision, not a substitute for this head's gate. Production and independent-review gates remain open.
