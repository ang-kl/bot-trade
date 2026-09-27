# Sydney continuation review and readback

Version 1 - 27 September 2026

This records the CODEX continuation authorised by the owner's instruction to proceed under chat paragraph 10087.3: finish code review, investigate scanner alignment and assess browser performance. It does not authorise deployment or further production mutations. PR #1170 remains a draft, based on main `cf121d4`. The completed gateway endpoint repair is recorded separately in the append-only progress log.

## Six-stage reassessment

1. **Intent:** make the existing continuation reviewable, fix reproduced failures, identify the operational alignment change and obtain browser evidence. Full V3 acceptance requires additional production and performance evidence.
2. **Interpretation:** this is review/failure-response work already under way, not a fresh strategy build. Code corrections and draft-branch publication are within scope. An auto-deploying merge is a separate production action.
3. **Assumptions:** repository behaviour was checked against source, executable tests and read-only production state. The assumption that a ledger `FILLED` state proves the entire original volume was wrong: it also represents partial fills. The assumption that selecting account 0058 also moves the current gateway quote feed was wrong: the gateway retains a still-authorised feed account. The assumption that enabled registry rows expose `accountId` was wrong: they expose `account_id`. Full browser trace capability is unavailable through the connected browser interface.
4. **Invariants:** account ownership, full-volume proof, cap/margin reservation, forced session recovery, stable account dispatch, observational scanner authority and explicit production scope remain mandatory. Their checks and limits are listed below.
5. **Execution:** corrected the three defect families below. Runtime inspection used read-only endpoints and read-only SQLite. No account selection, profile registration, order, position, activation, cap or sizing was changed by this review.
6. **Evidence:** regression tests, cross-review, measured UI readiness and a production screenshot provide bounded evidence. None proves the complete V3 goal, a target win rate, profit factor 1.71, or production acceptance of this undeployed branch.

## Reproduced failures and corrections

| Files | Failure and correction | Verification |
|---|---|---|
| `agent/services/closed-market-limits.js`, `agent/services/resting-exposure.js`, `agent/services/momentum-limit-entry.test.js` | Reconciliation could remove a partial fill's remaining reserve when the broker working-order snapshot was absent. It could also remove the only counted slot for a fully filled OPEN trade before an active account-owned monitor existed. Release now requires original-volume and account/position proof plus a counted active monitor, or a fully closed trade. Unknown, partial, missing-monitor and wrong-account cases retain the reserve. | Two reproduced failing cases corrected; 51 focused limit/exposure/contract/ownership tests passed. |
| `agent/lib/exec-engine.js`, `agent/lib/exec-session-concurrency.test.js` | Equivalent callers shared a successful connect but repeated a failed connect sequentially. They now share the same in-flight failure; an explicit force still queues a fresh attempt, different rosters remain serial and a later retry remains possible. | 58 focused session/engine/roster tests passed. Deterministic mock: three failing connects finishing at 101/201/302 ms became one connect, with all callers failing at 115 ms. This is a unit experiment, not live gateway latency. |
| `agent/routes/actions.js`, `agent/routes/selected-account-roster.test.js` | Selection read raw registry `accountId`, writing literal `"undefined"` roster entries. Both ID references now use `account_id`. Two new optional hooks in the existing router dependency object allow the real route to exercise broker reads with test substitutes; production defaults are unchanged. | Eight selection/capability tests passed, including forward selection and rollback, seven unique valid IDs, unchanged dispatch and phase flags, and preservation of nonselected paused/manage-only/autopilot-disabled accounts. |

The source was cross-reviewed by separate CODEX agents. That is adversarial code review, not an independent production checker. GitHub's earlier automated review job skipped its reviewer action; its green badge is not review evidence.

### Remaining conservative fill limitation

A final partial fill followed by cancellation or expiry of its remainder can retain its reservation indefinitely. The ledger's `FILLED` state takes precedence over later remainder events, and the current TP1 binder requires the original full volume. Safely supporting this case needs account/order-owned terminal evidence, a subsequent fresh reconcile proving no working remainder, and correctly monitored filled exposure. This review does not clear uncertain reservations or claim complete partial-fill lifecycle acceptance. Native broker SL/TP presence does not establish TP1-manager enrollment.

