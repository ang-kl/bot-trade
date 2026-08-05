> Frozen SHA `0e6465158337c40d70952334b685551c7afdd289` · generated 2026-08-05 UTC · READ-ONLY, no live action.
> Narrative and verdicts live in [`instr/Result_Bot-Trade_Algorithmic_Decision_Integrity_Audit_2026-08-06.md`]( ../../instr/Result_Bot-Trade_Algorithmic_Decision_Integrity_Audit_2026-08-06.md ). This tree is the evidence pack.

# 15 — Remediation roadmap

Sequenced per §20. No unrelated trading-behaviour changes are bundled.

## P0 — make evidence trustworthy

Nothing to repair. The evidence that exists is trustworthy; the problem is that most
is unreachable. The P0 action is **access**, not repair — see P1.2.

## P1 — prevent unintended capital risk

**P1.1 — Fix F-RISK-01.** `agent/lib/ctrader-creds.js`: return
`isLive: host === 'live.ctraderapi.com'`.
- *Behavioural contract:* `sameSideAccountIds` selects the side the credentials
  actually belong to. No change for a single-account registry.
- *Test:* build creds through the real `getCtraderCreds` against a two-sided fake
  registry; assert only same-side ids come back. Fails before, passes after.
- *Migration:* none. *Observability:* none needed. *Rollout:* offline test only.
- *Acceptance:* live creds never select a demo account.
- *Rollback:* revert one line.
- *Owner decision:* **none — correctness fix.**

**P1.2 — Rotate `AGENT_SECRET` and `AGENT_SECRET_READ`.** Both appeared in a
scratchpad file during this session. Owner action, no code change.

## P2 — restore correct signal and opportunity flow

**P2.1 — Finish the two-sidecar split (F-CONN-01).** Phase 0 (authorisation alert) and
Phase 1 (routing seam) shipped. Remaining:
- *Phase 2:* side-aware roster, reconcile sweep, `rosterDrift`, `cpp_exec_demo`
  heartbeat, scheduled token re-push. Correctness work.
- *Phase 3:* second Railway service + C++ host pin.
  **OWNER POLICY DECISION — NOT A CORRECTNESS FIX** (new service, new env vars).
- *Acceptance:* `/state/account-phases` flips all four demo accounts to `active`, the
  `account_probe` veto stops appearing, trades resume.
- *Rollback:* unset `EXEC_URL_DEMO` — everything falls back to the single-sidecar path
  running today.

## P3 — remove proven control overlap or winner truncation

**Deferred, and deliberately so.** The 1.7% approval rate is the loudest signal in the
system, and this audit could not evaluate it. Tuning vetoes before P2 restores demo
trading would mean tuning against a sample of zero — which is worse than not tuning.

Prerequisite: the §10 funnel and §10.2 counterfactual replay, which need the DB.

## P4 — awareness and operator explanation

Prerequisite: P2. The §15 study needs a decision sample that does not currently exist
on the demo side.

## P5 — optimisation

Not reached. Correctness first, per §20.
