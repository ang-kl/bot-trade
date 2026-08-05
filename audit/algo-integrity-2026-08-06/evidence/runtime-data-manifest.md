> Frozen SHA `0e6465158337c40d70952334b685551c7afdd289` · generated 2026-08-05 UTC · READ-ONLY, no live action.
> Narrative and verdicts live in [`instr/Result_Bot-Trade_Algorithmic_Decision_Integrity_Audit_2026-08-06.md`]( ../../instr/Result_Bot-Trade_Algorithmic_Decision_Integrity_Audit_2026-08-06.md ). This tree is the evidence pack.

# Runtime data manifest

**No runtime data was available to this audit.**

| Source | Status | Why |
|---|---|---|
| Agent SQLite DB | **absent** | not present in this environment |
| cTrader broker session | **unreachable** | `exec-parity.js` exit 1: `cTrader creds not configured in the agent DB` |
| C++ sidecar `/health` | **not probed** | no `EXEC_URL` reachable from this environment |
| Production logs | **absent** | — |
| Broker statements | **absent** | 5 statements to 04-08-2026 exist but were not supplied (task #187) |

One runtime observation is carried in from earlier the same day and is labelled as
such wherever used: `/state/account-phases` at **2026-08-05 12:26 UTC** reported
`connectivity: disconnected` for 43097342, 46130058, 46979908 and 47790949, and
`active` only for 42993489. That is a different vantage point from this frozen
checkout and is flagged in F-CONN-01 rather than folded into the static evidence.

Every section depending on the absent sources is marked
**NOT EXECUTED — DATA UNAVAILABLE**. None is marked passed.
