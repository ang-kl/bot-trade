# Railway log review — 21 September 2026

Owner supplied four JSON exports, named by service. The agent export covers
13:56–14:18 UTC; the executor exports cover startup at approximately 13:36
through configuration at 13:41 UTC. These are different observation windows.

| Service | Evidence in the supplied export |
| --- | --- |
| bot-trade | 22 repeated protection errors: zero naked, three targetless, zero stop disagreements across seven accounts. TP applications are refused for BTCUSD on …0058, ETHUSD on …9908, XRPUSD on …0949. |
| cpp-exec | Four demo accounts authenticated. Recording and shadow switched ON. 59 symbols subscribed. Agent later recorded 153,158 events, zero dropped and one gap, plus demo shadow closes. |
| cpp-acct | Three live accounts authenticated, but `TICK_SPOOL_PATH` unset. The shadow-simulation configuration log is unconditional and does not prove a worker is running. |
| cpp-verify | Journal preparation succeeded and journal reported writable. The success line was sent to stderr, producing Railway's misleading error severity. No completed verification job appears in this short export. |

The agent completed 21 logged loops: median 33.260 seconds, maximum 85.943
seconds. The fast monitor logged 41 overlap skips. Its scheduler defaults to
three seconds with per-position cadences; the independent protection band
defaults to 60 seconds. These logs do not establish every-second decisions or
every-second trailing. Neither executor export contains the trail-engine
startup line.

Controllers read-back around 14:27 UTC agreed: demo recording/shadow ON, live
OFF, all seven accounts TIME_BASED, three demo TPs missing, and three local
records on funded live …3489 unmatched to broker truth. Forty-one demo
positions were checked. The live records must not be counted as verified.

## Corrections

- The main loop reconciled positions only on the selected broker side. Its
  opposite-side sweep read equity alone. Add account-scoped reconciliation
  using a fresh WS response carrying the requested account identity, a
  five-second timeout and no retry. Malformed, failed, wrong-account or
  unnamed-symbol snapshots cause no ledger changes. The broker is read only;
  reconciliation changes local records, not broker positions or entry mode.
- Relinking, close detection and duplicate/P&L cleanup had queries keyed only
  by position id. Scope them to the account being reconciled before extending
  coverage. Preserve the selected account's existing legacy-NULL convention.
- Review found that the two-pass SL/TP convergence watch read globally while
  other-account callers wrote it under account keys. Read and write the same
  explicit per-account key; never inherit an ownerless legacy observation.
- Log the applier's failure reason, attempted TP and retryable status once per
  permitted attempt. Existing retry windows and protection decisions stay in
  force. The former `apply refused` count could not diagnose these failures.
- Send successful verifier journal preparation to stdout; warnings retain
  stderr.

## Deployment read-back — 15:07 UTC / 23:07 SGT

PR #991 was merged as `394fa783318186b3032c31e941d23cfa968b91e7` and all four
services deployed successfully. The full gate passed: 5,165 backend tests,
one skipped, 896 frontend tests under UTC, ESLint, build and colour gate.
The automated review's convergence-watch finding was corrected and resolved.

The new diagnostics confirmed all three proposed targets were already below
the market. These are broker refusals, not evidence of a connection failure:

| Account | Symbol / position | Attempted TP | Bid in broker rejection |
| --- | --- | ---: | ---: |
| 46130058 | BTCUSD / 240088269 | 83128.65 | 86030.05 |
| 46979908 | ETHUSD / 242004561 | 2623.64 | 2746.87 |
| 47790949 | XRPUSD / 242243017 | 1.4587 | 1.5038 |

All three returned `TRADING_BAD_STOPS`. The applier still labels the thrown
broker errors retryable. Repeatedly submitting these prices cannot restore
the targets while the market remains above them. A replacement target or a
profit-taking close is an exit-policy decision; neither was invented here.

At 14:57:15 UTC the fresh cross-side reconciliation marked three stale local
rows closed and adopted the funded live account's actual ES.US position
586195695. At 14:57:54 the protection worker reported setting TP 81.02.
Subsequent audits, including after the live sidecar restart, verified that
position's SL and TP. All seven accounts were covered: 41 demo positions and
one funded live position; the other two live accounts had no positions.
Three demo positions remained targetless, with zero missing stops and zero
stop disagreements reported. Reconciliation changed ledger records; it did
not close those three positions at the broker.

## Option 2 activation

Under the owner's continuation instruction including live tick activation,
set `TICK_SPOOL_PATH=/data/tick` on cpp-acct at 15:00:54 UTC, after the fresh
live protection audit and zero in-flight/unknown intent check. The previous
variable was absent. Deployment `bf6a03db-1a21-48bd-a8ea-eee4ea97b2b9` succeeded
on the same commit. No storage was provisioned. The existing rollout permits
shadow observation on the container filesystem; retention across restarts
is not established.

The live service authenticated 3/3 accounts, enabled recording and shadow,
and subscribed 54 symbols. Controllers then showed both services RECORDING,
shadow ON, zero tick entry accounts and all seven accounts TIME_BASED with
zero reserved/in-flight/unknown intents. Every account was shadow-ready;
tick entries remained blocked by profile and validation evidence.

At the final read-back, the live feed timestamp was 15:06:53 UTC and the
demo timestamp was 15:06:58 UTC. The agent collected one completed live
shadow trade at 15:06:58 UTC, proving the observation pipeline had processed
quotes through a simulated close. This is no profitability verdict.

Tick-level trailing still reads "Not reported / disabled" on both services.
The time-based main loop took 252.6 seconds on its first post-deploy pass,
then 68.5, 61.3 and 58.6 seconds. Startup included an 85-second event-loop
stall; later lag recovered. The logs do not prove every-second strategy or
management execution. The all-account broker panel also fell back to the
selected account while retaining an all-account label; its missing-position
warning must not override the account-scoped protection audits.

Validation thresholds, automatic entry selection and account entry modes
were unchanged. Remaining work: the three passed-target exit decisions,
broker-refusal classification, loop stalls/overlap, accurate all-account
broker-panel fallback, and persistent live replay retention if required.
