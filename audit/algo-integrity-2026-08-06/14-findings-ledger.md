> Frozen SHA `0e6465158337c40d70952334b685551c7afdd289` · generated 2026-08-05 UTC · READ-ONLY, no live action.
> Narrative and verdicts live in [`instr/Result_Bot-Trade_Algorithmic_Decision_Integrity_Audit_2026-08-06.md`]( ../../instr/Result_Bot-Trade_Algorithmic_Decision_Integrity_Audit_2026-08-06.md ). This tree is the evidence pack.

# 14 — Findings ledger

Machine mirror: `machine/finding-register.csv`. Full finding contracts (§19 structure)
are in the Result document §3.

| ID | Title | Class | Severity | Confidence | Status |
|---|---|---|---|---|---|
| `F-RISK-01` | sameSideAccountIds selects the WRONG side on every call | defect | critical | high | proved |
| `F-CONN-01` | Enabled accounts cannot self-heal onto the sidecar authorised roster | defect | capital | high | proved |
| `F-OBS-01` | Load-bearing exec-engine citations in heartbeat.js pointed at unrelated lines | observability gap | low | high | proved |

**Three findings. That number is low because most of the audit was blocked, not
because the system was found clean** — §21 forbids reading an unexecuted test as a
pass, and this ledger obeys that.

## Non-findings — suspicions tested and rejected

| ID | Claim | Disposition |
|---|---|---|
| N01 | H02 silent strategy death | **disproved** — 0/12 null placeholders; all 12 have repo positive controls |
| N02 | `/state/strategy-liveness` ignores `accountId` | **FALSE** — it passes `accountId: viewed.accountId`. Earlier claim withdrawn |
| N03 | `/state/veto-breakdown` ignores `days` | **FALSE** — forwarded and clamped 1..90. Earlier claim withdrawn |
| N04 | H01 strategy-list drift | **disproved** — registry matches the reference snapshot exactly |
| N05 | H08 unenforced write authority | **disproved** — `acting-layer.js` arbitrates with real mechanism |

N02 and N03 are corrections to claims made earlier in this session. Recorded as
corrections rather than quietly dropped, because §1 makes the current source
authoritative over prior context and requires the disagreement be written down.
