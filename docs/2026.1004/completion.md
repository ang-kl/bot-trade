# Approved cloud continuation — 4 October 2026

Verified through **19:30 SGT**. Both approved PRs are merged and the final Node deployment is running. All six Railway services are online. The existing six-hour pre-open scan is active.

**Sydney/Tokyo/Hong Kong order readiness remains blocked by missing authenticated app reads.** Official exchange cash timings are verified in [market-prep.md](market-prep.md); no per-account assessment or new queue entry is claimed. The [outstanding register](outstanding-register.md) preserves every retrievable group and its exact dependency.

| Release | Checked head | Merge / production outcome |
|---|---|---|
| #1228 | 4ea69e1071a8801b108aec858fc9605aac67c6c2 | 910308785fcce4f8f295751e58686b645903cc7f; first Node release succeeded |
| #1229 | 619bd504a022166a09b40a36af2f7d22dcc166be | cc9dab8d8819c1588f5ab49be7fea0b1fa87587b; Node deployment 7496c891-ab80-4011-b12b-2feec9764158 SUCCESS at 19:04 SGT |

#1229’s approved original head was 7c4465e794bae91d40ab1307a20b4a59983f4164. After #1228 was squash-merged, a genuine fast-forward merge integration preserved both parent histories and the **same approved source tree** 07fba3f534139f61b1cc31bc6f929d10712ce988. Final integration head, CI checkout and merged source match that tree. No force push, synthetic local Git history or additional application change was made.

[Final CI 37196547112](https://github.com/ang-kl/bot-trade/actions/runs/37196547112), attempt 1: **7,489 backend passes, zero failures, four existing native skips; 1,317 frontend passes across 138 files.** Lint, build, colour and entry-point syntax gates passed. Both new real SQLite regressions passed. The optional review action was skipped; independent review is absent.

Production receipts:
- Public health returns HTTP 200 with commit cc9dab8; Railway metadata identifies the full final commit.
- Complete new-process loops #1–#4 were observed after release; the later window contains completed loops #22–#26.
- Latest seven-account protection checked at 19:29:44–45 SGT: 11 open positions, zero missing SL and zero missing TP1.
- Current sample retains 17 close-completeness gaps and 19 written-off unknowns. Their membership overlap is unknown. They remain unknown, never zero.
- The old release’s transient CRASHED state occurred during replacement shutdown and ended REMOVED. The new release is SUCCESS/online.
- Node first-loop duration was about 87 seconds; later measured loops vary. Runtime health is not full P1/P4 load or UI acceptance.
- Native sidecars were not redeployed. The execution feed logged “nothing the feed reads has changed; no resubscribe, no recorder gap.” Tick comparisons still log slow HTTP 200 responses dominated by writing; they are not failed trade receipts.

Read-only history investigation found two text exports. The bounded priority-account field projections contain three closes on 2 October, all **before** the 4 October 07:35 SGT target boundary. Their reported signed costs reconcile to net and hold durations reconcile to timestamps. MAE/MFE and native currency are absent from the JSONL projection; requested sources_json was not returned. Two historical long planned-stop values are incompatible with the exported entry-price units. No correction or outcome inference is made. These are Railway-agent-reported projections without complete upstream bytes/checksum, not a certified lifecycle population.

The secure-access question remains unanswered. Current cloud spec 13 has no secret bindings; the unauthenticated private-account read returned 401. HTTPS succeeds with authorised network permission while retaining the configured proxy. [collect-readiness.py](collect-readiness.py) is prepared and syntax-checked; authenticated collection has not run. It makes GET requests only, rejects redirects, bounds replies and records missing/error/cut states. Configure AGENT_SECRET_READ securely without posting its value in chat.

| Material invariant | Status / evidence |
|---|---|
| Scoped owner approval, order and exact-source release | Passed: #1228 then #1229; final tree/head/CI/merge/serving receipts |
| Proven correction and required gates | Passed: original cache failure, fixed reproduction, host/account/missing-bars cases and full final CI |
| Momentum-book exclusion, managed fence, 3×ATR22 and ratchet authority | Passed for code/regression scope; live per-position broker agreement Not Verifiable |
| Fresh mandatory protection | Passed for the seven-account 11-position sampled read |
| Manual broker actions, risk/funding/activation/registry/history-repair operations | Passed: none sent by the assistant; existing bot automation continues |
| Original statement identity | Failed for four current files; one matches. Original baseline not recertified |
| Signed net / holding time | Passed for three reported projections; complete native-currency lifecycle certification Not Verifiable |
| Initial-risk consistency | Failed for two reported historical projections; actual source/unit lineage Not Verifiable |
| Final closed MAE/MFE and performance improvement | Not Verifiable; no WR/PF achievement or Chandelier benefit claim |
| Asian per-account assessment/queue readiness | Not Verifiable: authenticated identities/calendars/quotes/settings unavailable |
| Time-dependent/natural-event and full V3 acceptance | Not Verifiable; exact groups remain in outstanding register |
| October 1 originating unpublished-work preservation | Not Verifiable; accessible workspace preserved and no destructive Git operation performed |
| Actual runtime model/effort/usage and unseen task corpus | Not Verifiable; no metadata invented |

The published checkpoint bytes remain in candidate/docs and match the approved manifest. report.md retains dated checkpoints and appends this execution receipt. Current facts live in this document and the JSON receipts, avoiding a docs-only production/CI change.

No new unattended monitor or external schedule was created. Existing bot scanning/management continues under current gates. Broker calendar/funding/FX refusals, owner policy choices and natural market events are still material dependencies.

Railway’s broader read-only investigation used the [Railway skill](skill://plugin_asdk_app_6a502589384081919c5decf93496c9d1/use-railway/SKILL.md). The agent’s broad claims were narrowed against direct source/platform/HTTP evidence; managed-trail events and guardian names are not Chandelier or account-ID certification.

Additional final refresh at **19:52 SGT**: deployment remains SUCCESS, completed loop #47 is observed, and seven-account protection checked at 19:51:19–20 SGT still covers 11 positions with zero missing SL/TP1. Cloud spec 13 still has no read-secret binding. See [final-runtime-refresh.json](final-runtime-refresh.json).

Rollback reference, not an executed operation: the prior Node release is 910308785fcce4f8f295751e58686b645903cc7f / e0281d88-9ff2-4020-8863-a429d6de2a25. Original baseline is 1afda08fce6befd23d683fc1245e25c91e7d59d0 / 087b0a2d-e408-4fb5-9591-58003c6084e4. A source rollback cannot undo broker actions or stamped stops; no rollback was needed or performed.
