> Frozen SHA `0e6465158337c40d70952334b685551c7afdd289` · generated 2026-08-05 UTC · READ-ONLY, no live action.
> Narrative and verdicts live in [`instr/Result_Bot-Trade_Algorithmic_Decision_Integrity_Audit_2026-08-06.md`]( ../../instr/Result_Bot-Trade_Algorithmic_Decision_Integrity_Audit_2026-08-06.md ). This tree is the evidence pack.

# 01 — Baseline and evidence

Node v22.22.2 · npm 10.9.7 · g++ present. 853 tracked files · 542 JS/MJS · 277 test
files · 47 C++ sources · 150 service modules.

Run in a clean `git worktree` at the frozen SHA, isolated from the working tree.

| Command | Exit | Duration |
|---|---|---|
| `npm test` | 0 | 9s |
| `shopt -s globstar; node --test agent/**/*.test.js` | 0 | 37s (2,815 tests) |
| `npm run lint` | 0 | 35s |
| `npm run build` | 0 | 1s |
| `npm run check:no-green` | 0 | 1s |
| `make -C cpp-exec clean` | 0 | 0s |
| `make -C cpp-exec CXX=g++ test` | 0 | 306s |
| `make -C cpp-exec CXX=g++` | 0 | 20s |
| `node agent/scripts/backtest-parity.mjs` | 0 | 1s |
| `node agent/scripts/exec-parity.js` | **1** | 0s — **BLOCKED** |

`exec-parity` failed with `cTrader creds not configured in the agent DB`. **Preserved,
not repaired.** It is the one command that would have proved a real broker session,
and it is the boundary of this audit.

`node agent/scripts/exec-parity.js --order` was **never invoked**, under any account
mode. No order was placed, amended, cancelled or closed.

**Deviation:** `npm ci` was not re-run; `node_modules` was linked from the working
tree after confirming the lockfile head is byte-identical.

Raw log with full stdout/stderr tails: `evidence/commands.log`.
