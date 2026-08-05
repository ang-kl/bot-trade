> Frozen SHA `0e6465158337c40d70952334b685551c7afdd289` · generated 2026-08-05 UTC · READ-ONLY, no live action.
> Narrative and verdicts live in [`instr/Result_Bot-Trade_Algorithmic_Decision_Integrity_Audit_2026-08-06.md`]( ../../instr/Result_Bot-Trade_Algorithmic_Decision_Integrity_Audit_2026-08-06.md ). This tree is the evidence pack.

# 00 — Executive verdict

| Axis | Verdict |
|---|---|
| Economic character | **BOUNDED SPECULATION** (equity CFDs: UNCLASSIFIED — INSUFFICIENT EVIDENCE) |
| Defence posture | **MIXED** |
| Edge status | **EDGE UNPROVEN** — all 12 strategies and the portfolio |

**This audit is PARTIAL.** Static, structural and offline evidence was executed in
full. Everything requiring the production database or a broker session — most of
prompt §9–§15 — is **BLOCKED**: no agent DB is present and the session holds a
read-tier credential by design. 7 of 18 hypotheses are `blocked`, each naming its
missing evidence.

The system is structurally sound at HEAD and all twelve strategies are alive rather
than silently dead. There is **one confirmed cross-account contamination defect on a
money path** (F-RISK-01), reachable today, fixable in one line.

`EDGE UNPROVEN` is not `EDGE NEGATIVE`. It means the measurement was not reachable.