The existing successful-session memo also does not automatically distinguish client-ID/client-secret rotation when the access token is unchanged. Explicit forced resend remains supported; automatic application-credential rotation is not claimed as covered by this correction.

## Scanner alignment - observed state and proposed scope

The 20:08 SGT gateway recovery checkpoint established actual mirror feed accounts ending 9908 (demo) and 3489 (live). Registered tick profiles remain 53 for demo 0058 and 53 for live 9009. The 690 timeframe profiles belong to demo 0058. Transport repair restored observations but did not align profile identities.

At 21:00:16.850 SGT, authenticated read-only account and phase endpoints showed selected account 9908. Both 0058 and 9908 were enabled/active demo accounts, with effective scan, analyze and autotrade true and enter/scan/manage capabilities true. Open positions were six and five respectively, with zero pending orders. No cap or entry-policy change is proposed. Selection of 0058 does not create capacity at its existing five-position cap.

At 21:04:44.090 SGT, read-only SQLite found no active unattributed monitor. At 21:05:25.145 SGT, the stored legacy roster contained one true 9908 role and seven `"undefined"` false roles. The current reader falls back to the healthy registry when fewer than two legacy roles are armed; the malformed record is a persistence defect, not evidence that these seven accounts were currently disconnected.

The supported selection request is `POST /actions/ctrader-select-account` with account 0058 and `isLive:false`. It changes the selected/default scan account, selected-account registry state, symbol map and money caches, and may sweep unattributed active monitors. It is not transactional: a later broker-read error does not prove that earlier writes were rolled back. Returning to 9908 through the same route restores selection, but does not undo audit/cache history. This action was not executed.

Selecting 0058 alone does **not** move an already-authorised tick quote feed (`cpp-exec/src/main.cpp`, retained-feed selection). Two possible tick remedies remain separate from timeframe selection:

- Preserve the recovered feed accounts and add 53 account-correct profiles for demo 9908 plus 53 for live 3489. If coverage is unchanged, the whole registry grows from 796 to 902. Every new row must be built from that account's own symbol map and exact native configuration/hash/TTL. The existing whole-set compare-and-swap endpoint requires its current revision and refuses writes while the bridge is enabled. A concrete deployment action would need a reviewed complete payload, bridge-off restart, exact CAS/readback, and bridge-on restart. That complete payload has not been prepared or approved.
- Add a durable explicit feed-account setting that the gateway uses when constructing both its real quote feed and mirror, validating membership in the authorised roster. Merely changing the mirror label would falsify identity. This alternative needs a separate design, code review and gateway rollout; it is not implemented here.

The first remedy fixes current identities but does not prevent a later cold start choosing another primary account. Blanket registration of 53 profiles on all seven accounts plus the 690 timeframe profiles would total 1,061 and exceed the current 1,024-profile bound.

## Browser evidence

Production remained `cf121d4`. Six fresh tab reload observations were taken in the existing authenticated warm browser context with `?synthetic=trace`, after discarding an initial warmup. Timing used wall-clock time around the browser reload and a visible DOM readiness condition. It includes browser-control overhead and is not LCP, CLS, INP, server response time or a Lighthouse score.

| Page | Readiness condition | Run 1 | Run 2 | Run 3 | Median |
|---|---|---:|---:|---:|---:|
| Performance | Portfolio coverage of recorded closes text visible | 2,810 ms | 3,055 ms | 3,712 ms | 3,055 ms |
| Desk | Account 0058 demo row visible | 3,671 ms | 2,972 ms | 1,985 ms | 2,972 ms |

Performance runs completed at 20:59:32.477, 20:59:51.893 and 21:00:19.972 SGT. Desk runs completed at 21:01:50.384, 21:02:21.078 and 21:02:51.164 SGT. All six reached their condition. Retrieved warning/error samples had no application-origin error; a browser-extension metadata error was excluded explicitly. This is bounded sampling, not proof of zero runtime errors.

The production Performance screenshot was captured at 21:00:43 SGT as `bot-trade-performance-v1-2026-09-27.jpg` and provided privately in the owner chat. It shows the production commit, selected account 9908 and the still-incomplete resting-limit/TP1 integration. Its account-specific profit-factor figure does not establish V3 profitability. The screenshot contains account figures and is not published in this public repository.

