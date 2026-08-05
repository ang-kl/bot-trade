> Frozen SHA `0e6465158337c40d70952334b685551c7afdd289` · generated 2026-08-05 UTC · READ-ONLY, no live action.
> Narrative and verdicts live in [`instr/Result_Bot-Trade_Algorithmic_Decision_Integrity_Audit_2026-08-06.md`]( ../../instr/Result_Bot-Trade_Algorithmic_Decision_Integrity_Audit_2026-08-06.md ). This tree is the evidence pack.

# 02 — Executable system map

Stage inventory in machine-readable form: `machine/decision-stages.json`.

```mermaid
flowchart TD
  A[broker/account eligibility] --> B[symbol + market-hours eligibility]
  B --> C[tick / trendbar acquisition]
  C --> D[data validation + bar closure]
  D --> E[strategy computation<br/>12 registry entries]
  E --> F[candidate collection]
  F --> G[per-strategy / per-symbol selection]
  G --> H[analyse-slot allocation]
  H --> I[stage-matrix + arming gates]
  I --> J[regime / awareness / volatility context]
  J --> K[deterministic risk evaluation + sizing]
  K --> L[opportunity identity + decision persistence]
  L --> M[order intent]
  M --> N{EXEC_ENGINE}
  N -->|cpp| O[C++ sidecar]
  N -->|js| P[ctrader-ws]
  O --> Q[broker acknowledgement]
  P --> Q
  Q --> R[order / fill persistence]
  R --> S[position protection verification]
  S --> T[tick / bar / poll management]
  T --> U[amend or close acknowledgement]
  U --> V[reconciliation]
  V --> W[deal / P&L backfill]
  W --> X[realised performance + strategy governance]
  A -. CONNECTIVITY GATE loop.js:1173<br/>skips the account entirely .-> Z[account_probe skip]
```

**The gate at `loop.js:1173` is the one that fired 965 times in 24h and produced zero
trades** — see F-CONN-01. It sits before every stage below it, which is why a
roster problem presents as "no setup".

Unit discipline the graph enforces:
`signal` ≠ `evaluation` ≠ `opportunity` ≠ `approval` ≠ `order intent` ≠ `broker order`
≠ `fill` ≠ `position` ≠ `closed trade`.

**BLOCKED — NOT EXECUTED:** the market-order and pending-order lifecycle sequence
diagrams are drawn from source in `11-pending-order-lifecycle.md`, but their
*observed* traces need runtime rows and are not included.