**Full trace: Not Verifiable.** No Chrome DevTools MCP/Lighthouse tool is connected; the browser advertises no performance-trace capability and its constrained page evaluation does not expose the Performance API. The existing `scripts/perf-trace/README.md` gate requires three desktop and throttled-phone traces with LCP/CLS and before/after evidence. Those traces were not obtained. No score or performance pass is invented from the readiness observations.

## Verification ledger

- Focused corrected money path: 51 passed, zero failed.
- Focused session concurrency/roster path: 58 passed, zero failed.
- Focused selection/capability path: eight passed, zero failed.
- Isolated scanner latency suite: an initial run passed 30/30 in 31.442 seconds. After the full run and other local checks finished, the final-source rerun `node --test --test-concurrency=2 agent/routes/tick-readiness-routes.test.js` passed 30/30 in 34.880 seconds, including the unchanged under-100-ms health check.
- Changed-file ESLint and whitespace checks passed.
- An earlier whole backend run was interrupted without a final summary and is not counted as a pass. The completed next run of `node scripts/run-agent-tests.mjs` exited 1: latency 29 passed/one failed, hygiene six passed, main group 7,124 passed/three skipped/zero failed, private TMPDIR empty. The failure was a health request at 109 ms against the unchanged under-100-ms requirement. The successful isolated rerun does not erase that failed command; its cause was not proved. No assertion, threshold or timeout was relaxed.
- Current code commit `281318de9b9f8e9ec2b88e3f6e0c05fc8e7c67bb`: [application CI](https://github.com/ang-kl/bot-trade/actions/runs/36322040188/job/108627616072) passed the full backend gate, frontend tests, lint, build, colour and syntax gates. [Scanner CI](https://github.com/ang-kl/bot-trade/actions/runs/36322040180/job/108627616281) passed. [Gateway CI](https://github.com/ang-kl/bot-trade/actions/runs/36322040170/job/108627616341) passed, including C++ unit tests and production compilation, ThreadSanitizer and Node delegation. All three code workflows were confirmed successful at 21:36 SGT.
- The current GitHub review job was inspected: its reviewer action was skipped. It supplies no code-review evidence. Later documentation-only checkpoints do not change the tested application/native source; any newly triggered CI status must still be read separately rather than assumed.

## INVARIANTS REPORT

| Invariant | Result | Evidence and limit |
|---|---|---|
| Partial/uncertain resting exposure retains cap and margin reserve | Passed in tested source | Reproduced partial-fill/missing-snapshot case and final focused regression suite; production branch is undeployed. |
| Full fill releases its slot only after account-owned monitored exposure replaces it, or full closure | Passed in tested source | Missing/inactive/foreign/null-account monitor regressions and immutable-volume identity checks. |
| Equivalent failed connects coalesce; explicit forced recovery survives | Passed in tested source | Session concurrency regressions and 58-test focused run. |
| Application, scanner and execution regression gates on the reviewed code commit | Passed in CI | All three workflows on `281318d`; local full-command latency failure and successful separate rerun are both retained above. |
| Selection preserves the intended seven-account dispatch and unrelated phase policy | Passed in tested source | Real Express route, SQLite fixture and downstream `getAutopilotAccounts` assertions for forward/rollback selection. |
| No production policy or trading mutation in this review | Passed for performed actions | Read-only runtime requests/SQLite; only draft-branch source changes. |
| Actual tick feed accounts match registered profiles | Failed in observed production state | Recovered feeds 9908/3489 versus registered tick profiles 0058/9009. |
| Full-volume and final-partial-fill TP1 lifecycle accepted in production | Not Verifiable | No deployment/fill trial; final partial remainder cancellation remains unsupported conservatively. |
| Full DevTools desktop/phone performance gate | Not Verifiable | Capability unavailable; six warm DOM timings and screenshot are supplemental evidence only. |
| Target win rate and profit factor 1.71 established for V3 | Not Verifiable | No qualifying V3 production cohort or realised-outcome trial measured here. |

The continuation is reviewable but is not a claim that V3 or Sydney production readiness is complete. Merge/deployment, scanner identity correction and the missing acceptance evidence remain distinct gates.
